// Package quota 是 Go 侧的**余额只读快照**缓存。
//
// 权威数据在 TS 的 user 插件（SQLite，唯一写者）；它经控制桥把「用户 id → 余额微元」
// 整份推过来。本包只校验、原子替换、提供 O(1) 查询；不写钱、不落盘、不回写 TS。
//
// 金额一律整数微元（1 元 = 1_000_000）。线上用十进制字符串承载：JSON 不承载
// bigint，也绝不经过浮点。余额允许为负（后付费透支），所以不能按无符号解析。
package quota

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
	// MaxEntries 一份快照最多容纳的用户数。
	MaxEntries = 1_000_000
	// MaxUserIDBytes / MaxRevisionBytes 是字段长度上限。
	MaxUserIDBytes   = 64
	MaxRevisionBytes = 128
)

// 稳定错误码；桥会原样转发给 TS。
const (
	CodeInvalidSnapshot = "QUOTA_INVALID_SNAPSHOT"
	CodeInvalidBalance  = "QUOTA_INVALID_BALANCE"
	CodeDuplicateUser   = "QUOTA_DUPLICATE_USER"
	CodeStaleSnapshot   = "QUOTA_SNAPSHOT_STALE"
)

// Snapshot 是 TS 推来的完整余额快照。任何一条不合法就整份拒绝，绝不部分应用。
type Snapshot struct {
	Version int `json:"version"`
	// Generation 是 TS 侧单调递增的推送序号（毫秒时间戳量级）。它只用于拒绝回退，
	// 不参与业务判断：快照乱序到达时宁可拒绝，也不要让旧余额覆盖新余额。
	Generation int64 `json:"generation"`
	// Revision 是 entries 的内容哈希，用于日志与幂等重试识别。
	Revision string  `json:"revision"`
	Entries  []Entry `json:"entries"`
}

// Entry 是一个用户的余额。BalanceMicros 是十进制字符串（可负）。
type Entry struct {
	UserID        string `json:"userId"`
	BalanceMicros string `json:"balanceMicros"`
}

