// Package contracts 是 Go 侧唯一允许被所有模块 import 的包（AGENTS.md D4）。
//
// 它只依赖标准库：一旦这里引入第三方库，它就会变成耦合漏斗。
// 跨模块 DTO 放这里；模块私有类型留在各自模块内。
package contracts

import (
	"context"
	"fmt"
	"io"
	"net/http"
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
//
// 流式响应放在 Stream（engine/handler 负责关闭）；非流式响应放 Body。
// 模块仍然不直接写 HTTP：渲染与写出都由 engine 那一侧完成。
type Decision struct {
	Action  Action
	Status  int
	Headers map[string]string
	Body    []byte
	Stream  io.ReadCloser
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

	// Headers 是客户端发来的 LLM 请求头。它可能包含 Authorization（网关密钥），
	// 阶段不得整体记录或转发；transport 只按白名单复制。
	Headers http.Header
	// Body 是请求体的惰性读口；只有 NeedBody() 的阶段才允许取。
	Body BodyProvider

	// Key / Profile 由 key-auth 阶段写入。Profile 目前只是标签：
	// 描述符与多 profile 编排尚未实现（§6）。
	Key     *APIKey
	Profile string

	// AccountCandidates 是账号池快照。当前由 HTTP 入口从 internal/accounts 的
	// identity 快照填充；将来的 account-state 会补上运行时状态。本阶段只读它，
	// 不修改、不持久化。
	AccountCandidates []AccountCandidate

	// AccountRoute 是本阶段的输出：排好序的账号与最终选中的那一个。
	AccountRoute *AccountRoute

	// Attempts 是 dispatch 阶段的失败转移记录（账号 id + 状态码/错误码）。
	// 不含秘密，可安全写入日志。
	Attempts []AccountAttempt

	// ClientProtocol 是 HTTP 入口按路由写入的客户端协议。
	// 空 = 旧路径 / 未知（此时不做任何协议转换，直接透传）。
	ClientProtocol Protocol

	// Upstream 是转换阶段写下的「真正要发给上游的请求」。
	// nil = 直通：transport 直接用 Body 的原始字节。
	//
	// 每个 attempt 都必须显式写它（含置 nil）：engine 的失败转移循环会重跑
	// dispatch 阶段，残留上一次的结果就会发错请求体。
	Upstream *UpstreamRequest
}

// UpstreamRequest 是协议转换阶段交给 transport 的上游请求。
//
// Body 已是上游协议格式的字节；Lossy 记录转换中发生的有损映射。
type UpstreamRequest struct {
	Protocol Protocol
	Body     []byte
	Lossy    []LossyNote
}

// UpstreamResponse 是 transport 取到的、需要交给 transcoder 转换的上游响应。
//
// 流式响应放 Stream（transcoder 负责关闭）；非流式放 Body。
type UpstreamResponse struct {
	Status  int
	Headers map[string]string
	Body    []byte
	Stream  io.ReadCloser
}

// ResponseTranscoder 把上游协议的响应转成客户端协议。
//
// 它由 protoconv 实现，transport 在「上游协议与客户端协议不同」时调用。
// 接口由消费者定义（AGENTS.md §2.3）。
type ResponseTranscoder interface {
	TranscodeResponse(ctx *Ctx, up UpstreamResponse) (Decision, error)
}

// BodyProvider 让请求体只在真正需要时被读出来。
type BodyProvider interface {
	// Bytes 返回完整请求体；实现可以把读取错误推迟到这里。
	Bytes() ([]byte, error)
	// Size 返回 Content-Length；未知时返回 -1。
	Size() int64
}

// BytesBody 是一个已经读进内存的 BodyProvider。
type BytesBody []byte

func (b BytesBody) Bytes() ([]byte, error) { return b, nil }
func (b BytesBody) Size() int64            { return int64(len(b)) }

// APIKey 是 key-auth 阶段解析出的调用方身份。
//
// 静态环境变量 key / 开发占位模式只填 ID（密钥指纹）与 Profile；
// 控制桥推来的动态 key 快照命中时填 KeyID / UserID / Name / Profile。
// 新增字段保持零值兼容：不读 KeyID 的消费者不受影响。
type APIKey struct {
	ID string `json:"id"`
	// UserID 是用户 id 的十进制字符串。静态 key 为空——它没有 key→user 映射。
	UserID string `json:"userId,omitempty"`
	// KeyID 与 ID 同义；显式命名是为了让结算 / 用量模块不必猜 ID 的含义。
	KeyID   string `json:"keyId,omitempty"`
	Name    string `json:"name,omitempty"`
	Profile string `json:"profile,omitempty"`
}

// APIKeyRecord 是 key-auth 从只读 key 快照校验出的一条命中记录。
//
// UserID 用十进制字符串而不是 int64：TS 侧用户 id 是数字，Go 侧跨模块只需要
// 一个稳定标识；字符串避免为「数字 vs 字符串」再造一层 JSON 兼容。
type APIKeyRecord struct {
	KeyID   string
	UserID  string
	Name    string
	Profile string
}

// APIKeyVerifier 是 key-auth 对只读 key 快照的最小依赖。
// 接口由消费者定义；实现（internal/apikeys）只提供校验、计数与就绪状态。
type APIKeyVerifier interface {
	Verify(presented string) (APIKeyRecord, bool)
	// Count 是当前快照里的 key 数，只用于展示与日志，不用于判断是否启用动态模式。
	Count() int
	// Ready 表示是否已经收到过至少一份 keys.replace 快照。
	//
	// 它必须与 Count 分开：合法的空快照（用户删光 key / 全部停用 / 用户封禁）
	// 也意味着「动态模式已接管」，此时 Count==0 必须拒绝全部 key，
	// 绝不能退回静态 key 或占位模式（D7：默认 deny，fail-closed）。
	Ready() bool
}

// AccountAttempt 是一次上游派发尝试的事实记录。
type AccountAttempt struct {
	AccountID string `json:"accountId"`
	Status    int    `json:"status,omitempty"`
	Code      string `json:"code,omitempty"`
}

// AccountCredential 是 transport 发请求所需的账号材料（含访问令牌）。
//
// 它只存在于 Go 进程内：不得写入日志、HTTP 响应或桥响应。
// 权威数据在 identity（TS）；Go 持有的是一份只读内存快照。
type AccountCredential struct {
	AccountID   string
	Provider    string
	Kind        string
	BaseURL     string
	AccessToken string
	ExpiresAt   *time.Time
	// Protocol 是该账号声明的上游协议（openai-chat / openai-responses / anthropic）。
	// 空 = 旧快照（未声明协议）：transport 走 Config.Path 回退，不做协议转换。
	Protocol string
}

// CredentialSource 是 transport 对账号快照缓存的最小依赖。
// 接口由消费者定义；实现（内存缓存）在 internal/accounts。
type CredentialSource interface {
	Credential(accountID string) (AccountCredential, bool)
}

// StageError 是阶段返回的、可安全渲染给用户并可安全记日志的错误。
//
// Message 必须是脱敏后的文本：不得包含请求体、Authorization、访问令牌或
// 上游原始错误里可能回显的秘密。engine 只渲染这类错误与 PublicError。
type StageError struct {
	Status    int
	Code      string
	Message   string
	Retryable bool
}

func (e *StageError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// ErrorCode / HTTPStatus / PublicMessage 让错误可以走 PublicError 路径。
func (e *StageError) ErrorCode() string     { return e.Code }
func (e *StageError) HTTPStatus() int       { return e.Status }
func (e *StageError) PublicMessage() string { return e.Message }
func (e *StageError) CanRetry() bool        { return e.Retryable }

// Errorf 构造一个 StageError。
func Errorf(status int, code, format string, args ...any) *StageError {
	return &StageError{Status: status, Code: code, Message: fmt.Sprintf(format, args...)}
}

// PublicError 是模块自定义错误可以实现的「可安全外露」契约。
// 不实现它的错误一律按内部错误处理，消息不会返回给用户。
type PublicError interface {
	error
	ErrorCode() string
	HTTPStatus() int
	PublicMessage() string
}

// RetryableError 表示同一次 LLM 请求可以换下一个账号再试。
// transport 的上游 5xx / 429 / 网络失败属于这一类。
type RetryableError interface {
	error
	CanRetry() bool
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
