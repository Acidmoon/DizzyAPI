// gatewayd 是 Go 数据面的组合根（AGENTS.md D4）。
//
// 它装配三块东西：
//   - 控制桥（TS ↔ Go，只承载控制消息，D3）；
//   - LLM 请求链路（engine + key-auth + account-priority + transport，§2.4）；
//   - HTTP 入口（POST /v1/chat/completions、GET /healthz）。
//
// 进程生命周期仍由 packages/account-priority 监管；本文件不新增任何监管逻辑。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accountruntime"
	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/apikeys"
	"github.com/Acidmoon/DizzyAPI/internal/bridge"
	contentauditcache "github.com/Acidmoon/DizzyAPI/internal/contentaudit"
	"github.com/Acidmoon/DizzyAPI/internal/engine"
	"github.com/Acidmoon/DizzyAPI/internal/httpapi"
	"github.com/Acidmoon/DizzyAPI/internal/keyspend"
	"github.com/Acidmoon/DizzyAPI/internal/limits"
	"github.com/Acidmoon/DizzyAPI/internal/metrics"
	pricingcache "github.com/Acidmoon/DizzyAPI/internal/pricing"
	"github.com/Acidmoon/DizzyAPI/internal/quota"
	"github.com/Acidmoon/DizzyAPI/internal/usagelog"
	"github.com/Acidmoon/DizzyAPI/internal/usageprobe"
	"github.com/Acidmoon/DizzyAPI/modules/accountpriority"
	"github.com/Acidmoon/DizzyAPI/modules/contentaudit"
	"github.com/Acidmoon/DizzyAPI/modules/keyauth"
	"github.com/Acidmoon/DizzyAPI/modules/keygate"
	"github.com/Acidmoon/DizzyAPI/modules/modelroute"
	"github.com/Acidmoon/DizzyAPI/modules/pricinggate"
	"github.com/Acidmoon/DizzyAPI/modules/protoconv"
	"github.com/Acidmoon/DizzyAPI/modules/quotagate"
	"github.com/Acidmoon/DizzyAPI/modules/transport"
)

type handler struct {
	service  *accountpriority.Service
	accounts *accounts.Cache
	keys     *apikeys.Cache
	usage    *usagelog.Ring
	runtime  *accountruntime.Tracker
	quota    *quota.Cache
	// gate 是额度闸门阶段：只用来读它的计数与「连续不可用」观察（quota.status 的 gate 字段）。
	gate *quotagate.Stage
	// contentAudit / contentAuditGate 是内容审核的规则缓存与闸门（只读观察，桥命令用）。
	contentAudit     *contentauditcache.Cache
	contentAuditGate *contentaudit.Stage
	// keyGate / keyLimits 是 key 级执行面闸门与它的并发预留（只读观察，桥命令用）。
	keyGate   *keygate.Stage
	keyLimits *limits.Tracker
	// spend 是每个 key 的累计消费快照（TS 心跳式推送；key 级金额上限判定用）。
	spend *keyspend.Cache
	// pricingCache / pricingGate 是定价闸门的快照与阶段（默认关：没开时 pricingGate 为 nil）。
	pricingCache *pricingcache.Cache
	pricingGate  *pricinggate.Stage
	logger       *slog.Logger
	shutdown     chan struct{}
	stopOnce     sync.Once
}

// accountsStatus 是桥命令 accounts.status 的响应：accounts.State 原样保留，
// 只增一个**全站聚合**的 runtime 字段（active / cooling）。
//
// omitempty + 只增不改：旧 TS 读到未知字段不受影响；没有运行时（测试或未注入）
// 时字段直接不出现，响应与改动前逐字节一致。
type accountsStatus struct {
	accounts.State
	Runtime *accountruntime.Stats `json:"runtime,omitempty"`
}

func (h *handler) accountsStatus() accountsStatus {
	state := h.accounts.State()
	if h.runtime == nil {
		return accountsStatus{State: state}
	}
	stats := h.runtime.Summary()
	return accountsStatus{State: state, Runtime: &stats}
}

// contentAuditStatus 是桥命令 contentaudit.status 的响应：规则缓存健康度 + 闸门计数与命中统计。
//
// gate 是**只增不改**的字段（omitempty）：没有注入闸门阶段（测试 / 旧装配）时不出现，
// 响应与改动前逐字节一致。它不含任何被审文本。
func (h *handler) contentAuditStatus() contentauditcache.State {
	var state contentauditcache.State
	if h.contentAudit != nil {
		state = h.contentAudit.State()
	}
	if h.contentAuditGate == nil {
		return state
	}
	stats := h.contentAuditGate.Stats()
	state.Gate = &contentauditcache.GateState{
		Blocked:      stats.Blocked,
		Logged:       stats.Logged,
		AllowedStale: stats.AllowedStale,
		StrictFailed: stats.StrictFailed,
		ParseFailed:  stats.ParseFailed,
		NoText:       stats.NoText,
		Truncated:    stats.Truncated,
		StaleStreak:  stats.StaleStreak,
		StaleReason:  stats.StaleReason,
		StaleForMs:   stats.StaleForMs,
		RuleHitTotal: stats.RuleHitTotal,
		RuleHits:     stats.RuleHits,
	}
	return state
}

