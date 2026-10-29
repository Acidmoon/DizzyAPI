// Package keygate 是 pre 相位的 **key 级执行面**闸门：注入 key 的三个上限（过期 /
// 金额上限 / 并发上限），在转发上游之前判定。
//
// owner 第 6 条拍的是「真拦截」：这三个字段不只是存起来给人看，而是真的拒绝请求。
//
// 判定顺序（便宜的先判，且互不重叠）：
//
//  1. 过期 → **401 `API_KEY_EXPIRED`**（不可重试）；
//  2. 累计消费 ≥ 金额上限 → **402 `API_KEY_SPENDING_LIMIT`**（不可重试）；
//  3. key 并发满 → **429 `API_KEY_CONCURRENCY_LIMIT`**；
//  4. 用户并发满 → **429 `USER_CONCURRENCY_LIMIT`**。
//
// 边界（AGENTS.md §2.3）：
//   - 只 import `contracts`：消费数据（key 消费快照）与并发上限（用户余额快照里的
//     并发字段）都由消费者定义的小接口注入，组装只在 cmd/gatewayd/main.go；
//   - 不写存储、不发桥消息、不碰余额：拒绝就是拒绝，不扣费；
//   - 没有 key（静态 key / 未鉴权）或三个上限都缺省时直接放行，行为与引入闸门前一致。
package keygate

import (
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const (
	// StageName 是阶段名（日志与注册用）。
	StageName = "key-gate"
	// warnInterval 是「同一原因告警」的最小间隔，防止高 QPS 下刷屏。
	warnInterval = time.Minute
)

// Spends 是「每个 key 的累计消费」只读快照接口。实现是 `internal/keyspend.Cache`。
//
// 注意金额是**整数微元**：跨层一律十进制字符串，解析在实现里做（失败即整份拒绝）。
type Spends interface {
	Ready() bool
	Lookup(keyID string) (int64, bool)
	Age() time.Duration
	TTL() time.Duration
}

// UserLimits 是用户级并发上限的只读来源。实现是 `internal/quota.Cache`。
//
// ok=false 表示快照里没有这个用户（刚注册 / 快照还没轮到）——按「不限」处理，
// 与额度闸门的默认策略一致（可用性优先；这是运营限流，不是钱）。
type UserLimits interface {
	ConcurrencyLimit(userID string) (int, bool)
}

// Reservations 是原子并发预留。实现是 `internal/limits.Tracker`（key 级与用户级共用）。
type Reservations interface {
	Acquire(scope string, limit int) (release func(), ok bool)
}

// Deps 是阶段依赖的三块只读/预留面。任何一块为 nil 只关掉对应判定（fail-open），
// 不会让阶段本身报错——网关不能因为「没配消费快照」就拒绝全部请求。
type Deps struct {
	Spends       Spends
	UserLimits   UserLimits
	Reservations Reservations
}

// Config 是 key-gate 的配置。目前没有开关：三个上限缺省时闸门是空操作，
// 所以默认总是装配（owner 要的是「配了就跑」）。
type Config struct{}

// Stats 是阶段自身的计数（排障用，不含任何身份或金额）。
type Stats struct {
	Expired                int
	SpendingBlocked        int
	ConcurrencyBlocked     int
	UserConcurrencyBlocked int
	SpendingUnknown        int
	StaleStreak            int
	StaleReason            string
	StaleForMs             int64
}

// Stage 是 key 级执行面的 pre 阶段。
type Stage struct {
	deps   Deps
	logger *slog.Logger
	now    func() time.Time

	mu         sync.Mutex
	lastWarn   map[string]time.Time
	stats      Stats
	staleSince time.Time
}

// Register 校验配置并注册阶段。
func Register(reg *contracts.Registry, cfg Config, deps Deps, logger *slog.Logger) (*Stage, error) {
	if reg == nil {
		return nil, contracts.Errorf(http.StatusInternalServerError, "KEY_GATE_INVALID_CONFIG",
			"Registry 不能为空")
	}
	_ = cfg
	stage := New(deps, logger)
	reg.Stage(stage)
	return stage, nil
}

// New 构造阶段（不注册；测试与手工组装用）。
func New(deps Deps, logger *slog.Logger) *Stage {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Stage{
		deps:     deps,
		logger:   logger,
		now:      time.Now,
		lastWarn: make(map[string]time.Time),
	}
}

func (s *Stage) Name() string { return StageName }

func (s *Stage) Phase() contracts.Phase { return contracts.PhasePre }

func (s *Stage) Required() bool { return true }

func (s *Stage) NeedBody() bool { return false }

// Run 判定一次请求。只有「有上限」时才可能拒绝。
func (s *Stage) Run(ctx *contracts.Ctx) (contracts.Decision, error) {
	continueOn := contracts.Decision{Action: contracts.ActionContinue}
	if ctx == nil || ctx.Key == nil {
		return continueOn, nil
	}
	key := ctx.Key
	if key.ExpiresAt == nil && key.SpendingLimitMicros == nil && key.ConcurrencyLimit <= 0 && key.UserID == "" {
		// 既没有 key 级上限、也没有用户（静态 key）：不占槽位、不查快照，行为与引入闸门前一致。
		// 注意**不能**因为「key 级上限都缺省」就返回——用户级并发上限是独立的判定，
		// key 自己没有上限时也必须查（否则「只给用户设了并发上限」会静默失效）。
		return continueOn, nil
	}

	// ① 过期：401、不可重试。用户需要看到「过期」而不是「无效 key」。
	if key.ExpiresAt != nil && !s.now().Before(*key.ExpiresAt) {
		s.bump(func(stats *Stats) { stats.Expired += 1 })
		return contracts.Decision{}, contracts.Errorf(http.StatusUnauthorized,
			contracts.CodeAPIKeyExpired, "API key 已于 %s 过期", key.ExpiresAt.UTC().Format(time.RFC3339))
	}

	// ② 金额上限：402、不可重试。
	if limit := key.SpendingLimitMicros; limit != nil {
		spent, known := s.spent(key.KeyID)
		switch {
		case !known:
			// 消费快照不可用 / 还没有这个 key：放行 + 计数。
			// 上限是运营保护而不是钱（钱由额度闸门与后付费结算兜底），宁可放行也不要
			// 因为 TS 的一条快照没推上来就把所有请求打成 402。
			s.bump(func(stats *Stats) { stats.SpendingUnknown += 1 })
			s.warn(ctx, "spending-unknown", "key 消费快照不可用或缺少该 key，金额上限本请求不判定", "keyId", key.KeyID)
		case spent >= *limit:
			s.bump(func(stats *Stats) { stats.SpendingBlocked += 1 })
			return contracts.Decision{}, contracts.Errorf(http.StatusPaymentRequired,
				contracts.CodeAPIKeySpendingLimit,
				"该 API key 的累计消费已达金额上限（%d 微元），请调整上限或更换 key", *limit)
		}
	}

	// ③④ 并发：key 级与用户级共用同一套原子预留；先 key 后 user，失败要把已占的退回去。
	releases := make([]func(), 0, 2)
	if key.ConcurrencyLimit > 0 && key.KeyID != "" {
		release, ok := s.acquire(contracts.LimitScopeKeyPrefix+key.KeyID, key.ConcurrencyLimit)
		if !ok {
			s.bump(func(stats *Stats) { stats.ConcurrencyBlocked += 1 })
			return contracts.Decision{}, contracts.Errorf(http.StatusTooManyRequests,
				contracts.CodeAPIKeyConcurrencyLimit,
				"该 API key 的并发请求已达上限（%d），请稍后重试", key.ConcurrencyLimit)
		}
		releases = append(releases, release)
	}
	if key.UserID != "" {
		if limit, ok := s.userLimit(key.UserID); ok && limit > 0 {
			release, ok := s.acquire(contracts.LimitScopeUserPrefix+key.UserID, limit)
			if !ok {
				for _, done := range releases {
					done()
				}
				s.bump(func(stats *Stats) { stats.UserConcurrencyBlocked += 1 })
				return contracts.Decision{}, contracts.Errorf(http.StatusTooManyRequests,
					contracts.CodeUserConcurrencyLimit,
					"该用户的并发请求已达上限（%d），请稍后重试", limit)
			}
			releases = append(releases, release)
		}
	}
	if len(releases) > 0 {
		// 释放时机与账号并发槽位一致：engine 把它串进 ReleaseInFlight（响应含整个流写完），
		// 走不到 dispatch 的出口由 engine 兜底释放。组合 release 自身幂等。
		var once sync.Once
		ctx.ReleasePreSlot = func() {
			once.Do(func() {
				for _, done := range releases {
					done()
				}
			})
		}
	}

	s.clearStale()
	return continueOn, nil
}

// Stats 返回计数快照。
func (s *Stage) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	stats := s.stats
	if stats.StaleStreak > 0 && s.now != nil {
		stats.StaleForMs = s.now().Sub(s.staleSince).Milliseconds()
	}
	return stats
}