// Result 是 Replace 的返回：不含任何余额值。
type Result struct {
	Ready      bool      `json:"ready"`
	Revision   string    `json:"revision"`
	Generation int64     `json:"generation"`
	Entries    int       `json:"entries"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// State 是桥命令 quota.status 的响应：只给健康度，不给账号级余额明细。
type State struct {
	Ready      bool       `json:"ready"`
	Revision   string     `json:"revision,omitempty"`
	Generation int64      `json:"generation,omitempty"`
	Size       int        `json:"size"`
	UpdatedAt  *time.Time `json:"updatedAt,omitempty"`
	AgeMs      int64      `json:"ageMs"`
	TtlMs      int64      `json:"ttlMs"`
	// Gate 是额度闸门的运行时观察（只增不改，omitempty）。
	//
	// 它回答「快照到底新不新鲜、闸门有没有真的在拦」：连续不可用次数与持续时长
	// 能把「偶发一次」与「一直失效」区分开——这正是 2026-10-29 生产事故里
	// 被日志节流藏住的信息。
	Gate *GateState `json:"gate,omitempty"`
}

// GateState 是额度闸门的计数与连续不可用观察（不含任何余额明细）。
type GateState struct {
	AllowedUnknown int    `json:"allowedUnknown,omitempty"`
	BlockedLow     int    `json:"blockedLow,omitempty"`
	StrictBlocked  int    `json:"strictBlocked,omitempty"`
	StaleStreak    int    `json:"staleStreak,omitempty"`
	StaleReason    string `json:"staleReason,omitempty"`
	StaleForMs     int64  `json:"staleForMs,omitempty"`
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

// compiled 是一份已校验的快照（不可变，配合 atomic.Pointer 无锁读）。
type compiled struct {
	revision   string
	generation int64
	balances   map[string]int64
	updatedAt  time.Time
}

// Option 是构造选项（只给单测用）。
type Option func(*Cache)

// WithTTL 设置快照的过期时长（严格模式下过期即拒绝）。
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

// Cache 是线程安全的余额快照缓存。零值不可用，请用 New 构造。
type Cache struct {
	snap atomic.Pointer[compiled]
	mu   sync.Mutex // 只保护 Replace 的「读当前 + 比对 + 落库」，读路径无锁
	ttl  time.Duration
	now  func() time.Time
}

// DefaultTTL 是未显式配置时的快照有效期；组合根默认按 3 × TS 推送间隔设置。
const DefaultTTL = 15 * time.Second

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

// Replace 校验并原子替换快照。
//
// 拒绝回退：新快照的 generation 小于当前已应用的 generation 时明确失败（不覆盖）；
// 相等时只有 revision 完全一致才按幂等成功处理（重试丢响应的情况），否则也失败。
func (c *Cache) Replace(snapshot Snapshot) (Result, error) {
	if c == nil {
		return Result{}, newError(CodeInvalidSnapshot, "余额快照缓存不可用")
	}
	if snapshot.Version != SnapshotVersion {
		return Result{}, newError(CodeInvalidSnapshot,
			"快照版本必须是 %d，收到 %d", SnapshotVersion, snapshot.Version)
	}
	if snapshot.Generation <= 0 {
		return Result{}, newError(CodeInvalidSnapshot, "快照 generation 必须为正数")
	}
	if snapshot.Revision == "" || len(snapshot.Revision) > MaxRevisionBytes {
		return Result{}, newError(CodeInvalidSnapshot,
			"快照 revision 必填且不超过 %d 字节", MaxRevisionBytes)
	}
	if len(snapshot.Entries) > MaxEntries {
		return Result{}, newError(CodeInvalidSnapshot,
			"一份快照最多 %d 个用户，收到 %d", MaxEntries, len(snapshot.Entries))
	}

	balances := make(map[string]int64, len(snapshot.Entries))
	for index, entry := range snapshot.Entries {
		if entry.UserID == "" || len(entry.UserID) > MaxUserIDBytes {
			return Result{}, newError(CodeInvalidSnapshot,
				"第 %d 条记录的 userId 必填且不超过 %d 字节", index, MaxUserIDBytes)
		}
		if !isDecimalUserID(entry.UserID) {
			return Result{}, newError(CodeInvalidSnapshot,
				"第 %d 条记录的 userId 必须是十进制数字串（收到 %q）", index, entry.UserID)
		}
		if _, exists := balances[entry.UserID]; exists {
			return Result{}, newError(CodeDuplicateUser, "userId 重复：%s", entry.UserID)
		}
		balance, err := strconv.ParseInt(entry.BalanceMicros, 10, 64)
		if err != nil {
			return Result{}, newError(CodeInvalidBalance,
				"第 %d 条记录的 balanceMicros 必须是十进制整数微元（收到 %q）", index, entry.BalanceMicros)
		}
		balances[entry.UserID] = balance
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
					"快照 generation 相同但内容不同：当前 revision %s，收到 %s",
					current.revision, snapshot.Revision)
			}
			// 幂等重试：同一版内容再推一次，直接回当前状态，不覆盖时间戳。
			return Result{
				Ready:      true,
				Revision:   current.revision,
				Generation: current.generation,
				Entries:    len(current.balances),
				UpdatedAt:  current.updatedAt,
			}, nil
		}
	}

	next := &compiled{
		revision:   snapshot.Revision,
		generation: snapshot.Generation,
		balances:   balances,
		updatedAt:  now,
	}
	c.snap.Store(next)
	return Result{
		Ready:      true,
		Revision:   next.revision,
		Generation: next.generation,
		Entries:    len(next.balances),
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

// Lookup 返回某用户的余额微元。快照里没有这个用户时 ok=false。
func (c *Cache) Lookup(userID string) (int64, bool) {
	if c == nil || userID == "" {
		return 0, false
	}
	snapshot := c.snap.Load()
	if snapshot == nil {
		return 0, false
	}
	balance, ok := snapshot.balances[userID]
	return balance, ok
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

// State 返回不含余额明细的健康度快照。
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
		Size:       len(snapshot.balances),
		UpdatedAt:  &updatedAt,
		AgeMs:      c.Age().Milliseconds(),
		TtlMs:      c.ttl.Milliseconds(),
	}
}

// isDecimalUserID 只接受十进制数字串：user id 在 TS 侧是整数，快照里用字符串承载。
func isDecimalUserID(value string) bool {
	for index := 0; index < len(value); index += 1 {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	return true
}