// quotaStatus 是桥命令 quota.status 的响应：余额缓存健康度 + 额度闸门的计数。
//
// gate 是**只增不改**的字段（omitempty）：没有注入闸门阶段（测试 / 旧装配）时不出现，
// 响应与改动前逐字节一致。它不含任何余额明细。
func (h *handler) quotaStatus() quota.State {
	var state quota.State
	if h.quota != nil {
		state = h.quota.State()
	}
	if h.gate == nil {
		return state
	}
	stats := h.gate.Stats()
	state.Gate = &quota.GateState{
		AllowedUnknown: stats.AllowedUnknown,
		BlockedLow:     stats.BlockedLow,
		StrictBlocked:  stats.StrictBlocked,
		StaleStreak:    stats.StaleStreak,
		StaleReason:    stats.StaleReason,
		StaleForMs:     stats.StaleForMs,
	}
	return state
}

// keysStatus 是桥命令 keys.status 的响应：key 快照健康度原样保留，
// 只增一个 gate 字段（key 级执行面闸门的计数）。
//
// gate 是**只增不改**的字段（omitempty）：没有注入闸门阶段（测试 / 旧装配）时不出现，
// 响应与改动前逐字节一致。它不含任何 key 级明细。
type keysStatus struct {
	apikeys.Status
	Gate *keyGateState `json:"gate,omitempty"`
}

// keyGateState 是 key 级执行面闸门的计数（不含 key id、余额或金额明细）。
type keyGateState struct {
	Expired                int `json:"expired,omitempty"`
	SpendingBlocked        int `json:"spendingBlocked,omitempty"`
	SpendingUnknown        int `json:"spendingUnknown,omitempty"`
	ConcurrencyBlocked     int `json:"concurrencyBlocked,omitempty"`
	UserConcurrencyBlocked int `json:"userConcurrencyBlocked,omitempty"`
	ActiveKeys             int `json:"activeKeys,omitempty"`
	ActiveUsers            int `json:"activeUsers,omitempty"`
}

func (h *handler) keysStatus() keysStatus {
	state := keysStatus{Status: h.keys.Status()}
	if h.keyGate == nil {
		return state
	}
	stats := h.keyGate.Stats()
	gate := keyGateState{
		Expired:                stats.Expired,
		SpendingBlocked:        stats.SpendingBlocked,
		SpendingUnknown:        stats.SpendingUnknown,
		ConcurrencyBlocked:     stats.ConcurrencyBlocked,
		UserConcurrencyBlocked: stats.UserConcurrencyBlocked,
	}
	if h.keyLimits != nil {
		summary := h.keyLimits.Summary()
		gate.ActiveKeys = summary.ActiveKeys
		gate.ActiveUsers = summary.ActiveUsers
	}
	state.Gate = &gate
	return state
}

// pricingStatus 是桥命令 pricing.status 的响应：价格快照健康度 + 定价闸门计数。
//
// gate 是只增字段（omitempty）：闸门关闭（没装阶段）时不出现。
func (h *handler) pricingStatus() pricingcache.State {
	var state pricingcache.State
	if h.pricingCache != nil {
		state = h.pricingCache.State()
	}
	if h.pricingGate == nil {
		return state
	}
	stats := h.pricingGate.Stats()
	state.Gate = &pricingcache.GateState{
		Blocked:       stats.Blocked,
		StrictBlocked: stats.StrictBlocked,
		Allowed:       stats.Allowed,
		StaleStreak:   stats.StaleStreak,
	}
	return state
}

