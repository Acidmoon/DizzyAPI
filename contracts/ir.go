// Package contracts —— LLM 协议转换的规范化中间表示（IR）。
//
// IR 是三个协议族（OpenAI Chat / OpenAI Responses / Anthropic Messages）的并集：
// 每个 codec 负责把自己的线上格式与 IR 互转。丢掉的语义必须通过 LossyNote 显式
// 记录，不允许静默丢弃。
//
// 本文件只依赖标准库（AGENTS.md §2.3）。
package contracts

import "encoding/json"

// Protocol 标识一条 LLM 请求/响应所讲的线上协议族。
//
// 空值（""）表示「未知 / 旧路径」：它既不是客户端协议，也不是上游协议。
type Protocol string

const (
	ProtocolOpenAIChat      Protocol = "openai-chat"
	ProtocolOpenAIResponses Protocol = "openai-responses"
	ProtocolAnthropic       Protocol = "anthropic"
	// ProtocolGemini 是预留值：v1 不注册 codec，也不接受它作为上游协议。
	ProtocolGemini Protocol = "gemini"
)

// IsOpenAI 报告该协议是否属于 OpenAI 兼容族（错误体形状相同）。
func (p Protocol) IsOpenAI() bool {
	return p == ProtocolOpenAIChat || p == ProtocolOpenAIResponses
}

// Role 是消息的说话方。IR 把 system 抽到 Request.System，
// Message.Role 只会是 user / assistant / tool。
type Role string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

// ContentKind 是一个内容片段的种类。
type ContentKind string

const (
	KindText       ContentKind = "text"
	KindThinking   ContentKind = "thinking"
	KindToolUse    ContentKind = "tool_use"
	KindToolResult ContentKind = "tool_result"
	KindImage      ContentKind = "image"
	// KindUnknown 是原样保留、无法归类的片段（放 Part.Raw）。
	KindUnknown ContentKind = "unknown"
)

// Part 是消息里的一个内容片段。只有与 Kind 相关的字段会被填充。
type Part struct {
	Kind ContentKind

	// text / thinking
	Text      string
	Signature string // Anthropic thinking 的 signature
	Redacted  bool   // Anthropic redacted_thinking

	// tool_use
	ToolCallID string
	ToolName   string
	ToolInput  json.RawMessage

	// tool_result
	ToolResultFor string
	IsError       bool

	// image
	MediaType string
	ImageURL  string // URL 或 data: base64

	// unknown：原样保留的片段
	Raw json.RawMessage
}

// Message 是对话中的一条消息（system 之外）。
type Message struct {
	Role       Role
	Name       string
	ToolCallID string
	Parts      []Part
}

// Tool 是一个可被模型调用的工具声明。
type Tool struct {
	Name        string
	Description string
	InputSchema json.RawMessage
	Strict      bool
}

// ToolChoiceMode 是工具选择模式。
type ToolChoiceMode string

const (
	ToolChoiceAuto     ToolChoiceMode = "auto"
	ToolChoiceNone     ToolChoiceMode = "none"
	ToolChoiceRequired ToolChoiceMode = "required"
	ToolChoiceTool     ToolChoiceMode = "tool"
)

// ToolChoice 是工具选择策略。Mode==tool 时 Name 指定唯一工具。
type ToolChoice struct {
	Mode ToolChoiceMode
	Name string
}

// ResponseFormat 是结构化输出要求。
type ResponseFormat struct {
	Type       string
	JSONSchema json.RawMessage
}

// Sampling 是采样参数。全用指针，区分「客户端没给」与「给了零值」。
type Sampling struct {
	Temperature      *float64
	TopP             *float64
	TopK             *int
	Stop             []string
	PresencePenalty  *float64
	FrequencyPenalty *float64
	Seed             *int64
	N                *int
	Logprobs         *bool
	TopLogprobs      *int
}

// Request 是一次规范化后的请求。
type Request struct {
	Model          string
	Stream         bool
	System         []Part
	Messages       []Message
	Tools          []Tool
	ToolChoice     *ToolChoice
	Sampling       Sampling
	MaxTokens      *int
	ResponseFormat *ResponseFormat
	User           string
	// Extras 保留 IR 未建模、但可能值得透传的原始字段。
	Extras map[string]json.RawMessage
	// Lossy 记录解析/渲染过程中发生的有损映射。
	Lossy []LossyNote
}

// StopReason 是规范化的停止原因。
type StopReason string

const (
	StopEndTurn       StopReason = "end_turn"
	StopMaxTokens     StopReason = "max_tokens"
	StopToolUse       StopReason = "tool_use"
	StopSequence      StopReason = "stop_sequence"
	StopContentFilter StopReason = "content_filter"
	StopUnknown       StopReason = "unknown"
)

// Usage 是规范化的用量。金额/计数一律整数（AGENTS.md §2.4）。
type Usage struct {
	InputTokens  int
	OutputTokens int
	// CacheCreationInputTokens / CacheReadInputTokens 是 Anthropic 的缓存用量。
	CacheCreationInputTokens int
	CacheReadInputTokens     int
	ReasoningTokens          int
	// Raw 保留协议原始的用量键，便于审计。
	Raw map[string]int
}

// Response 是一次规范化后的响应。
type Response struct {
	ID    string
	Model string
	Parts []Part
	Stop  StopReason
	Usage Usage
	Lossy []LossyNote
}

// EventKind 是流式事件种类。
type EventKind string

const (
	EventMessageStart EventKind = "message_start"
	EventBlockStart   EventKind = "block_start"
	EventBlockDelta   EventKind = "block_delta"
	EventBlockStop    EventKind = "block_stop"
	EventMessageDelta EventKind = "message_delta"
	EventMessageStop  EventKind = "message_stop"
	EventPing         EventKind = "ping"
	EventError        EventKind = "error"
)

// DeltaKind 是块内增量的种类。
type DeltaKind string

const (
	DeltaText          DeltaKind = "text"
	DeltaThinking      DeltaKind = "thinking"
	DeltaSignature     DeltaKind = "signature"
	DeltaToolInputJSON DeltaKind = "tool_input_json"
)

// Event 是流式解码/编码的中间事件。
//
// 它同时承载 Anthropic 风格的生命周期事件与 OpenAI 风格的内容增量：
// codec 负责把上游字节拆成事件，再把事件重新拼成客户端协议帧。
type Event struct {
	Kind      EventKind
	Index     int
	Part      *Part
	DeltaKind DeltaKind
	Text      string
	Stop      StopReason
	Usage     *Usage
	ID        string
	Model     string
	Err       *StreamError
	// Raw 保留无法归类、但需要透传的原始片段。
	Raw json.RawMessage
}

// StreamError 是可安全外传的流内错误。
type StreamError struct {
	Type    string
	Code    string
	Message string
}

// LossyNote 记录一次有损映射。它必须进日志（只记字段名，不记内容）。
type LossyNote struct {
	Direction string // request | response
	From, To  Protocol
	Field     string // "thinking.signature" | "n" | "cache_control" ...
	Action    string // dropped | mapped | coerced | defaulted
	Detail    string
}
