// Package pricinggate 是 pre 相位的**定价闸门**：请求的模型没有配置价格就直接拒绝，
// 不转发上游。
//
// owner 第 10 条拍的是「真拒绝」：不是「照常请求再标注未定价」，而是**没价不许请求**。
//
// 两种拒绝：
//
//   - 模型没价 → **403 `MODEL_NOT_PRICED`**（不可重试、不转发上游）；
//   - 价格快照不可用（没收到 / 超过 TTL）→ **503 `PRICING_SNAPSHOT_UNAVAILABLE`**。
//     这里是 **fail-closed**：owner 要的是真拒绝，快照不可用时放行等于闸门失效。
//     （与额度闸门 / 内容审核相反：那两个是可用性优先，因为它们是「保护」，而这个
//     是「准入」。）
//
// 默认**关**（配置项 / 命令行开关 `-pricing-gate` 默认 false）：上线后确认价格快照
// 正常推上来了再打开，否则换二进制的一瞬间所有未定价模型全 403/503。
//
// 边界：只 import contracts；价格快照由消费者定义的小接口注入（实现 internal/pricing），
// 组装只在 cmd/gatewayd/main.go；不写存储、不发桥消息。
package pricinggate

import (
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const (
	// StageName 是阶段名（日志与注册用）。
	StageName = "pricing-gate"
	// DefaultWarnInterval 是「同一原因告警」的最小间隔。
	DefaultWarnInterval = time.Minute
	// staleLogEvery 是「持续失效」的里程碑步长：连续第 10 / 20 / 30… 次补一条告警。
	staleLogEvery = 10
	// sustainedLogInterval 是里程碑告警的最小间隔，防高 QPS 下刷屏。
	sustainedLogInterval = 5 * time.Second
)

// Prices 是消费者定义的只读价格快照接口。实现是 `internal/pricing.Cache`。
type Prices interface {
	// Ready 表示是否已经收到过至少一份合法快照。
	Ready() bool
	// Priced 判断模型有没有价（含 `*` 兜底，与 TS 的 billing.hasPrice 同口径）。
	Priced(model string) bool
	// Age 返回当前快照的年龄（没有快照时为 0）。
	Age() time.Duration
	// TTL 返回快照有效期。
	TTL() time.Duration
}

// Config 是定价闸门的配置。非法值由 Register 明确拒绝（组合根让进程起不来）。
type Config struct {
	// SnapshotTTL 是快照有效期，必须 >= 0。0 = 用快照自己的 TTL。
	SnapshotTTL time.Duration
}

// Stage 是定价闸门的 pre 阶段。
type Stage struct {
	prices       Prices
	config       Config
	logger       *slog.Logger
	now          func() time.Time
	warnInterval time.Duration

	mu          sync.Mutex
	lastWarn    map[string]time.Time
	blocked     int
	strict      int
	allowed     int
	staleStreak int
	staleReason string
	staleSince  time.Time
	staleFor    time.Duration
}

// Register 校验配置并注册阶段。prices 为 nil 时等于「快照永远不可用」：
// 既然闸门是 fail-closed，那就一律 503（这比静默放行安全）。
func Register(reg *contracts.Registry, cfg Config, prices Prices, logger *slog.Logger) (*Stage, error) {
	if reg == nil {
		return nil, contracts.Errorf(http.StatusInternalServerError, "PRICING_GATE_INVALID_CONFIG",
			"Registry 不能为空")
	}
	if cfg.SnapshotTTL < 0 {
		return nil, contracts.Errorf(http.StatusInternalServerError, "PRICING_GATE_INVALID_CONFIG",
			"快照有效期不能为负数")
	}
	if cfg.SnapshotTTL == 0 && prices != nil {
		cfg.SnapshotTTL = prices.TTL()
	}
	stage := New(cfg, prices, logger)
	reg.Stage(stage)
	return stage, nil
}

// New 构造阶段（不注册；测试与手工组装用）。
func New(cfg Config, prices Prices, logger *slog.Logger) *Stage {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Stage{
		prices:       prices,
		config:       cfg,
		logger:       logger,
		now:          time.Now,
		warnInterval: DefaultWarnInterval,
		lastWarn:     make(map[string]time.Time),
	}
}

func (s *Stage) Name() string { return StageName }

func (s *Stage) Phase() contracts.Phase { return contracts.PhasePre }

func (s *Stage) Required() bool { return true }

func (s *Stage) NeedBody() bool { return false }

// Run 判定一次请求的模型有没有价。
func (s *Stage) Run(ctx *contracts.Ctx) (contracts.Decision, error) {
	continueOn := contracts.Decision{Action: contracts.ActionContinue}
	if ctx == nil {
		return continueOn, nil
	}
	model := ctx.Meta.Model
	if model == "" {
		// 入口已经拒绝空 model；这里不重复造一个错误形状。
		return continueOn, nil
	}

	if s.snapshotUnavailable() {
		streak, since := s.noteStale("pricing-snapshot-unavailable")
		s.countStrict()
		s.warn(ctx, "pricing-snapshot-unavailable", streak, since,
			"价格快照不可用，定价闸门 fail-closed 拒绝请求")
		return contracts.Decision{}, contracts.Errorf(http.StatusServiceUnavailable,
			contracts.CodePricingSnapshotUnavailable, "价格表暂时不可用，请稍后重试")
	}

	if !s.prices.Priced(model) {
		s.countBlocked()
		return contracts.Decision{}, contracts.Errorf(http.StatusForbidden,
			contracts.CodeModelNotPriced,
			"模型 %s 没有配置价格，暂不可请求（请联系管理员补价目表）", model)
	}

	s.countAllowed()
	s.noteHealthy()
	return continueOn, nil
}

// GateStats 是阶段自身的计数（排障用，不含模型名的枚举）。
type GateStats struct {
	Blocked       int
	StrictBlocked int
	Allowed       int
	StaleStreak   int
	StaleReason   string
	StaleForMs    int64
}

// Stats 返回计数快照。
func (s *Stage) Stats() GateStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	staleFor := s.staleFor
	if s.staleStreak > 0 && s.now != nil {
		staleFor = s.now().Sub(s.staleSince)
	}
	return GateStats{
		Blocked:       s.blocked,
		StrictBlocked: s.strict,
		Allowed:       s.allowed,
		StaleStreak:   s.staleStreak,
		StaleReason:   s.staleReason,
		StaleForMs:    staleFor.Milliseconds(),
	}
}

