// Package pricing 是 Go 侧的**价格表只读快照**缓存（定价闸门用）。
//
// owner 第 10 条拍的是「真拒绝」：没配价格的模型不许请求。判定只需要知道
// 「这个模型有没有价」，所以这里缓存的是**模型名集合 + 兜底 `*` 是否存在**，
// 而不是把算钱逻辑搬进 Go —— 算钱仍然只在 TS 的 billing（一个数据一个写者）。
//
// 与 TS 侧的 `billing.hasPrice()` **同口径**：
//
//	pricing.get(model) !== null || pricing.get('*') !== null
//
// 两处口径不一致会出现「billing 认为有价、闸门认为没价」的分裂，所以两边各有用例钉住。
//
// 边界：纯内存、不落盘、不回写 TS；金额一律十进制字符串跨层（解析失败即整份拒绝）。
package pricing

import (
	"fmt"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// SnapshotVersion 是桥消息里的快照版本。只接受 1。
	SnapshotVersion = 1
	// MaxPrices 一份快照最多容纳的模型数。
	MaxPrices = 100_000
	// MaxModelBytes / MaxRevisionBytes 是字段长度上限。
	MaxModelBytes    = 200
	MaxRevisionBytes = 128
	// MaxPriceBytes 是单个单价的长度上限（十进制字符串）。
	MaxPriceBytes = 32
	// Wildcard 是兜底价的模型名：它存在时任何模型都算「有价」。
	Wildcard = "*"
)

// 稳定错误码；桥会原样转发给 TS。
const (
	CodeInvalidSnapshot = "PRICING_INVALID_SNAPSHOT"
	CodeInvalidPrice    = "PRICING_INVALID_PRICE"
	CodeDuplicateModel  = "PRICING_DUPLICATE_MODEL"
	CodeStaleSnapshot   = "PRICING_SNAPSHOT_STALE"
)

// pricePattern 只接受非负十进制数字串（可带小数）：单价是「元 / 百万 token」。
//
// 不允许指数、符号、千分位：Go 不解析金额的语义，但**形状**必须干净——
// 形状不干净的快照整份拒绝（fail-closed），不给「看起来有价」留空间。
var pricePattern = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?$`)

// Snapshot 是 TS 推来的完整价格快照。任何一条不合法就整份拒绝，绝不部分应用。
type Snapshot struct {
	Version    int   `json:"version"`
	Generation int64 `json:"generation"`
	// Revision 是 prices 的内容哈希，用于识别幂等重推。
	Revision string  `json:"revision"`
	Prices   []Price `json:"prices"`
}

// Price 是一个模型的四项单价（元 / 百万 token，十进制字符串）。
type Price struct {
	Model                string `json:"model"`
	InputPerMillion      string `json:"inputPerMillion"`
	OutputPerMillion     string `json:"outputPerMillion"`
	CacheReadPerMillion  string `json:"cacheReadPerMillion"`
	CacheWritePerMillion string `json:"cacheWritePerMillion"`
}

// Result 是 Replace 的返回：不含价格明细。
type Result struct {
	Ready      bool      `json:"ready"`
	Revision   string    `json:"revision"`
	Generation int64     `json:"generation"`
	Prices     int       `json:"prices"`
	Wildcard   bool      `json:"wildcard"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// State 是桥命令 pricing.status 的响应：只给健康度与闸门计数。
type State struct {
	Ready      bool       `json:"ready"`
	Revision   string     `json:"revision,omitempty"`
	Generation int64      `json:"generation,omitempty"`
	Size       int        `json:"size"`
	Wildcard   bool       `json:"wildcard,omitempty"`
	UpdatedAt  *time.Time `json:"updatedAt,omitempty"`
	AgeMs      int64      `json:"ageMs"`
	TtlMs      int64      `json:"ttlMs"`
	// Gate 是定价闸门的只增计数（omitempty：没有注入闸门时不出现）。
	Gate *GateState `json:"gate,omitempty"`
}

// GateState 是定价闸门的计数：回答「闸门到底有没有在拦」。
type GateState struct {
	Blocked       int `json:"blocked,omitempty"`
	StrictBlocked int `json:"strictBlocked,omitempty"`
	Allowed       int `json:"allowed,omitempty"`
	StaleStreak   int `json:"staleStreak,omitempty"`
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
	models     map[string]struct{}
	wildcard   bool
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

// Cache 是线程安全的价格快照缓存。零值不可用，请用 New 构造。
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
		return Result{}, newError(CodeInvalidSnapshot, "价格快照缓存不可用")
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
	if len(snapshot.Prices) > MaxPrices {
		return Result{}, newError(CodeInvalidSnapshot, "一份快照最多 %d 个模型，收到 %d", MaxPrices, len(snapshot.Prices))
	}

	models := make(map[string]struct{}, len(snapshot.Prices))
	wildcard := false
	for index, price := range snapshot.Prices {
		model := price.Model
		if model == "" || len(model) > MaxModelBytes {
			return Result{}, newError(CodeInvalidSnapshot,
				"第 %d 条记录的 model 必填且不超过 %d 字节", index, MaxModelBytes)
		}
		if _, exists := models[model]; exists {
			return Result{}, newError(CodeDuplicateModel, "模型重复：%s", model)
		}
		for field, value := range map[string]string{
			"inputPerMillion":      price.InputPerMillion,
			"outputPerMillion":     price.OutputPerMillion,
			"cacheReadPerMillion":  price.CacheReadPerMillion,
			"cacheWritePerMillion": price.CacheWritePerMillion,
		} {
			if len(value) > MaxPriceBytes || !pricePattern.MatchString(value) {
				return Result{}, newError(CodeInvalidPrice,
					"模型 %s 的 %s 必须是十进制数字串（收到 %q）", model, field, value)
			}
		}
		models[model] = struct{}{}
		if model == Wildcard {
			wildcard = true
		}
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
				Prices:     len(current.models),
				Wildcard:   current.wildcard,
				UpdatedAt:  current.updatedAt,
			}, nil
		}
	}

	next := &compiled{
		revision:   snapshot.Revision,
		generation: snapshot.Generation,
		models:     models,
		wildcard:   wildcard,
		updatedAt:  now,
	}
	c.snap.Store(next)
	return Result{
		Ready:      true,
		Revision:   next.revision,
		Generation: next.generation,
		Prices:     len(next.models),
		Wildcard:   next.wildcard,
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

// Priced 判断一个模型有没有价：精确命中，或存在兜底 `*`。
//
// 与 TS 的 `billing.hasPrice()` 同口径；模型名为空一律 false。
func (c *Cache) Priced(model string) bool {
	if c == nil || model == "" {
		return false
	}
	snapshot := c.snap.Load()
	if snapshot == nil {
		return false
	}
	if snapshot.wildcard {
		return true
	}
	_, ok := snapshot.models[model]
	return ok
}

// Wildcard 报告兜底价是否存在。
func (c *Cache) Wildcard() bool {
	if c == nil {
		return false
	}
	snapshot := c.snap.Load()
	return snapshot != nil && snapshot.wildcard
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

// State 返回不含价格明细的健康度快照。
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
		Size:       len(snapshot.models),
		Wildcard:   snapshot.wildcard,
		UpdatedAt:  &updatedAt,
		AgeMs:      c.Age().Milliseconds(),
		TtlMs:      c.ttl.Milliseconds(),
	}
}
