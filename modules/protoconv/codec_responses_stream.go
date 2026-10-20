package protoconv

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// ---------------------------------------------------------------------------
// 流式解码：上游 Responses SSE → IR 事件
// ---------------------------------------------------------------------------
//
// 线上帧形如 `event: <type>\ndata: {...}\n\n`，与 Chat 的 `data: {...}` 不同：
// 事件类型在 SSE 的 event 字段里，也在 data.type 里（两者一致）。
// 事件名对照官方文档核实：response.created / response.in_progress /
// response.output_item.added / response.content_part.added / response.output_text.delta /
// response.output_text.done / response.function_call_arguments.delta /
// response.function_call_arguments.done / response.output_item.done / response.completed /
// response.incomplete / response.failed / error。多数实现末尾还会补一条 data: [DONE]。

type responsesStreamDecoder struct {
	framer     *sseFramer
	started    bool
	stopped    bool
	hasToolUse bool
	blocks     map[int]bool
}

// NewStreamDecoder 返回 Responses 的流式解码器。
func (responsesCodec) NewStreamDecoder() contracts.StreamDecoder {
	return &responsesStreamDecoder{framer: newSSEFramer(), blocks: make(map[int]bool)}
}

// responsesWireEvent 覆盖所有流式事件的并集字段。
type responsesWireEvent struct {
	Type         string                  `json:"type"`
	Sequence     int                     `json:"sequence_number"`
	OutputIndex  int                     `json:"output_index"`
	ContentIndex int                     `json:"content_index"`
	ItemID       string                  `json:"item_id"`
	Delta        string                  `json:"delta"`
	Text         string                  `json:"text"`
	Arguments    string                  `json:"arguments"`
	Name         string                  `json:"name"`
	Item         responsesWireOutputItem `json:"item"`
	Response     responsesWireResponse   `json:"response"`
}

