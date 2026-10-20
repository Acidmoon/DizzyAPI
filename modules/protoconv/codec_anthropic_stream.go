package protoconv

import (
	"encoding/json"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// ---------------------------------------------------------------------------
// 流式解码：上游 Anthropic SSE → IR 事件
// ---------------------------------------------------------------------------

// anthropicStreamDecoder 把 Anthropic 的 event:/data: 帧拆成 IR 事件。
//
// 跨 chunk 半截 JSON 由 sseFramer 处理：它按行扫描、按空行成帧，未成帧的尾部
// 字节留在缓冲里等下一个 chunk，因此不假设一次 Push 就是一条完整帧。
type anthropicStreamDecoder struct {
	framer  *sseFramer
	started bool
	stopped bool
}

// NewStreamDecoder 返回 Anthropic Messages 的流式解码器。
func (anthropicCodec) NewStreamDecoder() contracts.StreamDecoder {
	return &anthropicStreamDecoder{framer: newSSEFramer()}
}

type anthropicStreamMessageStart struct {
	Message struct {
		ID    string              `json:"id"`
		Model string              `json:"model"`
		Usage *anthropicWireUsage `json:"usage"`
	} `json:"message"`
}

type anthropicStreamBlockStart struct {
	Index        int                `json:"index"`
	ContentBlock anthropicWireBlock `json:"content_block"`
}

type anthropicStreamBlockDelta struct {
	Index int `json:"index"`
	Delta struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		PartialJSON string `json:"partial_json"`
		Thinking    string `json:"thinking"`
		Signature   string `json:"signature"`
	} `json:"delta"`
}

type anthropicStreamMessageDelta struct {
	Delta struct {
		StopReason string `json:"stop_reason"`
	} `json:"delta"`
	Usage *anthropicWireUsage `json:"usage"`
}

func (d *anthropicStreamDecoder) Push(chunk []byte, emit func(contracts.Event)) error {
	frames, err := d.framer.push(chunk)
	for _, frame := range frames {
		d.handleFrame(frame, emit)
	}
	if err != nil {
		emit(streamErrorEvent(CodeTranscodeFailed, "上游流解析失败"))
		return err
	}
	return nil
}

func (d *anthropicStreamDecoder) Close(emit func(contracts.Event)) error {
	frames, err := d.framer.close()
	for _, frame := range frames {
		d.handleFrame(frame, emit)
	}
	if !d.stopped {
		d.stopped = true
		emit(contracts.Event{Kind: contracts.EventMessageStop})
	}
	return err
}

