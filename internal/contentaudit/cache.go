// Package contentaudit 是内容审核规则快照的只读缓存。
//
// 边界（AGENTS.md §2.3 / §2.4）：
//   - **只读**：规则由 TS 侧 `content-audit` 插件唯一持有，经桥命令
//     `contentaudit.replace` 心跳式推过来；本包不改规则、不落盘、不回写。
//   - 整份校验：任一条规则不合法就整份拒绝，绝不「跳过坏的那条继续用旧规则」——
//     审核规则只认一份完整、可信的快照。
//   - `generation` 回退明确拒绝且不覆盖：乱序到达的旧快照不能把新规则顶掉。
//   - 匹配是**大小写不敏感的子串**，规则在 Replace 时就预编译成小写，请求路径上没有正则、
//     没有每次 ToLower 规则表。
package contentaudit

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const (
	// SnapshotVersion 是快照版本（TS 与 Go 必须一致）。
	SnapshotVersion = 1
	// DefaultTTL 是未显式配置时的快照有效期；组合根默认按 3 × TS 推送间隔设置。
	DefaultTTL = 15 * time.Second
	// MaxRules 是一份快照最多几条规则（防御性上限，防止一份巨型快照拖慢匹配）。
	MaxRules = 500
	// MaxPatternBytes 是单条 pattern 的字节上限。
	MaxPatternBytes = 200
	// MaxRuleIDBytes 是规则 id 的字节上限。
	MaxRuleIDBytes = 64
	// MaxRevisionBytes 是 revision 的字节上限。
	MaxRevisionBytes = 128
	// MaxCategoryBytes 是 category 的字节上限。
	MaxCategoryBytes = 64
)

// Action 是命中规则后的动作。
type Action string

const (
	// ActionBlock 表示命中即拒绝请求（403、不可重试）。
	ActionBlock Action = "block"
	// ActionLog 表示命中只记日志与计数，请求照常放行。
	ActionLog Action = "log"
)

// Rule 是一条审核规则（来自 TS，Go 侧只读）。
type Rule struct {
	ID       string `json:"id"`
	Pattern  string `json:"pattern"`
	Action   Action `json:"action"`
	Category string `json:"category,omitempty"`
}

// Snapshot 是桥命令 contentaudit.replace 的请求体。
//
// Enabled=false 表示「审核整体关闭」：TS 会推空规则，Go 侧立刻回到全放行。
type Snapshot struct {
	Version    int    `json:"version"`
	Generation int64  `json:"generation"`
	Revision   string `json:"revision"`
	Enabled    bool   `json:"enabled"`
	Rules      []Rule `json:"rules"`
}

