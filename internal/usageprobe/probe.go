// Package usageprobe 从「发回客户端的响应字节」里提取 token 用量。
//
// 它不修改字节：流式路径返回一个只观察的 io.Reader 包装器，非流式路径只解析内存里的
// body。解析失败一律吞掉（present=false），绝不能因为用量采集影响正常响应。
//
// 口径归一化（contracts/usage.go）：
//   - OpenAI 系（openai-chat / openai-responses）的 input/prompt tokens **包含**缓存命中；
//   - Gemini 的 promptTokenCount 同样**包含** cachedContentTokenCount（与 OpenAI 同口径）；
//   - Anthropic 的 input_tokens **不含**缓存部分。
//
// 因此 Normalize 按**上游协议**把 Usage 换算成「input 不含缓存」的四桶口径。
package usageprobe

import (
	"bytes"
	"encoding/json"
	"io"
	"sync"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Probe 用协议 codec 从响应字节里提取 usage。构造后只读，可被并发使用。
type Probe struct {
	registry *contracts.CodecRegistry
}

// New 构造探针。registry 为空时所有方法都安全地返回「没有用量」。
func New(registry *contracts.CodecRegistry) *Probe {
	return &Probe{registry: registry}
}

// Extract 从非流式响应体里提取 usage。
//
// protocol 是 body 的线上协议（发回客户端时的协议），不是上游协议：跨协议转换后
// body 已经是客户端形状。token 口径由 Normalize 按上游协议换算。
// 第二个返回值表示响应顶层确实有 usage 键；codec 解析失败时返回 false。
func (p *Probe) Extract(protocol contracts.Protocol, body []byte) (contracts.Usage, bool) {
	if p == nil || p.registry == nil || len(body) == 0 {
		return contracts.Usage{}, false
	}
	codec, ok := p.registry.Lookup(protocol)
	if !ok {
		return contracts.Usage{}, false
	}
	response, err := codec.ParseResponse(body)
	if err != nil {
		return contracts.Usage{}, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return contracts.Usage{}, false
	}
	// Gemini 的用量键叫 usageMetadata（OpenAI / Anthropic 都是 usage）。
	usageKey := "usage"
	if protocol == contracts.ProtocolGemini {
		usageKey = "usageMetadata"
	}
	raw, present := fields[usageKey]
	if !present || isJSONNull(raw) {
		return contracts.Usage{}, false
	}
	return response.Usage, true
}

// Watch 包装流式 reader，并在每次 Read 后把字节喂给该协议的 StreamDecoder。
//
// protocol 同样是字节流的线上协议（发回客户端的协议）。
//
// 返回的结算函数会再 Close 一次 decoder，并按字段取 max 合并所有事件里的 Usage
// （Anthropic 的 input/cache 在 message_start、output 在 message_delta，覆盖式合并会丢数）。
// 结算函数可重复调用；present 表示至少收到过一个带 Usage 的事件；errorCode 是流内
// EventError 的稳定 code（没有则为空）。
func (p *Probe) Watch(protocol contracts.Protocol, r io.Reader) (io.Reader, func() (contracts.Usage, bool, string)) {
	if p == nil || p.registry == nil || r == nil {
		return r, emptySettle
	}
	codec, ok := p.registry.Lookup(protocol)
	if !ok {
		return r, emptySettle
	}
	watcher := &watcher{
		source:  r,
		decoder: codec.NewStreamDecoder(),
	}
	return watcher, watcher.settle
}

func emptySettle() (contracts.Usage, bool, string) {
	return contracts.Usage{}, false, ""
}

type watcher struct {
	source  io.Reader
	decoder contracts.StreamDecoder

	mu       sync.Mutex
	usage    contracts.Usage
	present  bool
	errCode  string
	closed   bool
	settling bool
}

func (w *watcher) Read(p []byte) (int, error) {
	read, err := w.source.Read(p)
	if read > 0 {
		w.mu.Lock()
		if !w.closed {
			// 解析失败不影响调用方：decoder 的错误只影响用量，不改变字节流。
			_ = w.decoder.Push(p[:read], w.observe)
		}
		w.mu.Unlock()
	}
	return read, err
}

// settle 收尾并返回合并后的用量。Close 期间产生的错误不算「流里的 EventError」：
// 那通常是客户端中途断开留下的半截帧，由 UsageComplete=false 表达。
func (w *watcher) settle() (contracts.Usage, bool, string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.closed {
		w.closed = true
		w.settling = true
		_ = w.decoder.Close(w.observe)
	}
	return w.usage, w.present, w.errCode
}

func (w *watcher) observe(event contracts.Event) {
	if event.Usage != nil {
		w.merge(*event.Usage)
		w.present = true
	}
	if event.Kind == contracts.EventError && event.Err != nil && !w.settling {
		code := event.Err.Code
		if code == "" {
			code = event.Err.Type
		}
		if code != "" {
			w.errCode = code
		}
	}
}

// merge 按字段取 max。各协议的流把同一个 Usage 拆在不同事件里，
// 覆盖式合并会把先前事件里的 non-zero 字段清零。
func (w *watcher) merge(usage contracts.Usage) {
	w.usage.InputTokens = max(w.usage.InputTokens, usage.InputTokens)
	w.usage.OutputTokens = max(w.usage.OutputTokens, usage.OutputTokens)
	w.usage.CacheCreationInputTokens = max(w.usage.CacheCreationInputTokens, usage.CacheCreationInputTokens)
	w.usage.CacheReadInputTokens = max(w.usage.CacheReadInputTokens, usage.CacheReadInputTokens)
	w.usage.ReasoningTokens = max(w.usage.ReasoningTokens, usage.ReasoningTokens)
	if len(usage.Raw) > 0 {
		if w.usage.Raw == nil {
			w.usage.Raw = make(map[string]int, len(usage.Raw))
		}
		for key, value := range usage.Raw {
			w.usage.Raw[key] = max(w.usage.Raw[key], value)
		}
	}
}

// Normalize 按上游协议把 Usage 换算成「input 不含缓存」的口径。
//
//   - OpenAI 系：input = max(input - cacheRead, 0)，cacheCreate = 0；
//   - Gemini：promptTokenCount 含 cachedContentTokenCount（与 OpenAI 同口径），
//     同样做减法；Gemini 没有写缓存，cacheCreate 恒为 0；
//   - Anthropic：input 已经是净输入，cacheCreate 保持；
//   - 未知协议：原样返回（调用方通常已经回退到客户端协议）。
//
// ReasoningTokens 是 output 的子集，不参与任何相减。
func Normalize(usage contracts.Usage, upstream contracts.Protocol) contracts.Usage {
	if upstream.IsOpenAI() || upstream == contracts.ProtocolGemini {
		usage.InputTokens = max(usage.InputTokens-usage.CacheReadInputTokens, 0)
		usage.CacheCreationInputTokens = 0
	}
	return usage
}

// TotalTokens 返回四桶之和。ReasoningTokens 已包含在 output 里，不重复相加。
func TotalTokens(usage contracts.Usage) int {
	return usage.InputTokens + usage.OutputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens
}

func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}
