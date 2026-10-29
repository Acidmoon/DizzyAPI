// Package keyspend 是 Go 侧的「每个 API key 的累计消费」只读快照缓存。
//
// 为什么需要它：key 级的「金额上限」要在 pre 相位判，而**花钱的事实只有 TS 知道**
// （结算与算价都在 TS 侧：billing 用 pricing 复算，Go 不碰钱）。所以 TS 把
// 「keyId → 累计消费微元」整份心跳式推过来，Go 只读、只比大小。
//
// 边界：
//   - 纯内存、不落盘、不回写 TS；gatewayd 重启后等下一轮心跳（TS 5s 一轮）；
//   - 金额一律十进制字符串跨层：JSON number 会丢 >2^53 的精度，解析失败即整份拒绝；
//   - 不参与任何计费决策：它只回答「这个 key 已经花了多少」。
package keyspend

import (
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// SnapshotVersion 是桥消息里的快照版本。只接受 1。
	SnapshotVersion = 1
	// MaxEntries 一份快照最多容纳的 key 数（与 key 快照的上界一致）。
	MaxEntries = 1_000_000
	// MaxKeyIDBytes / MaxRevisionBytes 是字段长度上限。
	MaxKeyIDBytes    = 128
	MaxRevisionBytes = 128
)

// 稳定错误码；桥会原样转发给 TS。
const (
	CodeInvalidSnapshot = "KEYSPEND_INVALID_SNAPSHOT"
	CodeInvalidAmount   = "KEYSPEND_INVALID_AMOUNT"
	CodeDuplicateKey    = "KEYSPEND_DUPLICATE_KEY"
	CodeStaleSnapshot   = "KEYSPEND_SNAPSHOT_STALE"
)

// Snapshot 是 TS 推来的完整 key 消费快照。任何一条不合法就整份拒绝。
type Snapshot struct {
	Version    int   `json:"version"`
	Generation int64 `json:"generation"`
	// Revision 是 entries 的内容哈希，用于识别幂等重推。
	Revision string  `json:"revision"`
	Entries  []Entry `json:"entries"`
}

// Entry 是一个 key 的累计消费。SpentMicros 是十进制字符串（非负）。
type Entry struct {
	KeyID       string `json:"keyId"`
	SpentMicros string `json:"spentMicros"`
}

