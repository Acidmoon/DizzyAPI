// Package contracts 是 Go 侧唯一允许被所有模块 import 的包（AGENTS.md D4）。
//
// 它只依赖标准库：一旦这里引入第三方库，它就会变成耦合漏斗。
// 跨模块 DTO 放这里；模块私有类型留在各自模块内。
package contracts

import (
	"context"
	"time"
)

// Phase 是 LLM 请求链路的相位。相位必须显式，不能是一条平铺的列表：
// dispatch 内部会做失败转移循环，而 post 必须在所有出口恰好执行一次（AGENTS.md §6）。
type Phase uint8

const (
	// PhasePre 在上游派发之前执行。
	PhasePre Phase = iota
	// PhaseDispatch 是上游调用本身，失败转移循环发生在它内部。
	PhaseDispatch
	// PhasePost 在结算、记账、通知阶段执行。
	PhasePost
)

func (p Phase) String() string {
	switch p {
	case PhasePre:
		return "pre"
	case PhaseDispatch:
		return "dispatch"
	case PhasePost:
		return "post"
	default:
		return "unknown"
	}
}

// Action 表示一个阶段跑完之后链路该做什么。
type Action uint8

const (
	// ActionContinue 表示继续下一个阶段。
	ActionContinue Action = iota
	// ActionRespond 表示由当前阶段直接给出响应。模块不自己写 HTTP，
	// 它只把响应内容交给 engine 统一渲染（AGENTS.md §2.4）。
	ActionRespond
)

// Decision 是阶段交给 engine 的决定。
type Decision struct {
	Action  Action
	Status  int
	Headers map[string]string
	Body    []byte
}

// RequestMeta 是 LLM 请求的小上下文：不含全量 body，几百字节量级。
type RequestMeta struct {
	Model    string            `json:"model,omitempty"`
	Stream   bool              `json:"stream,omitempty"`
	Provider string            `json:"provider,omitempty"`
	Strategy string            `json:"strategy,omitempty"`
	Tags     map[string]string `json:"tags,omitempty"`
}

// Ctx 只用于 LLM 请求作用域（AGENTS.md §2.3）：
// 它绑定客户端生命周期、随断连取消；控制消息不得复用它。
type Ctx struct {
	context.Context

	ReqID string
	Meta  RequestMeta

	// AccountCandidates 是账号池快照，由上游模块（将来的 account-state）填入。
	// 本阶段只读它，不修改、不持久化。
	AccountCandidates []AccountCandidate

	// AccountRoute 是本阶段的输出：排好序的账号与最终选中的那一个。
	AccountRoute *AccountRoute
}

// Stage 是阶段型模块的最小接口（AGENTS.md §5.1）。
// 接口由消费者定义，实现者不需要声明 implements。
type Stage interface {
	Name() string
	Phase() Phase
	Required() bool
	NeedBody() bool
	Run(*Ctx) (Decision, error)
}

// Registry 是组合根用来装配模块的注册表（AGENTS.md D4）。
// 去模块化 = 在 cmd/gatewayd/main.go 去掉一行 Register 调用。
type Registry struct {
	services map[string]any
	stages   []Stage
}

// NewRegistry 创建一个空注册表。
func NewRegistry() *Registry {
	return &Registry{services: make(map[string]any)}
}

// Service 注册一个能力型服务。
func (r *Registry) Service(name string, impl any) {
	r.services[name] = impl
}

// Stage 注册一个阶段。顺序按注册顺序保留。
func (r *Registry) Stage(stage Stage) {
	r.stages = append(r.stages, stage)
}

// Services 返回服务表。调用方不得修改返回的 map。
func (r *Registry) Services() map[string]any {
	return r.services
}

// Lookup 按名字取一个能力型服务。消费者拿到实例后按自己声明的接口做类型断言，
// 例如 contracts.AccountScorer。
func (r *Registry) Lookup(name string) (any, bool) {
	impl, ok := r.services[name]
	return impl, ok
}

// Stages 返回已注册的阶段。
func (r *Registry) Stages() []Stage {
	return r.stages
}

// HealthState 是账号健康状态。未知必须是一等状态，而不是「默认健康」（AGENTS.md D17）。
type HealthState string