func (d *responsesStreamDecoder) Push(chunk []byte, emit func(contracts.Event)) error {
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

func (d *responsesStreamDecoder) Close(emit func(contracts.Event)) error {
	frames, err := d.framer.close()
	for _, frame := range frames {
		d.handleFrame(frame, emit)
	}
	d.stop(emit)
	return err
}

func (d *responsesStreamDecoder) stop(emit func(contracts.Event)) {
	if d.stopped {
		return
	}
	d.stopped = true
	emit(contracts.Event{Kind: contracts.EventMessageStop})
}

func (d *responsesStreamDecoder) handleFrame(frame sseFrame, emit func(contracts.Event)) {
	if frame.Done {
		d.stop(emit)
		return
	}
	if len(frame.Data) == 0 {
		return
	}
	var envelope responsesWireEvent
	if err := json.Unmarshal(frame.Data, &envelope); err != nil {
		emit(streamErrorEvent(CodeTranscodeFailed, "上游流片段不是合法 JSON"))
		return
	}
	eventType := envelope.Type
	if eventType == "" {
		eventType = frame.Event
	}
	switch eventType {
	case "response.created", "response.in_progress":
		if !d.started {
			d.started = true
			emit(contracts.Event{Kind: contracts.EventMessageStart, ID: envelope.Response.ID, Model: envelope.Response.Model})
		}
	case "response.output_item.added":
		d.handleItemAdded(envelope, emit)
	case "response.content_part.added":
		// 内容块信息由 output_item.added 决定，这里不额外产事件。
	case "response.output_text.delta":
		d.ensureTextBlock(envelope.OutputIndex, emit)
		emit(contracts.Event{Kind: contracts.EventBlockDelta, Index: envelope.OutputIndex, DeltaKind: contracts.DeltaText, Text: envelope.Delta})
	case "response.function_call_arguments.delta":
		d.ensureToolBlock(envelope, emit)
		emit(contracts.Event{Kind: contracts.EventBlockDelta, Index: envelope.OutputIndex, DeltaKind: contracts.DeltaToolInputJSON, Text: envelope.Delta})
	case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
		d.ensureThinkingBlock(envelope.OutputIndex, emit)
		emit(contracts.Event{Kind: contracts.EventBlockDelta, Index: envelope.OutputIndex, DeltaKind: contracts.DeltaThinking, Text: envelope.Delta})
	case "response.completed", "response.incomplete":
		d.handleCompleted(envelope, emit)
	case "response.failed", "response.error", "error":
		emit(streamErrorEvent(CodeTranscodeFailed, "上游响应失败"))
		d.stop(emit)
	default:
		// output_text.done / function_call_arguments.done / content_part.done /
		// output_item.done / sequence 等：IR 不需要单独事件。
	}
}

func (d *responsesStreamDecoder) handleItemAdded(envelope responsesWireEvent, emit func(contracts.Event)) {
	index := envelope.OutputIndex
	switch envelope.Item.Type {
	case "message":
		d.ensureTextBlock(index, emit)
	case "function_call":
		d.hasToolUse = true
		d.ensureToolBlock(envelope, emit)
	case "reasoning":
		d.ensureThinkingBlock(index, emit)
	}
}

func (d *responsesStreamDecoder) ensureTextBlock(index int, emit func(contracts.Event)) {
	if d.blocks[index] {
		return
	}
	d.blocks[index] = true
	emit(contracts.Event{Kind: contracts.EventBlockStart, Index: index, Part: &contracts.Part{Kind: contracts.KindText}})
}

func (d *responsesStreamDecoder) ensureToolBlock(envelope responsesWireEvent, emit func(contracts.Event)) {
	index := envelope.OutputIndex
	d.hasToolUse = true
	if d.blocks[index] {
		return
	}
	d.blocks[index] = true
	emit(contracts.Event{
		Kind:  contracts.EventBlockStart,
		Index: index,
		Part: &contracts.Part{
			Kind:       contracts.KindToolUse,
			ToolCallID: envelope.Item.CallID,
			ToolName:   envelope.Item.Name,
		},
	})
}

func (d *responsesStreamDecoder) ensureThinkingBlock(index int, emit func(contracts.Event)) {
	if d.blocks[index] {
		return
	}
	d.blocks[index] = true
	emit(contracts.Event{Kind: contracts.EventBlockStart, Index: index, Part: &contracts.Part{Kind: contracts.KindThinking}})
}

func (d *responsesStreamDecoder) handleCompleted(envelope responsesWireEvent, emit func(contracts.Event)) {
	hasTool := d.hasToolUse || responsesOutputHasToolUse(envelope.Response.Output)
	reason := responsesIncompleteReason(envelope.Response)
	stop := responsesStopFromStatus(envelope.Response.Status, reason, hasTool, nil)
	usage := responsesUsageFromWire(envelope.Response.Usage)
	emit(contracts.Event{Kind: contracts.EventMessageDelta, Stop: stop, Usage: &usage})
	d.stop(emit)
}

func responsesOutputHasToolUse(items []responsesWireOutputItem) bool {
	for _, item := range items {
		if item.Type == "function_call" {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// 流式编码：IR 事件 → 客户端 Responses SSE 帧
// ---------------------------------------------------------------------------

// responsesOpenItem 跟踪一个正在流式输出的 item 的生命周期。
type responsesOpenItem struct {
	kind  contracts.ContentKind
	index int
	id    string
	call  string
	name  string
	text  strings.Builder
	args  strings.Builder
}

type responsesStreamEncoder struct {
	id       string
	model    string
	sequence int
	created  bool
	next     int
	order    []*responsesOpenItem
	open     map[int]*responsesOpenItem
	usage    *contracts.Usage
	stop     contracts.StopReason
	output   []any
}

// NewStreamEncoder 返回 Responses 的流式编码器。
func (responsesCodec) NewStreamEncoder() contracts.StreamEncoder {
	return &responsesStreamEncoder{open: make(map[int]*responsesOpenItem)}
}

func (e *responsesStreamEncoder) Encode(event contracts.Event) ([][]byte, error) {
	switch event.Kind {
	case contracts.EventMessageStart:
		if event.ID != "" {
			e.id = event.ID
		}
		if event.Model != "" {
			e.model = event.Model
		}
		if e.created {
			return nil, nil
		}
		e.created = true
		return e.frame("response.created", map[string]any{
			"type":     "response.created",
			"response": e.responseObject("in_progress"),
		}), nil

	case contracts.EventBlockStart:
		return e.openBlock(event), nil

	case contracts.EventBlockDelta:
		return e.delta(event), nil

	case contracts.EventMessageDelta:
		if event.Usage != nil {
			usage := *event.Usage
			e.usage = &usage
		}
		if event.Stop != "" {
			e.stop = event.Stop
		}
		return e.closeOpen(), nil

	case contracts.EventBlockStop:
		return e.closeBlock(event.Index), nil

	case contracts.EventMessageStop:
		frames := e.closeOpen()
		frames = append(frames, e.frame("response.completed", map[string]any{
			"type":     "response.completed",
			"response": e.responseObject(e.status()),
		})...)
		return frames, nil

	case contracts.EventError:
		return e.EncodeError(derefStreamError(event.Err))
	}
	return nil, nil
}

func (e *responsesStreamEncoder) openBlock(event contracts.Event) [][]byte {
	part := event.Part
	if part == nil {
		return nil
	}
	index := e.next
	e.next++
	open := &responsesOpenItem{kind: part.Kind, index: index}
	switch part.Kind {
	case contracts.KindText:
		open.id = e.itemID("msg", index)
		e.register(event.Index, open)
		item := map[string]any{
			"type": "message", "id": open.id, "status": "in_progress",
			"role": "assistant", "content": []any{},
		}
		frames := e.frame("response.output_item.added", map[string]any{
			"type": "response.output_item.added", "output_index": index, "item": item,
		})
		frames = append(frames, e.frame("response.content_part.added", map[string]any{
			"type": "response.content_part.added", "item_id": open.id,
			"output_index": index, "content_index": 0,
			"part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}},
		})...)
		return frames
	case contracts.KindToolUse:
		open.id = e.itemID("fc", index)
		open.call = part.ToolCallID
		open.name = part.ToolName
		e.register(event.Index, open)
		item := map[string]any{
			"type": "function_call", "id": open.id, "call_id": open.call,
			"name": open.name, "arguments": "", "status": "in_progress",
		}
		return e.frame("response.output_item.added", map[string]any{
			"type": "response.output_item.added", "output_index": index, "item": item,
		})
	case contracts.KindThinking:
		open.id = e.itemID("rs", index)
		e.register(event.Index, open)
		item := map[string]any{"type": "reasoning", "id": open.id, "summary": []any{}}
		return e.frame("response.output_item.added", map[string]any{
			"type": "response.output_item.added", "output_index": index, "item": item,
		})
	}
	return nil
}

func (e *responsesStreamEncoder) register(blockIndex int, open *responsesOpenItem) {
	e.open[blockIndex] = open
	e.order = append(e.order, open)
}

func (e *responsesStreamEncoder) delta(event contracts.Event) [][]byte {
	open := e.open[event.Index]
	if open == nil {
		return nil
	}
	switch event.DeltaKind {
	case contracts.DeltaText:
		open.text.WriteString(event.Text)
		return e.frame("response.output_text.delta", map[string]any{
			"type": "response.output_text.delta", "item_id": open.id,
			"output_index": open.index, "content_index": 0, "delta": event.Text,
		})
	case contracts.DeltaToolInputJSON:
		open.args.WriteString(event.Text)
		return e.frame("response.function_call_arguments.delta", map[string]any{
			"type": "response.function_call_arguments.delta", "item_id": open.id,
			"output_index": open.index, "delta": event.Text,
		})
	case contracts.DeltaThinking:
		open.text.WriteString(event.Text)
		return e.frame("response.reasoning_summary_text.delta", map[string]any{
			"type": "response.reasoning_summary_text.delta", "item_id": open.id,
			"output_index": open.index, "delta": event.Text,
		})
	}
	return nil
}

// closeOpen 关闭所有仍打开的 item，产出各自的 .done 链，并登记进最终 response.output。
func (e *responsesStreamEncoder) closeOpen() [][]byte {
	var frames [][]byte
	for _, open := range e.order {
		frames = append(frames, e.closeItem(open)...)
	}
	e.order = nil
	e.open = make(map[int]*responsesOpenItem)
	return frames
}

func (e *responsesStreamEncoder) closeBlock(blockIndex int) [][]byte {
	open := e.open[blockIndex]
	if open == nil {
		return nil
	}
	delete(e.open, blockIndex)
	for index, candidate := range e.order {
		if candidate == open {
			e.order = append(e.order[:index], e.order[index+1:]...)
			break
		}
	}
	return e.closeItem(open)
}

func (e *responsesStreamEncoder) closeItem(open *responsesOpenItem) [][]byte {
	switch open.kind {
	case contracts.KindText:
		text := open.text.String()
		frames := e.frame("response.output_text.done", map[string]any{
			"type": "response.output_text.done", "item_id": open.id,
			"output_index": open.index, "content_index": 0, "text": text,
		})
		part := map[string]any{"type": "output_text", "text": text, "annotations": []any{}}
		frames = append(frames, e.frame("response.content_part.done", map[string]any{
			"type": "response.content_part.done", "item_id": open.id,
			"output_index": open.index, "content_index": 0, "part": part,
		})...)
		item := map[string]any{
			"type": "message", "id": open.id, "status": "completed",
			"role": "assistant", "content": []any{part},
		}
		frames = append(frames, e.frame("response.output_item.done", map[string]any{
			"type": "response.output_item.done", "output_index": open.index, "item": item,
		})...)
		e.output = append(e.output, item)
		return frames
	case contracts.KindToolUse:
		arguments := open.args.String()
		if arguments == "" {
			arguments = "{}"
		}
		frames := e.frame("response.function_call_arguments.done", map[string]any{
			"type": "response.function_call_arguments.done", "item_id": open.id,
			"output_index": open.index, "arguments": arguments, "name": open.name,
		})
		item := map[string]any{
			"type": "function_call", "id": open.id, "call_id": open.call,
			"name": open.name, "arguments": arguments, "status": "completed",
		}
		frames = append(frames, e.frame("response.output_item.done", map[string]any{
			"type": "response.output_item.done", "output_index": open.index, "item": item,
		})...)
		e.output = append(e.output, item)
		return frames
	case contracts.KindThinking:
		text := open.text.String()
		frames := e.frame("response.reasoning_summary_text.done", map[string]any{
			"type": "response.reasoning_summary_text.done", "item_id": open.id,
			"output_index": open.index, "text": text,
		})
		item := map[string]any{
			"type": "reasoning", "id": open.id,
			"summary": []any{map[string]any{"type": "summary_text", "text": text}},
		}
		frames = append(frames, e.frame("response.output_item.done", map[string]any{
			"type": "response.output_item.done", "output_index": open.index, "item": item,
		})...)
		e.output = append(e.output, item)
		return frames
	}
	return nil
}

func (e *responsesStreamEncoder) EncodeError(se contracts.StreamError) ([][]byte, error) {
	if se.Type == "" {
		se.Type = "api_error"
	}
	response := e.responseObject("failed")
	response["error"] = map[string]any{"type": se.Type, "code": se.Code, "message": se.Message}
	return e.frame("response.failed", map[string]any{
		"type":     "response.failed",
		"response": response,
	}), nil
}

func (e *responsesStreamEncoder) Flush() ([][]byte, error) { return nil, nil }

func (e *responsesStreamEncoder) status() string {
	switch e.stop {
	case contracts.StopMaxTokens, contracts.StopContentFilter:
		return "incomplete"
	default:
		return "completed"
	}
}

// responseObject 构造 response.* 事件里嵌套的 Response 对象。
func (e *responsesStreamEncoder) responseObject(status string) map[string]any {
	output := e.output
	if output == nil {
		output = []any{}
	}
	object := map[string]any{
		"id":     e.responseID(),
		"object": "response",
		"status": status,
		"model":  e.model,
		"output": output,
	}
	if e.usage != nil {
		object["usage"] = responsesUsageToWire(*e.usage)
	}
	if reason := responsesIncompleteReasonFor(e.stop); reason != "" {
		object["incomplete_details"] = map[string]any{"reason": reason}
	}
	return object
}

func (e *responsesStreamEncoder) responseID() string {
	if e.id != "" {
		return e.id
	}
	return "resp_gateway"
}

func (e *responsesStreamEncoder) itemID(prefix string, index int) string {
	return fmt.Sprintf("%s_%s_%d", prefix, e.responseID(), index)
}

func (e *responsesStreamEncoder) frame(eventType string, payload map[string]any) [][]byte {
	e.sequence++
	payload["sequence_number"] = e.sequence
	return [][]byte{encodeSSEFrame(eventType, mustRaw(payload))}
}