// Result 是 Replace 的返回：不含任何金额明细。
type Result struct {
	Ready      bool      `json:"ready"`
	Revision   string    `json:"revision"`
	Generation int64     `json:"generation"`
	Entries    int       `json:"entries"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// State 是桥命令 keyspend.status 的响应：只给健康度，不给 key 级明细。
type State struct {
	Ready      bool       `json:"ready"`
	Revision   string     `json:"revision,omitempty"`
	Generation int64      `json:"generation,omitempty"`
	Size       int        `json:"size"`
	UpdatedAt  *time.Time `json:"updatedAt,omitempty"`
	AgeMs      int64      `json:"ageMs"`
	TtlMs      int64      `json:"ttlMs"`
}

// Error 是带稳定码的领域错误。
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func newError(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

type compiled struct {
	revision   string
	generation int64
	spent      map[string]int64
	updatedAt  time.Time
}

// Option 是构造选项（只给单测用）。
type Option func(*Cache)

// WithTTL 设置快照的过期时长。
func WithTTL(ttl time.Duration) Option {
	return func(c *Cache) {
		if ttl > 0 {
			c.ttl = ttl
		}
	}
}

// WithClock 替换时间源。只给单测用：生产走 time.Now。
func WithClock(now func() time.Time) Option {
	return func(c *Cache) {
		if now != nil {
			c.now = now
		}
	}
}

// DefaultTTL 是未显式配置时的快照有效期；组合根默认按 3 × TS 推送间隔设置。
const DefaultTTL = 15 * time.Second

// Cache 是线程安全的 key 消费快照缓存。零值不可用，请用 New 构造。
type Cache struct {
	snap atomic.Pointer[compiled]
	mu   sync.Mutex
	ttl  time.Duration
	now  func() time.Time
}

// New 构造缓存。
func New(options ...Option) *Cache {
	cache := &Cache{ttl: DefaultTTL, now: time.Now}
	for _, option := range options {
		option(cache)
	}
	return cache
}

// TTL 返回快照有效期。
func (c *Cache) TTL() time.Duration {
	if c == nil {
		return 0
	}
	return c.ttl
}

// Replace 校验并原子替换快照。generation 回退明确拒绝（不覆盖旧快照）。
func (c *Cache) Replace(snapshot Snapshot) (Result, error) {
	if c == nil {
		return Result{}, newError(CodeInvalidSnapshot, "key 消费快照缓存不可用")
	}
	if snapshot.Version != SnapshotVersion {
		return Result{}, newError(CodeInvalidSnapshot,
			"快照版本必须是 %d，收到 %d", SnapshotVersion, snapshot.Version)
	}
	if snapshot.Generation <= 0 {
		return Result{}, newError(CodeInvalidSnapshot, "快照 generation 必须为正数")
	}
	if snapshot.Revision == "" || len(snapshot.Revision) > MaxRevisionBytes {
		return Result{}, newError(CodeInvalidSnapshot, "快照 revision 必填且不超过 %d 字节", MaxRevisionBytes)
	}
	if len(snapshot.Entries) > MaxEntries {
		return Result{}, newError(CodeInvalidSnapshot, "一份快照最多 %d 条，收到 %d", MaxEntries, len(snapshot.Entries))
	}

	spent := make(map[string]int64, len(snapshot.Entries))
	for index, entry := range snapshot.Entries {
		if entry.KeyID == "" || len(entry.KeyID) > MaxKeyIDBytes {
			return Result{}, newError(CodeInvalidSnapshot,
				"第 %d 条记录的 keyId 必填且不超过 %d 字节", index, MaxKeyIDBytes)
		}
		if _, exists := spent[entry.KeyID]; exists {
			return Result{}, newError(CodeDuplicateKey, "keyId 重复：%s", entry.KeyID)
		}
		micros, err := strconv.ParseInt(entry.SpentMicros, 10, 64)
		if err != nil || micros < 0 {
			return Result{}, newError(CodeInvalidAmount,
				"第 %d 条记录的 spentMicros 必须是非负十进制整数微元（收到 %q）", index, entry.SpentMicros)
		}
		spent[entry.KeyID] = micros
	}

	now := c.now()
	c.mu.Lock()
	defer c.mu.Unlock()
	current := c.snap.Load()
	if current != nil {
		switch {
		case snapshot.Generation < current.generation:
			return Result{}, newError(CodeStaleSnapshot,
				"快照 generation 回退：当前 %d，收到 %d", current.generation, snapshot.Generation)
		case snapshot.Generation == current.generation:
			if snapshot.Revision != current.revision {
				return Result{}, newError(CodeStaleSnapshot,
					"快照 generation 相同但内容不同：当前 revision %s，收到 %s", current.revision, snapshot.Revision)
			}
			return Result{
				Ready:      true,
				Revision:   current.revision,
				Generation: current.generation,
				Entries:    len(current.spent),
				UpdatedAt:  current.updatedAt,
			}, nil
		}
	}

	next := &compiled{
		revision:   snapshot.Revision,
		generation: snapshot.Generation,
		spent:      spent,
		updatedAt:  now,
	}
	c.snap.Store(next)
	return Result{
		Ready:      true,
		Revision:   next.revision,
		Generation: next.generation,
		Entries:    len(next.spent),
		UpdatedAt:  next.updatedAt,
	}, nil
}

// Ready 表示是否已经收到过至少一份合法快照（合法的**空**快照也算就绪）。
func (c *Cache) Ready() bool {
	if c == nil {
		return false
	}
	return c.snap.Load() != nil
}

// Lookup 返回某个 key 的累计消费微元。快照里没有这个 key 时 ok=false。
func (c *Cache) Lookup(keyID string) (int64, bool) {
	if c == nil || keyID == "" {
		return 0, false
	}
	snapshot := c.snap.Load()
	if snapshot == nil {
		return 0, false
	}
	value, ok := snapshot.spent[keyID]
	return value, ok
}

// Age 返回当前快照的年龄；还没有快照时返回 0。
func (c *Cache) Age() time.Duration {
	if c == nil {
		return 0
	}
	snapshot := c.snap.Load()
	if snapshot == nil {
		return 0
	}
	age := c.now().Sub(snapshot.updatedAt)
	if age < 0 {
		return 0
	}
	return age
}

// Stale 表示快照不可用：没收到过快照，或年龄超过 TTL。
func (c *Cache) Stale() bool {
	if c == nil {
		return true
	}
	snapshot := c.snap.Load()
	if snapshot == nil {
		return true
	}
	return c.Age() > c.ttl
}

// State 返回不含金额明细的健康度快照。
func (c *Cache) State() State {
	if c == nil {
		return State{}
	}
	snapshot := c.snap.Load()
	if snapshot == nil {
		return State{Ready: false, Size: 0, AgeMs: 0, TtlMs: c.ttl.Milliseconds()}
	}
	updatedAt := snapshot.updatedAt
	return State{
		Ready:      true,
		Revision:   snapshot.revision,
		Generation: snapshot.generation,
		Size:       len(snapshot.spent),
		UpdatedAt:  &updatedAt,
		AgeMs:      c.Age().Milliseconds(),
		TtlMs:      c.ttl.Milliseconds(),
	}
}