func (d *anthropicStreamDecoder) handleFrame(frame sseFrame, emit func(contracts.Event)) {
	if len(frame.Data) == 0 && frame.Event == "" {
		return
	}
	name := frame.Event
	if name == "" {
		// 有些代理只发 data（不带 event 名）：从 JSON 的 type 推断。
		var probe struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(frame.Data, &probe) == nil {
			name = probe.Type
		}
	}
	switch name {
	case "message_start":
		var payload anthropicStreamMessageStart
		if json.Unmarshal(frame.Data, &payload) != nil {
			emit(streamErrorEvent(CodeTranscodeFailed, "message_start 不是合法 JSON"))
			return
		}
		d.started = true
		event := contracts.Event{Kind: contracts.EventMessageStart, ID: payload.Message.ID, Model: payload.Message.Model}
		if payload.Message.Usage != nil {
			usage := anthropicUsageFromWire(payload.Message.Usage)
			event.Usage = &usage
		}
		emit(event)

	case "content_block_start":
		var payload anthropicStreamBlockStart
		if json.Unmarshal(frame.Data, &payload) != nil {
			emit(streamErrorEvent(CodeTranscodeFailed, "content_block_start 不是合法 JSON"))
			return
		}
		emit(contracts.Event{
			Kind:  contracts.EventBlockStart,
			Index: payload.Index,
			Part:  anthropicBlockToPart(payload.ContentBlock),
		})

	case "content_block_delta":
		var payload anthropicStreamBlockDelta
		if json.Unmarshal(frame.Data, &payload) != nil {
			emit(streamErrorEvent(CodeTranscodeFailed, "content_block_delta 不是合法 JSON"))
			return
		}
		event := contracts.Event{Kind: contracts.EventBlockDelta, Index: payload.Index}
		switch payload.Delta.Type {
		case "text_delta":
			event.DeltaKind = contracts.DeltaText
			event.Text = payload.Delta.Text
		case "input_json_delta":
			event.DeltaKind = contracts.DeltaToolInputJSON
			event.Text = payload.Delta.PartialJSON
		case "thinking_delta":
			event.DeltaKind = contracts.DeltaThinking
			event.Text = payload.Delta.Thinking
		case "signature_delta":
			event.DeltaKind = contracts.DeltaSignature
			event.Text = payload.Delta.Signature
		default:
			// 未知 delta 类型：忽略（不静默丢内容，因为本来就没建模）。
			return
		}
		emit(event)

	case "content_block_stop":
		var payload struct {
			Index int `json:"index"`
		}
		_ = json.Unmarshal(frame.Data, &payload)
		emit(contracts.Event{Kind: contracts.EventBlockStop, Index: payload.Index})

	case "message_delta":
		var payload anthropicStreamMessageDelta
		if json.Unmarshal(frame.Data, &payload) != nil {
			emit(streamErrorEvent(CodeTranscodeFailed, "message_delta 不是合法 JSON"))
			return
		}
		event := contracts.Event{
			Kind: contracts.EventMessageDelta,
			Stop: anthropicStopToIR(payload.Delta.StopReason, nil),
		}
		if payload.Usage != nil {
			usage := anthropicUsageFromWire(payload.Usage)
			event.Usage = &usage
		}
		emit(event)

	case "message_stop":
		d.stopped = true
		emit(contracts.Event{Kind: contracts.EventMessageStop})

	case "ping":
		emit(contracts.Event{Kind: contracts.EventPing})

	case "error":
		var payload struct {
			Error struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(frame.Data, &payload)
		emit(contracts.Event{Kind: contracts.EventError, Err: &contracts.StreamError{
			Type:    payload.Error.Type,
			Code:    CodeTranscodeFailed,
			Message: payload.Error.Message,
		}})
	}
}

// anthropicBlockToPart 把一个 content_block 的开头翻成 IR 片段。
func anthropicBlockToPart(block anthropicWireBlock) *contracts.Part {
	switch block.Type {
	case "tool_use":
		return &contracts.Part{
			Kind:       contracts.KindToolUse,
			ToolCallID: anthropicInID(block.ID),
			ToolName:   block.Name,
		}
	case "thinking":
		return &contracts.Part{Kind: contracts.KindThinking}
	case "redacted_thinking":
		return &contracts.Part{Kind: contracts.KindThinking, Redacted: true, Text: block.Data}
	case "text", "":
		return &contracts.Part{Kind: contracts.KindText}
	default:
		return &contracts.Part{Kind: contracts.KindUnknown}
	}
}

// ---------------------------------------------------------------------------
// 流式编码：IR 事件 → 客户端 Anthropic SSE 帧
// ---------------------------------------------------------------------------

// anthropicStreamEncoder 严格维护 Anthropic 的事件顺序：
// message_start → (content_block_start → content_block_delta* → content_block_stop)* →
// message_delta → message_stop。块编号按出现顺序自增。
type anthropicStreamEncoder struct {
	id        string
	model     string
	started   bool
	stopped   bool
	nextIndex int
	openIR    int
	openIndex int
	hasOpen   bool
	indexByIR map[int]int
}

// NewStreamEncoder 返回 Anthropic Messages 的流式编码器。
func (anthropicCodec) NewStreamEncoder() contracts.StreamEncoder {
	return &anthropicStreamEncoder{openIR: -1, openIndex: -1, indexByIR: make(map[int]int)}
}

func (e *anthropicStreamEncoder) Encode(event contracts.Event) ([][]byte, error) {
	switch event.Kind {
	case contracts.EventMessageStart:
		if event.ID != "" {
			e.id = event.ID
		}
		if event.Model != "" {
			e.model = event.Model
		}
		e.started = true
		usage := map[string]any{"input_tokens": 0, "output_tokens": 0}
		if event.Usage != nil {
			usage = anthropicUsageToWire(*event.Usage)
		}
		message := map[string]any{
			"id":            e.id,
			"type":          "message",
			"role":          "assistant",
			"model":         e.model,
			"content":       []any{},
			"stop_reason":   nil,
			"stop_sequence": nil,
			"usage":         usage,
		}
		return e.frames("message_start", map[string]any{"type": "message_start", "message": message}), nil

	case contracts.EventBlockStart:
		index := e.openBlock(event.Index, event.Part)
		return e.frames("content_block_start", map[string]any{
			"type":          "content_block_start",
			"index":         index,
			"content_block": blockStartPayload(event.Part),
		}), nil

	case contracts.EventBlockDelta:
		index := e.ensureOpen(event.Index, event.DeltaKind)
		delta := deltaPayload(event)
		if delta == nil {
			return nil, nil
		}
		return e.frames("content_block_delta", map[string]any{
			"type": "content_block_delta", "index": index, "delta": delta,
		}), nil

	case contracts.EventBlockStop:
		return e.closeOpen(), nil

	case contracts.EventMessageDelta:
		frames := e.closeOpen()
		delta := map[string]any{"stop_reason": irStopToAnthropic(event.Stop), "stop_sequence": nil}
		payload := map[string]any{"type": "message_delta", "delta": delta}
		if event.Usage != nil {
			payload["usage"] = anthropicUsageToWire(*event.Usage)
		}
		return append(frames, e.frames("message_delta", payload)...), nil

	case contracts.EventMessageStop:
		frames := e.closeOpen()
		e.stopped = true
		return append(frames, e.frames("message_stop", map[string]any{"type": "message_stop"})...), nil

	case contracts.EventPing:
		return e.frames("ping", map[string]any{"type": "ping"}), nil

	case contracts.EventError:
		return e.EncodeError(derefStreamError(event.Err))
	}
	return nil, nil
}

func (e *anthropicStreamEncoder) EncodeError(se contracts.StreamError) ([][]byte, error) {
	if se.Type == "" {
		se.Type = "api_error"
	}
	// 流内错误意味着本次流就此结束：标记已停止，Flush 不再补 message_stop。
	e.stopped = true
	payload := mustRaw(map[string]any{
		"type":  "error",
		"error": map[string]any{"type": se.Type, "message": se.Message},
	})
	return [][]byte{encodeSSEFrame("error", payload)}, nil
}

func (e *anthropicStreamEncoder) Flush() ([][]byte, error) {
	if e.stopped {
		return nil, nil
	}
	frames := e.closeOpen()
	e.stopped = true
	return append(frames, e.frames("message_stop", map[string]any{"type": "message_stop"})...), nil
}

// openBlock 关闭已打开的块，为新块分配一个连续编号。
func (e *anthropicStreamEncoder) openBlock(irIndex int, part *contracts.Part) int {
	e.closeOpen()
	index := e.nextIndex
	e.nextIndex++
	e.indexByIR[irIndex] = index
	e.openIR = irIndex
	e.openIndex = index
	e.hasOpen = true
	return index
}

// ensureOpen 返回 IR 块对应的 Anthropic 编号；没有打开时按增量种类补开一个块。
func (e *anthropicStreamEncoder) ensureOpen(irIndex int, kind contracts.DeltaKind) int {
	if index, ok := e.indexByIR[irIndex]; ok {
		return index
	}
	part := &contracts.Part{Kind: contracts.KindText}
	switch kind {
	case contracts.DeltaToolInputJSON:
		part = &contracts.Part{Kind: contracts.KindToolUse}
	case contracts.DeltaThinking, contracts.DeltaSignature:
		part = &contracts.Part{Kind: contracts.KindThinking}
	}
	return e.openBlock(irIndex, part)
}

// closeOpen 若当前有打开的块则补 content_block_stop。
func (e *anthropicStreamEncoder) closeOpen() [][]byte {
	if !e.hasOpen {
		return nil
	}
	frame := e.frames("content_block_stop", map[string]any{
		"type": "content_block_stop", "index": e.openIndex,
	})
	e.hasOpen = false
	e.openIR = -1
	e.openIndex = -1
	return frame
}

func (e *anthropicStreamEncoder) frames(name string, payload any) [][]byte {
	return [][]byte{encodeSSEFrame(name, mustRaw(payload))}
}

// blockStartPayload 渲染 content_block_start 的 content_block。
func blockStartPayload(part *contracts.Part) map[string]any {
	if part == nil {
		return map[string]any{"type": "text", "text": ""}
	}
	switch part.Kind {
	case contracts.KindToolUse:
		return map[string]any{
			"type": "tool_use", "id": anthropicOutID(part.ToolCallID), "name": part.ToolName, "input": map[string]any{},
		}
	case contracts.KindThinking:
		if part.Redacted {
			return map[string]any{"type": "redacted_thinking", "data": part.Text}
		}
		return map[string]any{"type": "thinking", "thinking": ""}
	default:
		return map[string]any{"type": "text", "text": ""}
	}
}

// deltaPayload 渲染 content_block_delta 的 delta。
func deltaPayload(event contracts.Event) map[string]any {
	switch event.DeltaKind {
	case contracts.DeltaText:
		return map[string]any{"type": "text_delta", "text": event.Text}
	case contracts.DeltaToolInputJSON:
		return map[string]any{"type": "input_json_delta", "partial_json": event.Text}
	case contracts.DeltaThinking:
		return map[string]any{"type": "thinking_delta", "thinking": event.Text}
	case contracts.DeltaSignature:
		return map[string]any{"type": "signature_delta", "signature": event.Text}
	default:
		return nil
	}
}
