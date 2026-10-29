// Package limits 是 Go 进程内的**并发槽位预留**（key 级与用户级共用同一套实现）。
//
// 为什么和 internal/accountruntime 分开：那是「上游账号」的运行时状态（真实 in-flight
// + 冷却），归属账号池；这里是「调用方配额」的运行时状态（key / 用户并发上限），
// 归属 pre 相位的 key-gate。两者都是纯内存、都靠原子预留，但消费者与生命周期不同。
//
// 三条硬约束：
//   - **不认识业务**：只按 scope 字符串计数，不知道 key 属于谁、也不看请求内容；
//   - **release 必须幂等**：engine 的 panic 兜底与 HTTP 入口的 defer 都会调它；
//   - **不排队**：预留失败就是拒绝（429），排队会把延迟堆进网关。
package limits

import (
	"strings"
	"sync"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Tracker 是并发安全的槽位预留容器。零值不可用，请用 New 构造。
type Tracker struct {
	mu       sync.Mutex
	inflight map[string]int
	// blocked 是按 scope 前缀的拒绝计数，只用于排障观察（不含任何身份信息）。
	blockedKey  int
	blockedUser int
}

// New 构造 Tracker。
func New() *Tracker {
	return &Tracker{inflight: make(map[string]int)}
}

// Acquire 原子预留一个槽位。
//
// limit <= 0 表示不限：永远成功，但仍然计数（排障时能看到真实活跃数）。
// ok=false 表示此刻已饱和，调用方必须拒绝请求，不许排队。
// release 幂等：重复调用只减一次（panic 兜底 + handler defer 会各调一次）。
func (t *Tracker) Acquire(scope string, limit int) (release func(), ok bool) {
	if t == nil || scope == "" {
		return func() {}, true
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if limit > 0 && t.inflight[scope] >= limit {
		return nil, false
	}
	t.inflight[scope] += 1
	var once sync.Once
	return func() {
		once.Do(func() { t.release(scope) })
	}, true
}

func (t *Tracker) release(scope string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	count := t.inflight[scope]
	if count <= 1 {
		delete(t.inflight, scope)
		return
	}
	t.inflight[scope] = count - 1
}

// InFlight 返回某个 scope 此刻的占用数（观察用）。
func (t *Tracker) InFlight(scope string) int {
	if t == nil {
		return 0
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.inflight[scope]
}

// Active 返回所有 scope 的活跃总数（观察用）。
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

// Stats 是给桥命令看的聚合计数：只有整数，没有任何身份信息。
type Stats struct {
	// ActiveKeys / ActiveUsers 是当前有活跃占用的 scope 数（不是请求数）。
	ActiveKeys  int `json:"activeKeys,omitempty"`
	ActiveUsers int `json:"activeUsers,omitempty"`
	// BlockedKey / BlockedUser 是闸门拒绝次数。
	BlockedKey  int `json:"blockedKey,omitempty"`
	BlockedUser int `json:"blockedUser,omitempty"`
}

// RecordBlocked 记一次拒绝（排障用，不带身份）。kind 是 scope 前缀。
func (t *Tracker) RecordBlocked(kind string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if kind == contracts.LimitScopeUserPrefix {
		t.blockedUser += 1
		return
	}
	t.blockedKey += 1
}

// Summary 返回聚合计数（只读，不含身份）。
func (t *Tracker) Summary() Stats {
	if t == nil {
		return Stats{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	keys, users := 0, 0
	for scope := range t.inflight {
		if strings.HasPrefix(scope, contracts.LimitScopeUserPrefix) {
			users += 1
			continue
		}
		keys += 1
	}
	return Stats{
		ActiveKeys:  keys,
		ActiveUsers: users,
		BlockedKey:  t.blockedKey,
		BlockedUser: t.blockedUser,
	}
}
