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
	"github.com/Acidmoon/DizzyAPI/internal/engine"
	"github.com/Acidmoon/DizzyAPI/internal/httpapi"
	"github.com/Acidmoon/DizzyAPI/internal/usagelog"
	"github.com/Acidmoon/DizzyAPI/internal/usageprobe"
	"github.com/Acidmoon/DizzyAPI/modules/accountpriority"
	"github.com/Acidmoon/DizzyAPI/modules/keyauth"
	"github.com/Acidmoon/DizzyAPI/modules/modelroute"
	"github.com/Acidmoon/DizzyAPI/modules/protoconv"
	"github.com/Acidmoon/DizzyAPI/modules/transport"
)

type handler struct {
	service  *accountpriority.Service
	accounts *accounts.Cache
	keys     *apikeys.Cache
	usage    *usagelog.Ring
	runtime  *accountruntime.Tracker
	logger   *slog.Logger
	shutdown chan struct{}
	stopOnce sync.Once
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
		return h.keys.Status(), nil

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
	httpAPI, err := httpapi.New(requestEngine, accountCache, logger, httpapi.Config{
		MaxBodyBytes: *maxBody,
		Strategy:     *strategy,
		// /v1/models 复用 keyauth 的同一套鉴权判定。
		Authorizer:        keyStage,
		UsageSink:         usageRing,
		UsageProbe:        usageprobe.New(codecs),
		RecordStreamUsage: *recordStreamUsage,
		TrustedProxyHops:  *trustedProxyHops,
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
		runtime:  accountRuntime,
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
