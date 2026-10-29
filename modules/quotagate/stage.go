// Package quotagate 是 pre 相位的额度闸门：按请求的 userId 查余额只读快照，
// 余额 ≤ 阈值时直接拒绝，不花钱转发上游。
//
// 边界（AGENTS.md §2.3）：
//   - 只 import `contracts`：余额来源由消费者定义的小接口注入（main.go 组装），
//     不 import `internal/quota` 或任何其它模块；
//   - 只读：不改余额、不写存储、不发桥消息；
//   - 没有 userId（静态 key / 无 key 的调用）不预检，行为与引入本阶段之前一致。
package quotagate

import (
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const (
	// StageName 是阶段名（日志与注册用）。
	StageName = "quota-gate"
	// DefaultWarnInterval 是「同一原因告警」的最小间隔：快照没就绪时每 5 秒一次调用，
	// 不能每个请求刷一行。
	DefaultWarnInterval = time.Minute
	// staleLogEvery 是「持续失效」的里程碑步长：连续第 10 / 20 / 30… 次不可用时补一条告警，
	// 这样「一直不可用」不会只留第一行就被节流彻底藏住。
	staleLogEvery = 10
	// sustainedLogInterval 是里程碑告警的最小间隔，防止高 QPS 下每 10 次刷一行。
	sustainedLogInterval = 5 * time.Second
)

// Balances 是消费者定义的只读余额快照接口。实现是 `internal/quota.Cache`。
type Balances interface {
	// Ready 表示是否已经收到过至少一份合法快照。
	Ready() bool
	// Lookup 返回某用户的余额微元；快照里没有这个用户时 ok=false。
	Lookup(userID string) (int64, bool)
	// Age 返回当前快照的年龄（没有快照时为 0）。
	Age() time.Duration
	// TTL 返回快照有效期。
	TTL() time.Duration
}

// Config 是额度闸门的配置。非法值由 Register 明确拒绝（组合根让进程起不来）。
type Config struct {
	// MinBalanceMicros 是放行所需的最低余额（含）。默认 0：余额 0 及以下一律拒绝。
	MinBalanceMicros int64
	// RequireSnapshot 打开严格模式：快照未就绪 / 过期 / 查不到该用户时返回 503，
	// 而不是放行。默认 false = availability 优先（后付费结算兜底）。
	RequireSnapshot bool
	// SnapshotTTL 是快照有效期，必须 > 0。默认取余额缓存自己的 TTL。
	SnapshotTTL time.Duration
}

// Stage 是额度闸门的 pre 阶段。
type Stage struct {
	balances       Balances
	config         Config
	logger         *slog.Logger
	now            func() time.Time
	warnInterval   time.Duration
	mu             sync.Mutex
	lastWarn       map[string]time.Time
	allowedUnknown int
	blockedLow     int
	strictBlocked  int
	// 连续不可用（stale / 用户缺失）的观察：用来区分「偶发」与「持续」。
	staleStreak int
	staleReason string
	staleSince  time.Time
	staleFor    time.Duration
}

// Register 校验配置并注册阶段。balances 为 nil 表示没有运行时余额来源：
// 严格模式下等于「快照永远不可用」，默认模式下等于永不预检。
func Register(reg *contracts.Registry, cfg Config, balances Balances, logger *slog.Logger) (*Stage, error) {
	if reg == nil {
		return nil, contracts.Errorf(http.StatusInternalServerError, "QUOTA_GATE_INVALID_CONFIG",
			"Registry 不能为空")
	}
	if cfg.SnapshotTTL < 0 {
		return nil, contracts.Errorf(http.StatusInternalServerError, "QUOTA_GATE_INVALID_CONFIG",
			"快照有效期不能为负数")
	}
	if cfg.SnapshotTTL == 0 && balances != nil {
		cfg.SnapshotTTL = balances.TTL()
	}
	stage := New(cfg, balances, logger)
	reg.Stage(stage)
	return stage, nil
}

// New 构造阶段（不注册；测试与手工组装用）。
func New(cfg Config, balances Balances, logger *slog.Logger) *Stage {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Stage{
		balances:     balances,
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

// Run 做一次预检。只有「有 userId 且快照覆盖该用户」时才可能拒绝。
func (s *Stage) Run(ctx *contracts.Ctx) (contracts.Decision, error) {
	continueOn := contracts.Decision{Action: contracts.ActionContinue}
	if ctx == nil || ctx.Key == nil || ctx.Key.UserID == "" {
		// 静态 key / 未鉴权路径没有 user 映射：不预检，行为与引入闸门前一致。
		return continueOn, nil
	}
	userID := ctx.Key.UserID

	if s.snapshotUnavailable() {
		streak, since := s.noteStale("snapshot-unavailable")
		if s.config.RequireSnapshot {
			s.warn(ctx, "snapshot-unavailable", streak, since, "余额快照不可用，严格模式拒绝请求", "userId", userID)
			s.countStrict()
			return contracts.Decision{}, contracts.Errorf(http.StatusServiceUnavailable,
				contracts.CodeQuotaSnapshotUnavailable,
				"余额快照暂时不可用，请稍后重试")
		}
		s.warn(ctx, "snapshot-unavailable", streak, since, "余额快照不可用，本请求放行（后付费结算兜底）", "userId", userID)
		s.countAllowedUnknown()
		return continueOn, nil
	}

	balance, ok := s.balances.Lookup(userID)
	if !ok {
		// 快照就绪但没有这个用户：可能是刚注册、还没被下一轮推送覆盖。
		streak, since := s.noteStale("user-missing")
		if s.config.RequireSnapshot {
			s.warn(ctx, "user-missing", streak, since, "快照里没有该用户，严格模式拒绝请求", "userId", userID)
			s.countStrict()
			return contracts.Decision{}, contracts.Errorf(http.StatusServiceUnavailable,
				contracts.CodeQuotaSnapshotUnavailable,
				"余额快照里暂时没有这个用户，请稍后重试")
		}
		s.warn(ctx, "user-missing", streak, since, "快照里没有该用户，本请求放行", "userId", userID)
		s.countAllowedUnknown()
		return continueOn, nil
	}

	// 走到这里说明快照是新鲜且覆盖该用户的：连续不可用的观察清零。
	s.noteHealthy()

	if balance <= s.config.MinBalanceMicros {
		s.countBlocked()
		// 402、不可重试：客户端应当充值后再来，而不是换 key 或无限重试。
		return contracts.Decision{}, contracts.Errorf(http.StatusPaymentRequired,
			contracts.CodeInsufficientBalance, "余额不足，请充值后重试")
	}

	return continueOn, nil
}

// GateStats 是阶段自身的计数（排障用，不含用户余额）。
type GateStats struct {
	AllowedUnknown int
	BlockedLow     int
	StrictBlocked  int
	// 连续不可用（stale / 用户缺失）的观察：偶发时是 1，持续失效时一路涨。
	StaleStreak int
	StaleReason string
	StaleForMs  int64
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
		AllowedUnknown: s.allowedUnknown,
		BlockedLow:     s.blockedLow,
		StrictBlocked:  s.strictBlocked,
		StaleStreak:    s.staleStreak,
		StaleReason:    s.staleReason,
		StaleForMs:     staleFor.Milliseconds(),
	}
}

// noteStale 记一次「快照不可用」的观察，返回连续次数与起始时间。
//
// 连续次数是区分「偶发」与「持续」的关键：reason 变了或中间恢复过就重新计数。
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

// noteHealthy 在快照新鲜且覆盖该用户时清零连续不可用的观察。
func (s *Stage) noteHealthy() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.staleStreak = 0
	s.staleReason = ""
	s.staleSince = time.Time{}
	s.staleFor = 0
}

// snapshotUnavailable 判断「没有可用快照」：没收到、或超过 TTL。
func (s *Stage) snapshotUnavailable() bool {
	if s.balances == nil || !s.balances.Ready() {
		return true
	}
	ttl := s.config.SnapshotTTL
	if ttl <= 0 {
		ttl = s.balances.TTL()
	}
	if ttl <= 0 {
		return false
	}
	return s.balances.Age() > ttl
}

// warn 按原因节流，并区分「偶发」与「持续」：
//
//   - 第 1 次（连续次数 == 1）立即报；
//   - 之后同一原因每分钟最多一行（原有节流，防刷屏）；
//   - 连续第 10 / 20 / 30… 次（里程碑）时，即使还没到一分钟也补一行，
//     并带上「已连续 N 次 / 持续 Xs」——这样「一直不可用」不会被节流彻底藏住。
//
// 生产事故的教训：stale 每时每刻都在发生，只按分钟节流会让排障时以为「只错了一次」。
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

func (s *Stage) countAllowedUnknown() {
	s.mu.Lock()
	s.allowedUnknown += 1
	s.mu.Unlock()
}

func (s *Stage) countBlocked() {
	s.mu.Lock()
	s.blockedLow += 1
	s.mu.Unlock()
}

func (s *Stage) countStrict() {
	s.mu.Lock()
	s.strictBlocked += 1
	s.mu.Unlock()
}