func (h *handler) Handle(_ context.Context, method string, params json.RawMessage) (any, error) {
	switch method {
	case bridge.MethodStatus:
		return h.service.Status(), nil

	case bridge.MethodListStrategies:
		return h.service.Strategies(), nil

	case bridge.MethodReplaceStrategies:
		var config accountpriority.Config
		if err := decodeParams(params, &config); err != nil {
			return nil, bridge.Errorf("BRIDGE_BAD_REQUEST", "策略参数不合法：%v", err)
		}
		revision, err := h.service.Replace(config)
		if err != nil {
			return nil, mapModuleError(err)
		}
		applied := h.service.Strategies()
		h.logger.Info("策略已更新", "revision", revision, "strategies", len(applied.Strategies))
		return map[string]any{
			"revision":        revision,
			"strategies":      len(applied.Strategies),
			"defaultStrategy": applied.DefaultStrategy,
		}, nil

	case bridge.MethodPreview:
		var request accountpriority.ScoreRequest
		if err := decodeParams(params, &request); err != nil {
			return nil, bridge.Errorf("BRIDGE_BAD_REQUEST", "打分参数不合法：%v", err)
		}
		result, err := h.service.Score(request)
		if err != nil {
			return nil, mapModuleError(err)
		}
		return result, nil

	case bridge.MethodPick:
		var request accountpriority.ScoreRequest
		if err := decodeParams(params, &request); err != nil {
			return nil, bridge.Errorf("BRIDGE_BAD_REQUEST", "选择参数不合法：%v", err)
		}
		picked, err := h.service.Pick(request)
		if err != nil {
			return nil, mapModuleError(err)
		}
		return picked, nil

	case bridge.MethodReplaceAccounts:
		var snapshot accounts.Snapshot
		if err := decodeParams(params, &snapshot); err != nil {
			return nil, bridge.Errorf("BRIDGE_BAD_REQUEST", "账号快照参数不合法：%v", err)
		}
		result, err := h.accounts.Replace(snapshot)
		if err != nil {
			var typed *accounts.Error
			if errors.As(err, &typed) {
				return nil, bridge.Errorf(typed.Code, "%s", typed.Message)
			}
			return nil, bridge.Errorf("ACCOUNTS_INTERNAL", "账号快照更新失败")
		}
		// 只记计数与哈希；快照里的令牌永不进日志。
		h.logger.Info("账号快照已更新", "revision", result.Revision, "accounts", result.Accounts)
		return result, nil

	case bridge.MethodAccountsStatus:
		return h.accountsStatus(), nil

	case contracts.BridgeMethodQuotaReplace:
		if h.quota == nil {
			return nil, bridge.Errorf("QUOTA_UNAVAILABLE", "余额快照缓存未装配")
		}
		var snapshot quota.Snapshot
		if err := decodeParams(params, &snapshot); err != nil {
			return nil, bridge.Errorf("BRIDGE_BAD_REQUEST", "余额快照参数不合法：%v", err)
		}
		result, err := h.quota.Replace(snapshot)
		if err != nil {
			var typed *quota.Error
			if errors.As(err, &typed) {
				return nil, bridge.Errorf(typed.Code, "%s", typed.Message)
			}
			return nil, bridge.Errorf("QUOTA_INVALID_SNAPSHOT", "余额快照更新失败")
		}
		// 只记版本与计数：余额明细不进日志。
		h.logger.Info("余额快照已更新",
			"revision", result.Revision, "entries", result.Entries, "generation", result.Generation)
		return result, nil

	case contracts.BridgeMethodQuotaStatus:
		return h.quotaStatus(), nil

	case contracts.BridgeMethodContentAuditReplace:
		if h.contentAudit == nil {
			return nil, bridge.Errorf("CONTENT_AUDIT_UNAVAILABLE", "内容审核规则缓存未装配")
		}
		var snapshot contentauditcache.Snapshot
		if err := decodeParams(params, &snapshot); err != nil {
			return nil, bridge.Errorf("BRIDGE_BAD_REQUEST", "内容审核规则快照参数不合法：%v", err)
		}
		result, err := h.contentAudit.Replace(snapshot)
		if err != nil {
			var typed *contentauditcache.Error
			if errors.As(err, &typed) {
				return nil, bridge.Errorf(typed.Code, "%s", typed.Message)
			}
			return nil, bridge.Errorf("CONTENT_AUDIT_INVALID_SNAPSHOT", "内容审核规则快照更新失败")
		}
		// 只记版本与计数：规则内容不进日志（pattern 是运营数据，不是秘密，但没必要落日志）。
		h.logger.Info("内容审核规则快照已更新",
			"revision", result.Revision, "rules", result.Rules,
			"enabled", result.Enabled, "generation", result.Generation)
		return result, nil

	case contracts.BridgeMethodContentAuditStatus:
		return h.contentAuditStatus(), nil

	case contracts.BridgeMethodPricingReplace:
		if h.pricingCache == nil {
			return nil, bridge.Errorf("PRICING_UNAVAILABLE", "价格快照缓存未装配")
		}
		var snapshot pricingcache.Snapshot
		if err := decodeParams(params, &snapshot); err != nil {
			return nil, bridge.Errorf("BRIDGE_BAD_REQUEST", "价格快照参数不合法：%v", err)
		}
		result, err := h.pricingCache.Replace(snapshot)
		if err != nil {
			var typed *pricingcache.Error
			if errors.As(err, &typed) {
				return nil, bridge.Errorf(typed.Code, "%s", typed.Message)
			}
			return nil, bridge.Errorf("PRICING_INVALID_SNAPSHOT", "价格快照更新失败")
		}
		// 只记版本与计数：价格明细不进日志（它是运营数据，不是秘密，但没必要落）。
		h.logger.Info("价格快照已更新",
			"revision", result.Revision, "prices", result.Prices,
			"wildcard", result.Wildcard, "generation", result.Generation)
		return result, nil

	case contracts.BridgeMethodPricingStatus:
		return h.pricingStatus(), nil

	case contracts.BridgeMethodKeySpendReplace:
		if h.spend == nil {
			return nil, bridge.Errorf("KEYSPEND_UNAVAILABLE", "key 消费快照缓存未装配")
		}
		var snapshot keyspend.Snapshot
		if err := decodeParams(params, &snapshot); err != nil {
			return nil, bridge.Errorf("BRIDGE_BAD_REQUEST", "key 消费快照参数不合法：%v", err)
		}
		result, err := h.spend.Replace(snapshot)
		if err != nil {
			var typed *keyspend.Error
			if errors.As(err, &typed) {
				return nil, bridge.Errorf(typed.Code, "%s", typed.Message)
			}
			return nil, bridge.Errorf("KEYSPEND_INVALID_SNAPSHOT", "key 消费快照更新失败")
		}
		// 只记版本与计数：金额明细不进日志。
		h.logger.Info("key 消费快照已更新",
			"revision", result.Revision, "entries", result.Entries, "generation", result.Generation)
		return result, nil

	case contracts.BridgeMethodKeySpendStatus:
		if h.spend == nil {
			return keyspend.State{}, nil
		}
		return h.spend.State(), nil

	case bridge.MethodReplaceKeys:
		var snapshot apikeys.Snapshot
		if err := decodeParams(params, &snapshot); err != nil {
			return nil, bridge.Errorf("BRIDGE_BAD_REQUEST", "API key 快照参数不合法：%v", err)
		}
		result, err := h.keys.Replace(snapshot)
		if err != nil {
			var typed *apikeys.Error
			if errors.As(err, &typed) {
				return nil, bridge.Errorf(typed.Code, "%s", typed.Message)
			}
			return nil, bridge.Errorf("KEYS_INTERNAL", "API key 快照更新失败")
		}
		// 只记计数与 revision；快照里的哈希永不进日志，更不回显。
		h.logger.Info("API key 快照已更新", "revision", result.Revision, "keys", result.Keys)
		return result, nil

	case bridge.MethodKeysStatus:
		return h.keysStatus(), nil

	case contracts.BridgeMethodUsageSince:
		var query struct {
			Epoch    string `json:"epoch"`
			AfterSeq int64  `json:"afterSeq"`
			Limit    int    `json:"limit"`
		}
		if err := decodeParams(params, &query); err != nil {
			return nil, bridge.Errorf("BRIDGE_BAD_REQUEST", "用量拉取参数不合法：%v", err)
		}
		if h.usage == nil {
			return usagelog.SinceResult{}, nil
		}
		// limit 的硬边界在 Ring 内部 clamp；这里只给缺省值。
		const defaultUsageLimit = 500
		if query.Limit <= 0 {
			query.Limit = defaultUsageLimit
		}
		return h.usage.Since(query.Epoch, query.AfterSeq, query.Limit), nil

	case contracts.BridgeMethodUsageStats:
		// 只读快照，没有参数（不 decode，避免无意义的 DisallowUnknownFields 失败）。
		if h.usage == nil {
			return usagelog.StatsResult{}, nil
		}
		return h.usage.Stats(), nil

	case bridge.MethodShutdown:
		// 先让响应写完，再关闭进程。TS 不依赖这个 ack，但排障时能看到它。
		h.stopOnce.Do(func() {
			go func() {
				time.Sleep(100 * time.Millisecond)
				close(h.shutdown)
			}()
		})
		return map[string]bool{"ok": true}, nil

	default:
		return nil, bridge.Errorf("BRIDGE_METHOD_NOT_FOUND", "未知方法：%s", method)
	}
}

