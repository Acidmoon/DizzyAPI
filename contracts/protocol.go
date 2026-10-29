// Package contracts —— LLM 协议转换的编解码契约。
//
// 这里的接口是冻结契约：每个协议族实现一个 Codec，注册进 CodecRegistry，
// 由 protoconv 阶段按「客户端协议 vs 上游协议」选择入站/出站 codec。
//
// 本文件只依赖标准库（AGENTS.md §2.3）。
package contracts

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"sync"
)

// Codec 是一个协议族的完整编解码器。
//
// 非流式：ParseRequest / RenderRequest / ParseResponse / RenderResponse。
// 流式：NewStreamDecoder（上游字节 → IR 事件）/ NewStreamEncoder（IR 事件 → 客户端帧）。
type Codec interface {
	Protocol() Protocol
	ParseRequest(body []byte) (*Request, error)
	RenderRequest(req *Request) ([]byte, error)
	ParseResponse(body []byte) (*Response, error)
	RenderResponse(res *Response) ([]byte, error)
	// NewStreamDecoder 把上游字节流拆成 IR 事件；必须处理跨 chunk 半截 JSON。
	NewStreamDecoder() StreamDecoder
	// NewStreamEncoder 把 IR 事件拼成客户端 SSE 帧。
	NewStreamEncoder() StreamEncoder
}

// StreamDecoder 是「上游字节 → IR 事件」的有状态解码器。
type StreamDecoder interface {
	// Push 喂入一段上游字节，emit 收到的每个事件。
	Push(chunk []byte, emit func(Event)) error
	// Close 收尾，emit 剩余事件（如 message_stop）。
	Close(emit func(Event)) error
}

// StreamEncoder 是「IR 事件 → 客户端帧」的有状态编码器。
type StreamEncoder interface {
	Encode(ev Event) ([][]byte, error)
	EncodeError(se StreamError) ([][]byte, error)
	Flush() ([][]byte, error)
}

// CodecRegistry 是「协议 → 编解码器」的注册表。
//
// 重复注册报错：配置非法时明确失败，不静默覆盖（AGENTS.md §2.4）。
// 注册发生在装配期，读取发生在请求期。
type CodecRegistry struct {
	mu     sync.RWMutex
	codecs map[Protocol]Codec
}

// NewCodecRegistry 创建一个空注册表。
func NewCodecRegistry() *CodecRegistry {
	return &CodecRegistry{codecs: make(map[Protocol]Codec)}
}