const (
	HealthUnknown   HealthState = "unknown"
	HealthHealthy   HealthState = "healthy"
	HealthDegraded  HealthState = "degraded"
	HealthUnhealthy HealthState = "unhealthy"
)

// AccountCandidate 是账号池中的一个可评分候选。
//
// 它**不是**账号的权威记录：账号身份由 identity 管，运行时状态由 account-state 管。
// 这里只是这两者在本阶段的一次快照。可空字段用指针表达「未知」，
// 零值不能被误读成「已知的 0」。
type AccountCandidate struct {
	AccountID     string            `json:"accountId"`
	Provider      string            `json:"provider"`
	Kind          string            `json:"kind,omitempty"`
	Disabled      bool              `json:"disabled,omitempty"`
	Priority      int               `json:"priority,omitempty"`
	Weight        *float64          `json:"weight,omitempty"`
	Health        HealthState       `json:"health,omitempty"`
	Tags          map[string]string `json:"tags,omitempty"`
	CooldownUntil *time.Time        `json:"cooldownUntil,omitempty"`

	QuotaRatio     *float64 `json:"quotaRatio,omitempty"`
	RateLimitRatio *float64 `json:"rateLimitRatio,omitempty"`

	InFlight    int `json:"inFlight,omitempty"`
	Concurrency int `json:"concurrency,omitempty"`

	LastUsedAt     *time.Time `json:"lastUsedAt,omitempty"`
	SuccessRate    *float64   `json:"successRate,omitempty"`
	LatencyP95Ms   *float64   `json:"latencyP95Ms,omitempty"`
	CostMultiplier *float64   `json:"costMultiplier,omitempty"`
}

// ScoreFactor 是一个打分因子的可解释明细。
type ScoreFactor struct {
	Name         string   `json:"name"`
	Raw          *float64 `json:"raw"`
	Normalized   float64  `json:"normalized"`
	Weight       float64  `json:"weight"`
	Contribution float64  `json:"contribution"`
}

// ScoredAccount 是一个候选的最终得分。
type ScoredAccount struct {
	AccountID string        `json:"accountId"`
	Score     float64       `json:"score"`
	Breakdown []ScoreFactor `json:"breakdown"`
}

// ExcludedAccount 是被硬过滤掉的候选。策略预览要能回答「为什么没选它」。
type ExcludedAccount struct {
	AccountID string `json:"accountId"`
	Reason    string `json:"reason"`
}

// ScoreResult 是一次打分的结果。Ranked 只含通过过滤的账号，按分数从高到低。
type ScoreResult struct {
	Strategy    string            `json:"strategy"`
	Revision    string            `json:"revision"`
	EvaluatedAt time.Time         `json:"evaluatedAt"`
	Ranked      []ScoredAccount   `json:"ranked"`
	Excluded    []ExcludedAccount `json:"excluded,omitempty"`
}

// ScoreRequest 是一次打分请求。它既是 account-priority 模块的输入，
// 也是桥上 preview / pick 的参数形状。
type ScoreRequest struct {
	Strategy   string             `json:"strategy,omitempty"`
	Candidates []AccountCandidate `json:"candidates"`
	// Limit 只收窄返回的 Ranked 长度；0 表示不额外限制。
	Limit int `json:"limit,omitempty"`
	// Now 是评分基准时间；为空取当前时间。测试用它固定冷却与新鲜度。
	Now *time.Time `json:"now,omitempty"`
	// Seed 用于 weighted-random 的可复现选择；0 表示按当前时间取种子。
	Seed uint64 `json:"seed,omitempty"`
}

// AccountScorer 是 account-priority 暴露给其他 Go 模块的进程内能力面。
//
// 消费者也可以在自己的模块里声明更小的接口；这里给的是规范面，
// 让「只 import contracts」的模块不必知道 account-priority 的实现包。
// 通过 Registry.Lookup("account-priority") 取到实例后做类型断言。
type AccountScorer interface {
	Score(ScoreRequest) (ScoreResult, error)
	Pick(ScoreRequest) (*ScoredAccount, error)
}

// AccountRoute 是账号优先级阶段写进 Ctx 的输出。
type AccountRoute struct {
	Strategy string          `json:"strategy"`
	Ranked   []ScoredAccount `json:"ranked"`
	Picked   *ScoredAccount  `json:"picked,omitempty"`
}