func mapModuleError(err error) error {
	var typed *accountpriority.Error
	if errors.As(err, &typed) {
		return bridge.Errorf(string(typed.Code), "%s", typed.Message)
	}
	return bridge.Errorf("ACCOUNT_PRIORITY_INTERNAL", "%v", err)
}

// newUsageRing 是容量配置的唯一装配点：非法值直接返回错误，让进程起不来，
// 而不是静默回落到默认容量（那样「配置写错」会看起来像「配置生效」）。
func newUsageRing(capacity int) (*usagelog.Ring, error) {
	ring, err := usagelog.NewRing(capacity)
	if err != nil {
		return nil, fmt.Errorf("用量环形缓冲容量配置（-usage-ring-capacity）非法：%w", err)
	}
	return ring, nil
}

// maxAccountCooldownMs 是账号冷却时间的上限（10 分钟）：再长就等于把账号判死刑，
// 那属于管理面停用，不是运行时冷却。
const maxAccountCooldownMs = 600_000

// parseAccountCooldown 校验账号冷却配置。0 = 关闭冷却；负数或超过上限明确失败。
func parseAccountCooldown(ms int) (time.Duration, error) {
	if ms == 0 {
		return 0, nil
	}
	if ms < 0 || ms > maxAccountCooldownMs {
		return 0, fmt.Errorf("账号冷却时间配置（-account-cooldown-ms）非法：必须在 0..%d ms 之间（0 = 关闭冷却），得到 %d",
			maxAccountCooldownMs, ms)
	}
	return time.Duration(ms) * time.Millisecond, nil
}