// Result 是 Replace 的返回（不含规则内容）。
type Result struct {
	Ready      bool      `json:"ready"`
	Revision   string    `json:"revision"`
	Generation int64     `json:"generation"`
	Rules      int       `json:"rules"`
	Enabled    bool      `json:"enabled"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// State 是桥命令 contentaudit.status 的响应：只给健康度，不给规则内容。
type State struct {
	Ready      bool       `json:"ready"`
	Revision   string     `json:"revision,omitempty"`
	Generation int64      `json:"generation,omitempty"`
	Size       int        `json:"size"`
	Enabled    bool       `json:"enabled"`
	UpdatedAt  *time.Time `json:"updatedAt,omitempty"`
	AgeMs      int64      `json:"ageMs"`
	TtlMs      int64      `json:"ttlMs"`
	// Stale 为真表示快照已过期（严格模式下闸门会拒绝）。
	Stale bool `json:"stale,omitempty"`
	// Gate 是内容审核闸门的计数与命中统计（只增不改，omitempty）。
	Gate *GateState `json:"gate,omitempty"`
}

// Error 是带稳定码的领域错误。
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

const (
	// CodeInvalidSnapshot 表示快照结构或规则不合法（整份拒绝）。
	CodeInvalidSnapshot = "CONTENT_AUDIT_INVALID_SNAPSHOT"
	// CodeStaleSnapshot 表示 generation 回退或同代内容冲突（不覆盖）。
	CodeStaleSnapshot = "CONTENT_AUDIT_STALE_SNAPSHOT"
	// CodeDuplicatePattern 表示同一份快照里 pattern 重复。
	CodeDuplicatePattern = "CONTENT_AUDIT_DUPLICATE_PATTERN"
)

func newError(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Option 是缓存的构造选项。
type Option func(*Cache)

// WithTTL 覆盖快照有效期。
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

// compiled 是一份已校验的快照（不可变，配合 atomic.Pointer 无锁读）。
type compiled struct {
	revision   string
	generation int64
	enabled    bool
	rules      []compiledRule
	updatedAt  time.Time
}

type compiledRule struct {
	id       string
	pattern  string // 已转小写
	action   Action
	category string
}

// Cache 是线程安全的规则快照缓存。零值不可用，请用 New 构造。
type Cache struct {
	snap atomic.Pointer[compiled]
	mu   sync.Mutex // 只保护 Replace 的「读当前 + 比对 + 落库」，读路径无锁
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

// Replace 校验并原子替换快照。
//
// 拒绝回退：新快照的 generation 小于当前已应用的 generation 时明确失败（不覆盖）；
// 相等时只有 revision 完全一致才按幂等成功处理，否则也失败。
func (c *Cache) Replace(snapshot Snapshot) (Result, error) {
	if c == nil {
		return Result{}, newError(CodeInvalidSnapshot, "内容审核快照缓存不可用")
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
	if len(snapshot.Rules) > MaxRules {
		return Result{}, newError(CodeInvalidSnapshot,
			"一份快照最多 %d 条规则，收到 %d", MaxRules, len(snapshot.Rules))
	}

	seenIDs := make(map[string]struct{}, len(snapshot.Rules))
	seenPatterns := make(map[string]struct{}, len(snapshot.Rules))
	rules := make([]compiledRule, 0, len(snapshot.Rules))
	for index, rule := range snapshot.Rules {
		if rule.ID == "" || len(rule.ID) > MaxRuleIDBytes {
			return Result{}, newError(CodeInvalidSnapshot,
				"第 %d 条规则的 id 必填且不超过 %d 字节", index, MaxRuleIDBytes)
		}
		if _, exists := seenIDs[rule.ID]; exists {
			return Result{}, newError(CodeInvalidSnapshot, "规则 id 重复：%s", rule.ID)
		}
		seenIDs[rule.ID] = struct{}{}

		pattern := strings.TrimSpace(rule.Pattern)
		if pattern == "" || len(pattern) > MaxPatternBytes {
			return Result{}, newError(CodeInvalidSnapshot,
				"规则 %s 的 pattern 必填且不超过 %d 字节", rule.ID, MaxPatternBytes)
		}
		lower := strings.ToLower(pattern)
		if _, exists := seenPatterns[lower]; exists {
			return Result{}, newError(CodeDuplicatePattern, "规则 pattern 重复：%s", rule.ID)
		}
		seenPatterns[lower] = struct{}{}

		switch rule.Action {
		case ActionBlock, ActionLog:
		default:
			return Result{}, newError(CodeInvalidSnapshot,
				"规则 %s 的 action 只能是 block / log（收到 %q）", rule.ID, rule.Action)
		}
		if len(rule.Category) > MaxCategoryBytes {
			return Result{}, newError(CodeInvalidSnapshot,
				"规则 %s 的 category 不超过 %d 字节", rule.ID, MaxCategoryBytes)
		}
		rules = append(rules, compiledRule{
			id:       rule.ID,
			pattern:  lower,
			action:   rule.Action,
			category: rule.Category,
		})
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
				Rules:      len(current.rules),
				Enabled:    current.enabled,
				UpdatedAt:  current.updatedAt,
			}, nil
		}
	}

	next := &compiled{
		revision:   snapshot.Revision,
		generation: snapshot.Generation,
		enabled:    snapshot.Enabled,
		rules:      rules,
		updatedAt:  now,
	}
	c.snap.Store(next)
	return Result{
		Ready:      true,
		Revision:   next.revision,
		Generation: next.generation,
		Rules:      len(next.rules),
		Enabled:    next.enabled,
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

// Stale 表示快照是否已经超过 TTL（没有快照时也算 stale）。
func (c *Cache) Stale() bool {
	if c == nil || !c.Ready() {
		return true
	}
	if c.ttl <= 0 {
		return false
	}
	return c.Age() > c.ttl
}

// Enabled 报告快照里审核是否开启（没有快照时为 false）。
func (c *Cache) Enabled() bool {
	if c == nil {
		return false
	}
	snapshot := c.snap.Load()
	return snapshot != nil && snapshot.enabled
}

// Match 用当前规则匹配一组文本，返回命中的规则（按规则 id 去重，不含被审文本）。
//
// 审核关闭或没有快照时返回 nil。匹配是大小写不敏感的子串：文本只 ToLower 一次，
// 规则在 Replace 时已预编译成小写。
func (c *Cache) Match(texts []string) []contracts.ContentAuditHit {
	if c == nil || len(texts) == 0 {
		return nil
	}
	snapshot := c.snap.Load()
	if snapshot == nil || !snapshot.enabled || len(snapshot.rules) == 0 {
		return nil
	}
	lowered := make([]string, 0, len(texts))
	for _, text := range texts {
		if text == "" {
			continue
		}
		lowered = append(lowered, strings.ToLower(text))
	}
	if len(lowered) == 0 {
		return nil
	}

	hits := make([]contracts.ContentAuditHit, 0, 2)
	seen := make(map[string]struct{}, 2)
	for _, rule := range snapshot.rules {
		if _, done := seen[rule.id]; done {
			continue
		}
		for _, text := range lowered {
			if strings.Contains(text, rule.pattern) {
				seen[rule.id] = struct{}{}
				hits = append(hits, contracts.ContentAuditHit{RuleID: rule.id, Action: string(rule.action), Category: rule.category})
				break
			}
		}
	}
	if len(hits) == 0 {
		return nil
	}
	return hits
}

// State 返回不含规则内容的健康度快照。
func (c *Cache) State() State {
	if c == nil {
		return State{}
	}
	snapshot := c.snap.Load()
	if snapshot == nil {
		return State{Ready: false, Size: 0, AgeMs: 0, TtlMs: c.ttl.Milliseconds()}
	}
	updatedAt := snapshot.updatedAt
	state := State{
		Ready:      true,
		Revision:   snapshot.revision,
		Generation: snapshot.generation,
		Size:       len(snapshot.rules),
		Enabled:    snapshot.enabled,
		UpdatedAt:  &updatedAt,
		AgeMs:      c.Age().Milliseconds(),
		TtlMs:      c.ttl.Milliseconds(),
	}
	state.Stale = c.ttl > 0 && state.AgeMs > c.ttl.Milliseconds()
	return state
}

// IsError 报告错误是否是本包的领域错误（测试与桥层用）。
func IsError(err error, code string) bool {
	var typed *Error
	return errors.As(err, &typed) && typed.Code == code
}

// GateState 是内容审核闸门的计数与命中统计（不含任何被审文本）。
//
// 它是桥命令 contentaudit.status 的纯增量字段：没有注入闸门阶段时整键不出现。
type GateState struct {
	Blocked      int            `json:"blocked,omitempty"`
	Logged       int            `json:"logged,omitempty"`
	AllowedStale int            `json:"allowedStale,omitempty"`
	StrictFailed int            `json:"strictFailed,omitempty"`
	ParseFailed  int            `json:"parseFailed,omitempty"`
	NoText       int            `json:"noText,omitempty"`
	Truncated    int            `json:"truncated,omitempty"`
	StaleStreak  int            `json:"staleStreak,omitempty"`
	StaleReason  string         `json:"staleReason,omitempty"`
	StaleForMs   int64          `json:"staleForMs,omitempty"`
	RuleHitTotal int            `json:"ruleHitTotal,omitempty"`
	RuleHits     map[string]int `json:"ruleHits,omitempty"`
}
