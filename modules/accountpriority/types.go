// Package accountpriority 是号池的「选谁」阶段：对候选账号打分、排序、选中一个。
//
// 它只做策略计算：
//   - 账号身份与登录态归 identity（TS，将来按 D8 迁 Go）；
//   - 账号运行时状态（限流、额度、健康、冷却）归 account-state；
//   - 本模块把两者的一次快照作为输入，输出排序结果与选中项，不写任何账号状态。
//
// 策略组是配置驱动的：硬过滤 + 加权因子。Go 侧保留 Strategy 接口的形状，
// 将来要加代码型策略时不必推翻配置格式。
package accountpriority

import (
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Candidate 是账号池快照里的一个候选（跨模块 DTO 放在 contracts）。
type Candidate = contracts.AccountCandidate

const (
	// ServiceName 是注册表里的服务名，也是桥命令的前缀。
	ServiceName = "account-priority"
	// StageName 是描述符里的阶段名。
	StageName = "account-priority"

	// MaxStrategies 一次可配置的策略组上限。
	MaxStrategies = 64
	// MaxCandidates 一次打分请求可携带的候选上限。
	MaxCandidates = 10_000
	// MaxNameLength 策略名 / 描述的长度上限。
	MaxNameLength = 200
	// MaxDescriptionLength 策略描述的长度上限。
	MaxDescriptionLength = 2_000
)

// Config 是策略组的完整配置，由 TS 管理面推送（D8：TS 是这份数据的唯一写者）。
type Config struct {
	// DefaultStrategy 为空时取第一个启用的策略组。
	DefaultStrategy string          `json:"defaultStrategy,omitempty"`
	Strategies      []StrategyGroup `json:"strategies"`
}

// StrategyGroup 是一个命名策略组。
type StrategyGroup struct {
	ID          string                `json:"id"`
	Name        string                `json:"name,omitempty"`
	Description string                `json:"description,omitempty"`
	Enabled     *bool                 `json:"enabled,omitempty"`
	Filter      Filter                `json:"filter,omitempty"`
	Factors     map[string]FactorRule `json:"factors"`
	// Selection：rank（默认，取第一名）或 weighted-random（按分数加权随机）。
	Selection string `json:"selection,omitempty"`
	// TieBreaker 依次比较；默认 ["priority", "accountId"]。
	TieBreaker []string `json:"tieBreaker,omitempty"`
	// MaxCandidates 为 0 表示返回全部；请求里的 limit 会再收窄。
	MaxCandidates int `json:"maxCandidates,omitempty"`
}

// Filter 是硬过滤：不满足就完全不能进入打分。
type Filter struct {
	Providers []string          `json:"providers,omitempty"`
	Kinds     []string          `json:"kinds,omitempty"`
	Tags      map[string]string `json:"tags,omitempty"`
	// Health：exclude_unhealthy（默认，未知仍可参与）/ require_healthy / allow_all。
	Health string `json:"health,omitempty"`
	// ExcludeCooling 默认 true。
	ExcludeCooling *bool `json:"excludeCooling,omitempty"`
	// ExcludeSaturated 默认 true：在途数达到并发上限的账号不再进入打分。
	ExcludeSaturated *bool `json:"excludeSaturated,omitempty"`
}

// FactorRule 描述一个打分因子。
type FactorRule struct {
	// Weight 为 0 表示不启用该因子；所有权重都小于等于 0 的策略会被拒绝。
	Weight float64 `json:"weight"`
	// Direction 只对 min-max 因子有效：desc（默认，越大越好）/ asc（越小越好）。
	Direction string `json:"direction,omitempty"`
	// Unknown 是原始值未知时的归一化分数，默认 0.5。
	Unknown *float64 `json:"unknown,omitempty"`
}

// ScoreRequest 是跨模块的请求 DTO；实际定义在 contracts，这里只做别名。
type ScoreRequest = contracts.ScoreRequest

// Status 是模块运行期状态。
type Status struct {
	Ready           bool      `json:"ready"`
	Revision        string    `json:"revision"`
	DefaultStrategy string    `json:"defaultStrategy"`
	Strategies      int       `json:"strategies"`
	StartedAt       time.Time `json:"startedAt"`
	Scored          uint64    `json:"scored"`
	Picked          uint64    `json:"picked"`
	CandidatesMax   int       `json:"candidatesMax"`
}

// StrategyList 是管理面读取策略组的形状。
type StrategyList struct {
	Revision        string          `json:"revision"`
	DefaultStrategy string          `json:"defaultStrategy"`
	Strategies      []StrategyGroup `json:"strategies"`
}

// DefaultStrategy 是没有任何策略配置时使用的内置策略。
//
// 权重合计 100，便于人读；实际得分会再按权重总和归一化，
// 所以配置里不要求权重加起来等于 100。
func DefaultStrategy() StrategyGroup {
	enabled := true
	cooling := true
	saturated := true
	return StrategyGroup{
		ID:      "default",
		Name:    "默认",
		Enabled: &enabled,
		Filter: Filter{
			Health:           "exclude_unhealthy",
			ExcludeCooling:   &cooling,
			ExcludeSaturated: &saturated,
		},
		Factors: map[string]FactorRule{
			"health":    {Weight: 30, Unknown: floatPtr(0.3)},
			"quota":     {Weight: 20},
			"rateLimit": {Weight: 10},
			"headroom":  {Weight: 10},
			"priority":  {Weight: 10},
			"capacity":  {Weight: 10},
			"success":   {Weight: 5},
			"latency":   {Weight: 3, Direction: "asc"},
			"cost":      {Weight: 2, Direction: "asc"},
		},
		Selection:  "rank",
		TieBreaker: []string{"priority", "accountId"},
	}
}

func floatPtr(value float64) *float64 {
	return &value
}

func effectiveEnabled(group StrategyGroup) bool {
	return group.Enabled == nil || *group.Enabled
}

func effectiveBool(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}