func (s *Stage) spent(keyID string) (int64, bool) {
	if s.deps.Spends == nil || keyID == "" {
		return 0, false
	}
	if !s.deps.Spends.Ready() {
		return 0, false
	}
	ttl := s.deps.Spends.TTL()
	if ttl > 0 && s.deps.Spends.Age() > ttl {
		return 0, false
	}
	return s.deps.Spends.Lookup(keyID)
}

func (s *Stage) userLimit(userID string) (int, bool) {
	if s.deps.UserLimits == nil || userID == "" {
		return 0, false
	}
	return s.deps.UserLimits.ConcurrencyLimit(userID)
}

// acquire 预留一个槽位；没有注入预留器时视为不限（测试 / 旧装配）。
func (s *Stage) acquire(scope string, limit int) (func(), bool) {
	if s.deps.Reservations == nil {
		return func() {}, true
	}
	return s.deps.Reservations.Acquire(scope, limit)
}

func (s *Stage) bump(update func(*Stats)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	update(&s.stats)
}

// warn 按原因节流：连续不可用会累计 streak（排障时能区分偶发与持续）。
func (s *Stage) warn(ctx *contracts.Ctx, reason, message string, args ...any) {
	now := s.now()
	s.mu.Lock()
	if s.stats.StaleReason != reason {
		s.stats.StaleReason = reason
		s.stats.StaleStreak = 0
		s.staleSince = now
	}
	s.stats.StaleStreak += 1
	streak := s.stats.StaleStreak
	last, seen := s.lastWarn[reason]
	if seen && now.Sub(last) < warnInterval {
		s.mu.Unlock()
		return
	}
	s.lastWarn[reason] = now
	s.mu.Unlock()

	fields := []any{"reqId", ctx.ReqID, "code", reason, "staleStreak", streak}
	s.logger.Warn(message, append(fields, args...)...)
}

func (s *Stage) clearStale() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stats.StaleStreak = 0
	s.stats.StaleReason = ""
	s.staleSince = time.Time{}
}