func decodeParams(raw json.RawMessage, target any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = []byte("{}")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("参数末尾有多余内容")
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "gatewayd: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	transportMode := flag.String("transport", "auto", "控制桥传输：auto / unix / tcp")
	socket := flag.String("socket", "", "unix socket 路径（unix 传输必填）")
	listen := flag.String("listen", "127.0.0.1:0", "控制桥 TCP 监听地址（只允许回环）")
	httpListen := flag.String("http-listen", "127.0.0.1:8080", "LLM 请求 HTTP 监听地址（只允许回环）")
	logFormat := flag.String("log-format", "text", "日志格式：text / json")
	strategy := flag.String("strategy", "", "LLM 请求使用的账号优先级策略组；空 = 默认策略")
	profile := flag.String("profile", keyauth.DefaultProfile, "key-auth 写入的 profile 标签")
	requestTimeout := flag.Int("request-timeout-ms", transport.DefaultRequestTimeoutMs, "非流式上游请求超时")
	headerTimeout := flag.Int("header-timeout-ms", transport.DefaultHeaderTimeoutMs, "等待上游响应头超时")
	maxBody := flag.Int64("max-body-bytes", httpapi.DefaultMaxBodyBytes, "LLM 请求体上限")
	defaultMaxTokens := flag.Int("anthropic-default-max-tokens", 4096,
		"跨协议转到 Anthropic 时，客户端没给 max_tokens 用的默认值")
	recordStreamUsage := flag.Bool("record-stream-usage", true,
		"为 openai-chat 流式请求注入 stream_options.include_usage，以采集 token 用量")
	trustedProxyHops := flag.Int("trusted-proxy-hops", 1,
		"X-Forwarded-For 从右往左第几跳是可信代理（默认 1）")
	usageRingCapacity := flag.Int("usage-ring-capacity", usagelog.DefaultCapacity,
		fmt.Sprintf("Go 侧用量环形缓冲容量（条）；超出 %d..%d 直接启动失败",
			usagelog.MinCapacity, usagelog.MaxCapacity))
	accountCooldownMs := flag.Int("account-cooldown-ms", 30_000,
		fmt.Sprintf("上游 429 / 额度耗尽后该账号的冷却时间（毫秒）；0 = 关闭冷却，超出 0..%d 直接启动失败",
			maxAccountCooldownMs))
	quotaMinBalance := flag.Int64("quota-min-balance-micros", 0,
		"额度闸门放行所需的最低余额（微元，含）；默认 0 = 余额 0 及以下都拒绝")
	quotaRequireSnapshot := flag.Bool("quota-require-snapshot", false,
		"严格模式：余额快照未就绪 / 过期 / 查不到用户时返回 503；默认放行并告警（后付费结算兜底）")
	quotaSnapshotTTLMs := flag.Int("quota-snapshot-ttl-ms", int(quota.DefaultTTL/time.Millisecond),
		fmt.Sprintf("余额快照有效期（毫秒），应 ≥ 3 × quota 插件的 pollIntervalMs；超出 %d..%d 直接启动失败",
			minQuotaSnapshotTTLMs, maxQuotaSnapshotTTLMs))
	metricsEnabled := flag.Bool("metrics", true,
		"在 LLM 入口的回环监听上暴露 GET /metrics（Prometheus 文本格式）；关闭时该路径 404")
	contentAuditRequireSnapshot := flag.Bool("content-audit-require-snapshot", false,
		"严格模式：内容审核规则快照未就绪 / 过期时返回 503；默认放行并告警（可用性优先）")
	contentAuditSnapshotTTLMs := flag.Int("content-audit-snapshot-ttl-ms", 15000,
		fmt.Sprintf("内容审核规则快照有效期（毫秒），应 ≥ 3 × TS 的 pushIntervalMs；超出 %d..%d 直接启动失败",
			minContentAuditSnapshotTTLMs, maxContentAuditSnapshotTTLMs))
	pricingGateEnabled := flag.Bool("pricing-gate", false,
		"定价闸门：模型没有配置价格时返回 403 MODEL_NOT_PRICED；默认关，上线确认价格快照正常后再打开")
	pricingSnapshotTTLMs := flag.Int("pricing-snapshot-ttl-ms", 15000,
		fmt.Sprintf("价格快照有效期（毫秒），应 ≥ 3 × TS 的 pushIntervalMs；超出 %d..%d 直接启动失败",
			minGateSnapshotTTLMs, maxGateSnapshotTTLMs))
	keySpendSnapshotTTLMs := flag.Int("keyspend-snapshot-ttl-ms", 15000,
		fmt.Sprintf("key 消费快照有效期（毫秒），应 ≥ 3 × TS 的 pushIntervalMs；超出 %d..%d 直接启动失败",
			minGateSnapshotTTLMs, maxGateSnapshotTTLMs))
	flag.Parse()

	logger := newLogger(*logFormat)

	network := *transportMode
	if network == "auto" {
		if runtime.GOOS == "windows" {
			network = "tcp"
		} else {
			network = "unix"
		}
	}
	address := *listen
	if network == "unix" {
		if *socket == "" {
			return errors.New("unix 传输必须提供 -socket")
		}
		address = *socket
	}
	if err := requireLoopback(*httpListen); err != nil {
		return fmt.Errorf("LLM 请求入口拒绝非回环监听：%w", err)
	}

	// 账号冷却配置非法时进程直接起不来，不静默回落默认值（AGENTS.md §2.4.5）。
	accountCooldown, err := parseAccountCooldown(*accountCooldownMs)
	if err != nil {
		return err
	}
	// 账号运行时状态：真实 in-flight 计数 + 429/额度耗尽的短期冷却。
	// 纯内存、不落盘、不回写 TS；engine 与 transport 各依赖自己声明的那一小块接口。
	accountRuntime := accountruntime.New(accountCooldown)

	// 额度闸门的余额快照：纯内存只读缓存，权威数据仍在 TS 的 user 插件里。
	quotaTTL, err := parseQuotaSnapshotTTL(*quotaSnapshotTTLMs)
	if err != nil {
		return err
	}
	quotaCache := quota.New(quota.WithTTL(quotaTTL))

	// 内容审核的规则快照：同样是纯内存只读缓存，规则权威数据在 TS 的 content-audit 插件里。
	contentAuditTTL, err := parseContentAuditSnapshotTTL(*contentAuditSnapshotTTLMs)
	if err != nil {
		return err
	}
	contentAuditCache := contentauditcache.New(contentauditcache.WithTTL(contentAuditTTL))

	// 价格快照（定价闸门用）：纯内存只读缓存，价格权威数据在 TS 的 pricing 插件里。
	// 闸门只判「有没有价」，算钱仍然只在 TS（一个数据一个写者）。
	pricingTTL, err := parseGateSnapshotTTL("-pricing-snapshot-ttl-ms", *pricingSnapshotTTLMs)
	if err != nil {
		return err
	}
	pricingCache := pricingcache.New(pricingcache.WithTTL(pricingTTL))

	// key 消费快照（金额上限判定用）：花钱的事实只有 TS 知道，Go 只读、只比大小。
	keySpendTTL, err := parseGateSnapshotTTL("-keyspend-snapshot-ttl-ms", *keySpendSnapshotTTLMs)
	if err != nil {
		return err
	}
	keySpendCache := keyspend.New(keyspend.WithTTL(keySpendTTL))
	// key 级与用户级并发共用同一套原子预留（AGENTS.md：别写两遍）。
	keyLimits := limits.New()

	// 组合根是唯一组装点：注册顺序就是阶段顺序 pre → dispatch → post。
	//
	// 装配顺序（也是阶段顺序）：
	//   keyauth → modelroute.RegisterRouter（pre，排在 accountpriority 前）
	//           → accountpriority（pre）
	//           → modelroute.RegisterMapper（dispatch，排在 protoconv 前）
	//           → protoconv（dispatch）→ transport（dispatch）
	//
	// 两个 modelroute 阶段分处 pre 与 dispatch，而 engine 强制相位不倒退，
	// 所以必须由这里按位置各注册一次，不能合成一个 Register。
	registry := contracts.NewRegistry()
	keyCache := apikeys.New()
	keyStage := keyauth.Register(registry, keyauth.Config{
		Keys:     parseAPIKeys(os.Getenv("DIZZYAPI_API_KEYS")),
		Profile:  *profile,
		Verifier: keyCache,
	})
	// key 级执行面（pre）：过期 / 金额上限 / key 并发 / 用户并发。
	// 位置必须紧跟 key-auth（要用它写进 ctx.Key 的上限），早于任何转发判断。
	keyGate, err := keygate.Register(registry, keygate.Config{}, keygate.Deps{
		Spends:       keySpendCache,
		UserLimits:   quotaCache,
		Reservations: keyLimits,
	}, logger)
	if err != nil {
		return fmt.Errorf("初始化 key-gate 阶段失败：%w", err)
	}
	// 定价闸门（pre）：默认关（owner 拍板），上线确认价格快照正常后再用 -pricing-gate 打开。
	// 没打开时**不注册阶段**：省掉热路径上的一次判空，也让「关」是真正零行为。
	var pricingGateStage *pricinggate.Stage
	if *pricingGateEnabled {
		stage, err := pricinggate.Register(registry, pricinggate.Config{SnapshotTTL: pricingTTL}, pricingCache, logger)
		if err != nil {
			return fmt.Errorf("初始化定价闸门阶段失败：%w", err)
		}
		pricingGateStage = stage
	}
	// 内容审核（pre）：按用户输入文本查规则快照，命中 block 规则直接 403。
	// 位置在 key-auth 之后、额度闸门之前：内容不合规就不该占用余额判断与选号。
	contentAuditGate, err := contentaudit.Register(registry, contentaudit.Config{
		RequireSnapshot: *contentAuditRequireSnapshot,
		SnapshotTTL:     contentAuditTTL,
	}, contentAuditCache, logger)
	if err != nil {
		return fmt.Errorf("初始化内容审核阶段失败：%w", err)
	}
	// 额度闸门（pre）：按请求的 userId 查余额只读快照，余额 ≤ 阈值直接 402，
	// 不花钱转发上游。位置必须早于打分与 dispatch，但晚于 key-auth（要 userId）。
	quotaGate, err := quotagate.Register(registry, quotagate.Config{
		MinBalanceMicros: *quotaMinBalance,
		RequireSnapshot:  *quotaRequireSnapshot,
		SnapshotTTL:      quotaTTL,
	}, quotaCache, logger)
	if err != nil {
		return fmt.Errorf("初始化额度闸门阶段失败：%w", err)
	}
	// 模型路由过滤（pre）：必须在 accountpriority 之前收窄候选。
	if _, err := modelroute.RegisterRouter(registry, modelroute.Config{}, logger); err != nil {
		return fmt.Errorf("初始化模型路由阶段失败：%w", err)
	}
	service, err := accountpriority.Register(registry, accountpriority.Config{})
	if err != nil {
		return fmt.Errorf("初始化账号优先级模块失败：%w", err)
	}
	accountCache := accounts.New()
	// 模型映射（dispatch）：在 accountpriority 之后（要读选中账号）、protoconv 之前
	// （protoconv 解析 IR 时优先用 Ctx.MappedBody）。
	if err := modelroute.RegisterMapper(registry, modelroute.Config{}, accountCache, logger); err != nil {
		return fmt.Errorf("初始化模型映射阶段失败：%w", err)
	}
	// 协议转换 codec 注册表：三个协议族各一个。缺哪个协议，跨协议请求就按
	// PROTOCOL_CODEC_UNAVAILABLE fail-closed（不静默降级）。
	codecs := contracts.NewCodecRegistry()
	for _, codec := range []contracts.Codec{
		protoconv.NewChatCodec(),
		protoconv.NewResponsesCodec(),
		protoconv.NewAnthropicCodec(protoconv.AnthropicConfig{DefaultMaxTokens: *defaultMaxTokens}),
		protoconv.NewGeminiCodec(),
	} {
		if err := codecs.Register(codec); err != nil {
			return fmt.Errorf("注册 %s codec 失败：%w", codec.Protocol(), err)
		}
	}
	// protoconv 阶段必须注册在 transport 之前（组合根按注册顺序决定阶段顺序）。
	converter, err := protoconv.Register(registry, protoconv.Config{}, codecs, accountCache, logger)
	if err != nil {
		return fmt.Errorf("初始化协议转换模块失败：%w", err)
	}
	if _, err := transport.Register(registry, transport.Config{
		RequestTimeoutMs: *requestTimeout,
		HeaderTimeoutMs:  *headerTimeout,
		// 429 / 额度耗尽由 transport 回报给运行时，后续请求打分时排除该账号。
		LimitRecorder: accountRuntime,
	}, accountCache, converter.Transcoder()); err != nil {
		return fmt.Errorf("初始化 transport 模块失败：%w", err)
	}
	// 注入账号运行时：pre 阶段前写入真实 in-flight/冷却，dispatch 前原子预留并发槽位。
	requestEngine, err := engine.New(registry.Stages(), logger, engine.WithAccountRuntime(accountRuntime))
	if err != nil {
		return fmt.Errorf("初始化 LLM 请求 engine 失败：%w", err)
	}
	// 用量环形缓冲：HTTP 入口写，控制桥的 usage.since / usage.stats 读。
	// 容量不合法时这里直接失败，不静默回落默认值（AGENTS.md §2.4.5）。
	usageRing, err := newUsageRing(*usageRingCapacity)
	if err != nil {
		return err
	}
	// 请求级指标：热路径只做原子加法，文本渲染在 scrape 时发生。
	// gauges 现算（运行时 / 用量缓冲 / 余额快照），全部是全站聚合值，
	// 不含账号 id / 用户 id / IP / 模型名（AGENTS.md §5.1）。
	metricsRegistry := metrics.New(metrics.Gauges{
		InflightActive:          func() int { return accountRuntime.Summary().Active },
		AccountsCooling:         func() int { return accountRuntime.Summary().Cooling },
		UsageRingDropped:        func() int64 { return usageRing.Stats().Dropped },
		UsageRingGap:            func() int64 { return usageRing.Stats().Gap },
		QuotaSnapshotAgeSeconds: func() float64 { return quotaCache.Age().Seconds() },
	})
	httpAPI, err := httpapi.New(requestEngine, accountCache, logger, httpapi.Config{
		MaxBodyBytes: *maxBody,
		Strategy:     *strategy,
		// /v1/models 复用 keyauth 的同一套鉴权判定。
		Authorizer:        keyStage,
		UsageSink:         usageRing,
		UsageProbe:        usageprobe.New(codecs),
		RecordStreamUsage: *recordStreamUsage,
		TrustedProxyHops:  *trustedProxyHops,
		Metrics:           metricsRegistry,
		MetricsEnabled:    *metricsEnabled,
	})
	if err != nil {
		return fmt.Errorf("初始化 HTTP 入口失败：%w", err)
	}

	httpListener, err := net.Listen("tcp", *httpListen)
	if err != nil {
		return fmt.Errorf("监听 LLM 请求入口 %s 失败：%w", *httpListen, err)
	}
	httpServer := &http.Server{
		Handler:           httpAPI.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if serveErr := httpServer.Serve(httpListener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			logger.Error("LLM 请求入口异常退出", "error", serveErr)
		}
	}()

	stop := make(chan struct{})
	control := &handler{
		service:  service,
		accounts: accountCache,
		keys:     keyCache,
		usage:    usageRing,
		// 运行时状态只给桥命令看汇总（active / cooling），不进公网 /healthz。
		runtime: accountRuntime,
		quota:   quotaCache,
		gate:    quotaGate,

		contentAudit:     contentAuditCache,
		contentAuditGate: contentAuditGate,

		keyGate:   keyGate,
		keyLimits: keyLimits,
		spend:     keySpendCache,

		pricingCache: pricingCache,
		pricingGate:  pricingGateStage,

		logger:   logger,
		shutdown: stop,
	}

	status := service.Status()
	accountState := accountCache.State()
	keyState := keyCache.Status()
	hello := map[string]any{
		"protocolVersion": bridge.ProtocolVersion,
		"pid":             os.Getpid(),
		"service":         accountpriority.ServiceName,
		"revision":        status.Revision,
		"defaultStrategy": status.DefaultStrategy,
		"strategies":      status.Strategies,
		"accounts":        accountState.Accounts,
		"keys":            keyState.Keys,
		"httpAddress":     httpListener.Addr().String(),
		// 让 TS 在首次连接时就能对齐用量游标（进程重启后 seq 从 1 重新开始）。
		"usageEpoch": usageRing.Epoch(),
		"usageSeq":   usageRing.LastSeq(),
	}

	server, err := bridge.NewServer(network, address, control, bridge.Options{
		Hello:  hello,
		Logger: logger,
	})
	if err != nil {
		_ = httpServer.Close()
		return err
	}
	logger.Info("gatewayd 已启动",
		"transport", network,
		"address", server.Address().String(),
		"httpAddress", httpListener.Addr().String(),
		"revision", status.Revision,
		"usageRingCapacity", usageRing.Stats().Capacity,
	)
	logger.Info(keyStage.Describe())
	logger.Info(accountRuntime.Describe())
	logger.Info("额度闸门策略",
		"minBalanceMicros", *quotaMinBalance,
		"requireSnapshot", *quotaRequireSnapshot,
		"snapshotTtlMs", quotaTTL.Milliseconds())
	logger.Info("key-gate 策略",
		"keyspendTtlMs", keySpendTTL.Milliseconds(),
		"keyConcurrency", "按 key 快照的 concurrencyLimit",
		"userConcurrency", "按余额快照的 concurrencyLimit")
	logger.Info("定价闸门策略",
		"enabled", *pricingGateEnabled,
		"snapshotTtlMs", pricingTTL.Milliseconds(),
		"mode", "fail-closed（快照不可用 → 503）")

	// cordis 用这一行拿到实际地址（TCP :0 时端口是系统分配的）。
	ready, err := json.Marshal(map[string]any{
		"type":            "ready",
		"transport":       network,
		"address":         server.Address().String(),
		"httpAddress":     httpListener.Addr().String(),
		"pid":             os.Getpid(),
		"protocolVersion": bridge.ProtocolVersion,
		"keys":            keyState.Keys,
	})
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintln(os.Stdout, string(ready)); err != nil {
		return fmt.Errorf("写 ready 行失败：%w", err)
	}

	go server.Serve()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	select {
	case signalValue := <-signals:
		logger.Info("收到退出信号", "signal", signalValue.String())
	case <-stop:
		logger.Info("收到控制桥的 shutdown")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Warn("关闭 LLM 请求入口超时", "error", err)
	}
	if err := server.Close(shutdownCtx); err != nil {
		return fmt.Errorf("关闭控制桥失败：%w", err)
	}
	logger.Info("gatewayd 已退出")
	return nil
}

// parseAPIKeys 从环境变量读取静态 key。逗号、分号、空白都算分隔符。
// 它只进内存；日志、状态与 ready 行都不会包含这些值。
func parseAPIKeys(raw string) []string {
	return strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == '\n' || r == '\r' || r == '\t' || r == ' '
	})
}

func requireLoopback(address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("地址 %q 不合法：%w", address, err)
	}
	switch host {
	case "127.0.0.1", "::1", "localhost":
	default:
		return fmt.Errorf("只允许回环地址，收到 %q", host)
	}
	if port == "" {
		return errors.New("必须显式给出端口")
	}
	return nil
}

func newLogger(format string) *slog.Logger {
	options := &slog.HandlerOptions{Level: slog.LevelInfo}
	if format == "json" {
		return slog.New(slog.NewJSONHandler(os.Stderr, options))
	}
	return slog.New(slog.NewTextHandler(os.Stderr, options))
}