// snapshotUnavailable 判断「没有可用快照」：没收到、或超过 TTL。
func (s *Stage) snapshotUnavailable() bool {
	if s.prices == nil || !s.prices.Ready() {
		return true
	}
	ttl := s.config.SnapshotTTL
	if ttl <= 0 {
		ttl = s.prices.TTL()
	}
	if ttl <= 0 {
		return false
	}
	return s.prices.Age() > ttl
}

func (s *Stage) noteStale(reason string) (int, time.Time) {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.staleStreak == 0 || s.staleReason != reason {
		s.staleStreak = 0
		s.staleReason = reason
		s.staleSince = now
	}
	s.staleStreak += 1
	s.staleFor = now.Sub(s.staleSince)
	return s.staleStreak, s.staleSince
}

func (s *Stage) noteHealthy() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.staleStreak = 0
	s.staleReason = ""
	s.staleSince = time.Time{}
	s.staleFor = 0
}

func (s *Stage) countBlocked() { s.mu.Lock(); s.blocked += 1; s.mu.Unlock() }
func (s *Stage) countStrict()  { s.mu.Lock(); s.strict += 1; s.mu.Unlock() }
func (s *Stage) countAllowed() { s.mu.Lock(); s.allowed += 1; s.mu.Unlock() }

// warn 按原因节流，并区分「偶发」与「持续」（同额度闸门的教训：只按分钟节流会把
// 「一直在失效」藏成「只错了一次」）。
func (s *Stage) warn(ctx *contracts.Ctx, reason string, streak int, since time.Time, message string, args ...any) {
	now := s.now()
	s.mu.Lock()
	last, seen := s.lastWarn[reason]
	sustainedMilestone := streak > 1 && streak%staleLogEvery == 0 && (!seen || now.Sub(last) >= sustainedLogInterval)
	if streak != 1 && seen && now.Sub(last) < s.warnInterval && !sustainedMilestone {
		s.mu.Unlock()
		return
	}
	s.lastWarn[reason] = now
	s.mu.Unlock()

	fields := []any{"reqId", ctx.ReqID, "code", reason, "staleStreak", streak}
	if !since.IsZero() {
		fields = append(fields, "staleForMs", now.Sub(since).Milliseconds())
	}
	if streak > 1 {
		message = message + "（持续失效）"
	}
	s.logger.Warn(message, append(fields, args...)...)
}