// Register 注册一个 codec。协议为空或重复注册都返回错误。
func (r *CodecRegistry) Register(c Codec) error {
	if r == nil {
		return fmt.Errorf("codec 注册表为空")
	}
	if c == nil {
		return fmt.Errorf("codec 不能为 nil")
	}
	protocol := c.Protocol()
	if protocol == "" {
		return fmt.Errorf("codec 必须有非空协议名")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.codecs == nil {
		r.codecs = make(map[Protocol]Codec)
	}
	if _, exists := r.codecs[protocol]; exists {
		return fmt.Errorf("协议 %s 的 codec 重复注册", protocol)
	}
	r.codecs[protocol] = c
	return nil
}

// Lookup 按协议取 codec。
func (r *CodecRegistry) Lookup(p Protocol) (Codec, bool) {
	if r == nil {
		return nil, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	c, ok := r.codecs[p]
	return c, ok
}

// Protocols 返回已注册的协议，稳定排序。
func (r *CodecRegistry) Protocols() []Protocol {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	out := make([]Protocol, 0, len(r.codecs))
	for p := range r.codecs {
		out = append(out, p)
	}
	r.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// RenderError 按协议渲染错误体。
//
//   - protocol == "" 或 openai-* → {"error":{"message","type","code"}}，
//     与 internal/engine 现有 render 完全同键同形状；
//   - anthropic → {"type":"error","error":{"type","message","code"}}：
//     官方 schema 只有 type / message，`code` 是**纯增量**的超集字段，让客户端
//     能机器可读地区分网关拒因（例如 ALL_ACCOUNTS_SATURATED）；code 为空时
//     不输出该键，保持与老形状完全一致。
//   - gemini → {"error":{"code","message","status","reason"}}：官方 schema 是
//     {"error":{"code","message","status"}}，其中 `code` 是**整数 HTTP 状态**
//     （SDK 按整数解析），`status` 是 Google 的枚举名。所以这两个字段必须保持
//     官方语义，网关的稳定 code 放在**纯增量**的 `reason` 里（空 code 不输出该键），
//     与 anthropic 那侧的取舍一致：先保证官方形状不坏，再加可读的拒因。
//
// 状态码越界（<400 或 >599）一律按 500 渲染，与 engine 一致。
func RenderError(protocol Protocol, status int, code, message string) []byte {
	if status < 400 || status > 599 {
		status = http.StatusInternalServerError
	}
	if protocol == ProtocolGemini {
		detail := map[string]any{
			"code":    status,
			"message": message,
			"status":  geminiErrorStatus(status),
		}
		// 稳定错误码只增不改：空 code 不写。
		if code != "" {
			detail["reason"] = code
		}
		body, err := json.Marshal(map[string]any{"error": detail})
		if err != nil {
			return []byte(`{"error":{"code":500,"message":"网关内部错误","status":"INTERNAL"}}`)
		}
		return body
	}
	if protocol == ProtocolAnthropic {
		detail := map[string]any{
			"type":    anthropicErrorType(status),
			"message": message,
		}
		// 稳定错误码只增不改：空 code 不写，老客户端看到的形状与以前逐字节一致。
		if code != "" {
			detail["code"] = code
		}
		body, err := json.Marshal(map[string]any{
			"type":  "error",
			"error": detail,
		})
		if err != nil {
			return []byte(`{"type":"error","error":{"type":"api_error","message":"网关内部错误"}}`)
		}
		return body
	}
	body, err := json.Marshal(map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    openAIErrorType(status),
			"code":    code,
		},
	})
	if err != nil {
		return []byte(`{"error":{"message":"网关内部错误","type":"server_error","code":"GATEWAY_INTERNAL"}}`)
	}
	return body
}

// openAIErrorType 与 internal/engine 的 errorType 保持逐字一致。
func openAIErrorType(status int) string {
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return "authentication_error"
	case status == http.StatusTooManyRequests:
		return "rate_limit_error"
	case status >= 500:
		return "server_error"
	default:
		return "invalid_request_error"
	}
}

// anthropicErrorType 是 Anthropic 错误体的 type 映射。
func anthropicErrorType(status int) string {
	switch {
	case status == http.StatusUnauthorized:
		return "authentication_error"
	case status == http.StatusForbidden:
		return "permission_error"
	case status == http.StatusNotFound:
		return "not_found_error"
	case status == http.StatusTooManyRequests:
		return "rate_limit_error"
	case status >= 500:
		return "api_error"
	default:
		return "invalid_request_error"
	}
}

// geminiErrorStatus 是 Gemini（Google API）错误体的 status 映射。
//
// 官方形状里 `status` 是 google.rpc.Status 的枚举名，`code` 是对应的整数 HTTP
// 状态；客户端 SDK 按这两个字段识别错误类别，所以不能挪作它用。
func geminiErrorStatus(status int) string {
	switch {
	case status == http.StatusBadRequest:
		return "INVALID_ARGUMENT"
	case status == http.StatusUnauthorized:
		return "UNAUTHENTICATED"
	case status == http.StatusForbidden:
		return "PERMISSION_DENIED"
	case status == http.StatusNotFound:
		return "NOT_FOUND"
	case status == http.StatusConflict:
		return "ABORTED"
	case status == http.StatusTooManyRequests:
		return "RESOURCE_EXHAUSTED"
	case status == http.StatusPaymentRequired || status == http.StatusPreconditionFailed:
		return "FAILED_PRECONDITION"
	case status == http.StatusNotImplemented:
		return "UNIMPLEMENTED"
	case status == http.StatusServiceUnavailable:
		return "UNAVAILABLE"
	case status == http.StatusGatewayTimeout:
		return "DEADLINE_EXCEEDED"
	case status >= 500:
		return "INTERNAL"
	default:
		return "UNKNOWN"
	}
}
