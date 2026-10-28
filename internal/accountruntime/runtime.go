// Package accountruntime 是 Go 进程内的账号运行时状态（AGENTS.md §8 的最小版）。
//
// 它只做两件事，都是**纯内存**的：
//   - 真实 in-flight 计数：dispatch 选中账号后 +1，请求（含整个流）结束后 -1；
//   - 429 / 额度耗尽的短期冷却：冷却期内该账号不可选，到期自动恢复。
//
// 边界（D17 / D18）：
//   - 不落盘、不回写 TS、不改快照协议；gatewayd 重启即清空；
//   - 不感知 LLM 请求内容；只按 AccountID 计数与记时间；
//   - 组合根负责注入：engine 依赖 Apply/Acquire，transport 依赖 RecordLimit。
package accountruntime

import (
	"fmt"
	"sync"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Tracker 是并发安全的运行时状态容器。零值不可用，请用 New 构造。
type Tracker struct {
	mu       sync.Mutex
	now      func() time.Time
	cooldown time.Duration
	inflight map[string]int
	cooling  map[string]time.Time
}

// Option 是构造选项（目前只有测试用的时钟注入）。
type Option func(*Tracker)

// WithClock 替换时间源。只给单测用：生产走 time.Now。
func WithClock(now func() time.Time) Option {
	return func(t *Tracker) {
		if now != nil {
			t.now = now
		}
	}
}

// New 构造 Tracker。cooldown <= 0 表示关闭冷却记录（429 仍会换账号，只是不记冷却）。
func New(cooldown time.Duration, options ...Option) *Tracker {
	tracker := &Tracker{
		now:      time.Now,
		cooldown: cooldown,
		inflight: make(map[string]int),
		cooling:  make(map[string]time.Time),
	}
	for _, option := range options {
		option(tracker)
	}
	return tracker
}

// Apply 把真实 in-flight 与冷却状态写进候选快照。
//
// 它必须在 accountpriority 打分之前调用（engine 在 pre 阶段前调用），
// 这样 exclude_saturated / exclude_cooling 才是真的生效。
func (t *Tracker) Apply(candidates []contracts.AccountCandidate) {
	if t == nil || len(candidates) == 0 {
		return
	}
	now := t.now()
	t.mu.Lock()
	defer t.mu.Unlock()
	for index := range candidates {
		accountID := candidates[index].AccountID
		candidates[index].InFlight = t.inflight[accountID]
		candidates[index].CooldownUntil = nil
		until, ok := t.cooling[accountID]
		if !ok {
			continue
		}
		if now.Before(until) {
			copied := until
			candidates[index].CooldownUntil = &copied
			continue
		}
		// 冷却到期自动恢复：清掉过期条目，避免 map 无界增长。
		delete(t.cooling, accountID)
	}
}

// Acquire 原子预留一个并发槽位。
//
// concurrency <= 0 表示账号没有声明并发上限（旧快照 / 不限流）：永远成功，
// 但仍然计数，方便排障观察真实活跃数。ok=false 表示此刻已饱和，调用方必须
// 换下一个账号，不许排队等待。release 幂等（重复调用只减一次）。
func (t *Tracker) Acquire(accountID string, concurrency int) (release func(), ok bool) {
	if t == nil {
		return func() {}, true
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if concurrency > 0 && t.inflight[accountID] >= concurrency {
		return nil, false
	}
	t.inflight[accountID] += 1
	var once sync.Once
	return func() {
		once.Do(func() { t.release(accountID) })
	}, true
}

func (t *Tracker) release(accountID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	count := t.inflight[accountID]
	if count <= 1 {
		delete(t.inflight, accountID)
		return
	}
	t.inflight[accountID] = count - 1
}

// RecordLimit 记录一次上游限流 / 额度耗尽，开始短期冷却。
//
// 冷却时长在构造时固定（配置项，非法值由组合根拒绝启动）。accountID 为空
// 或冷却时长 <= 0 时什么也不做。
func (t *Tracker) RecordLimit(accountID string) {
	if t == nil || accountID == "" || t.cooldown <= 0 {
		return
	}
	until := t.now().Add(t.cooldown)
	t.mu.Lock()
	defer t.mu.Unlock()
	t.cooling[accountID] = until
}

// InFlight 返回某账号此刻的活跃请求数（观察用）。
func (t *Tracker) InFlight(accountID string) int {
	if t == nil {
		return 0
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.inflight[accountID]
}

// Active 返回当前所有账号的活跃请求总数（观察用）。
func (t *Tracker) Active() int {
	if t == nil {
		return 0
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	total := 0
	for _, count := range t.inflight {
		total += count
	}
	return total
}

// CoolingUntil 返回某账号的冷却截止时间；不在冷却中返回 false。
func (t *Tracker) CoolingUntil(accountID string) (time.Time, bool) {
	if t == nil {
		return time.Time{}, false
	}
	now := t.now()
	t.mu.Lock()
	defer t.mu.Unlock()
	until, ok := t.cooling[accountID]
	if !ok || !now.Before(until) {
		return time.Time{}, false
	}
	return until, true
}

// Describe 返回一段不含秘密的运行时快照描述，供启动日志与排障使用。
func (t *Tracker) Describe() string {
	if t == nil {
		return "account-runtime: disabled"
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	cooling := 0
	for _, until := range t.cooling {
		if now.Before(until) {
			cooling += 1
		}
	}
	return fmt.Sprintf("account-runtime: cooldown=%s inflightAccounts=%d active=%d cooling=%d",
		t.cooldown, len(t.inflight), t.active(), cooling)
}

// active 在已持锁时统计活跃数（避免 Describe 里重复加锁）。
func (t *Tracker) active() int {
	total := 0
	for _, count := range t.inflight {
		total += count
	}
	return total
}
