package protoconv

import (
	"encoding/json"
	"strings"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// ---------------------------------------------------------------------------
// 流式解码：上游 Gemini SSE → IR 事件
// ---------------------------------------------------------------------------
//
// Gemini 的流式端点是 POST /v1beta/models/{model}:streamGenerateContent?alt=sse，
// 每帧是一个**完整的 GenerateContentResponse**（不是「事件名 + 增量」）：
//
//	data: {"candidates":[{"content":{"parts":[{"text":"你"}],"role":"model"}}],"modelVersion":"...","usageMetadata":{...}}
//
// 文本增量有两种上游行为：有的实现每帧只给**新增**片段，有的每帧给**累计**全文。
// 解码器两种都吃：新片段以已累计文本为前缀时，只取后缀（累计形态），
// 否则整段当作新增（增量形态）。这样不管上游是哪种形态，IR 拿到的都是纯增量。
//
// usage 在最后一帧给全量值（也有中间帧给累积值的实现）：这里按「取 max 合并」处理，
// 避免覆盖式合并把已知的数清零。

type geminiStreamDecoder struct {
	framer      *sseFramer
	started     bool
	stopped     bool
	textStarted bool
	text        strings.Builder
	toolStarted map[string]bool
	toolIndex   map[string]int
	nextIndex   int
}

// NewStreamDecoder 返回 Gemini 的流式解码器。
func (geminiCodec) NewStreamDecoder() contracts.StreamDecoder {
	return &geminiStreamDecoder{
		framer:      newSSEFramer(),
		toolStarted: make(map[string]bool),
		toolIndex:   make(map[string]int),
	}
}

func (d *geminiStreamDecoder) Push(chunk []byte, emit func(contracts.Event)) error {
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

func (d *geminiStreamDecoder) Close(emit func(contracts.Event)) error {
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

func (d *geminiStreamDecoder) handleFrame(frame sseFrame, emit func(contracts.Event)) {
	if frame.Done {
		d.stop(emit)
		return
	}
	if len(frame.Data) == 0 {
		return
	}
	var chunk geminiWireResponse
	if err := json.Unmarshal(frame.Data, &chunk); err != nil {
		emit(streamErrorEvent(CodeTranscodeFailed, "上游流片段不是合法 JSON"))
		return
	}
	if !d.started {
		d.started = true
		emit(contracts.Event{
			Kind:  contracts.EventMessageStart,
			ID:    chunk.ResponseID,
			Model: chunk.ModelVersion,
		})
	}
	for _, candidate := range chunk.Candidates {
		for _, part := range candidate.Content.Parts {
			switch {
			case part.FunctionCall != nil:
				d.emitToolCall(part.FunctionCall, emit)
			case part.Thought && part.Text != "":
				// 思考片段：IR 有 thinking 增量，但 Gemini 的 thought 标记无法回传，
				// 所以按文本增量发出（目标协议自己决定能不能表达）。
				d.ensureTextBlock(emit)
				emit(contracts.Event{
					Kind:      contracts.EventBlockDelta,
					Index:     0,
					DeltaKind: contracts.DeltaThinking,
					Text:      part.Text,
				})
			case part.Text != "":
				delta := d.textDelta(part.Text)
				if delta == "" {
					continue
				}
				d.ensureTextBlock(emit)
				emit(contracts.Event{
					Kind:      contracts.EventBlockDelta,
					Index:     0,
					DeltaKind: contracts.DeltaText,
					Text:      delta,
				})
			}
		}
		if candidate.FinishReason != "" {
			event := contracts.Event{
				Kind: contracts.EventMessageDelta,
				Stop: geminiFinishToStop(candidate.FinishReason, nil),
			}
			if chunk.UsageMetadata != nil {
				usage := geminiUsageFromWire(chunk.UsageMetadata)
				event.Usage = &usage
			}
			emit(event)
			d.stop(emit)
			return
		}
	}
	if chunk.UsageMetadata != nil {
		usage := geminiUsageFromWire(chunk.UsageMetadata)
		emit(contracts.Event{Kind: contracts.EventMessageDelta, Usage: &usage})
	}
}

// textDelta 把一帧的文本归一成增量。
//
// 累计形态：新片段以已累计文本为前缀 → 只取后缀；否则（增量形态）整段就是新增。
func (d *geminiStreamDecoder) textDelta(text string) string {
	if d.text.Len() == 0 {
		d.text.WriteString(text)
		return text
	}
	accumulated := d.text.String()
	if strings.HasPrefix(text, accumulated) {
		delta := text[len(accumulated):]
		d.text.Reset()
		d.text.WriteString(text)
		return delta
	}
	d.text.WriteString(text)
	return text
}

func (d *geminiStreamDecoder) ensureTextBlock(emit func(contracts.Event)) {
	if d.textStarted {
		return
	}
	d.textStarted = true
	emit(contracts.Event{
		Kind:  contracts.EventBlockStart,
		Index: 0,
		Part:  &contracts.Part{Kind: contracts.KindText},
	})
}

// emitToolCall 把一个 functionCall 转成「块开始 + 参数增量」。
//
// Gemini 流式里 functionCall 的 args 是一整个对象（不是增量 JSON 片段），
// 所以这里把它整段作为一次 DeltaToolInputJSON 发出：IR 的 tool_use 块
// 本来就允许「一次性给全量参数」。
func (d *geminiStreamDecoder) emitToolCall(call *geminiWireFunctionCall, emit func(contracts.Event)) {
	index, ok := d.toolIndex[call.Name]
	if !ok {
		index = d.nextIndex
		d.nextIndex++
		d.toolIndex[call.Name] = index
	}
	if !d.toolStarted[call.Name] {
		d.toolStarted[call.Name] = true
		emit(contracts.Event{
			Kind:  contracts.EventBlockStart,
			Index: index,
			Part: &contracts.Part{
				Kind:       contracts.KindToolUse,
				ToolCallID: geminiCallID(call.Name),
				ToolName:   call.Name,
			},
		})
	}
	if len(call.Args) == 0 {
		return
	}
	emit(contracts.Event{
		Kind:      contracts.EventBlockDelta,
		Index:     index,
		DeltaKind: contracts.DeltaToolInputJSON,
		Text:      string(call.Args),
	})
}

func (d *geminiStreamDecoder) stop(emit func(contracts.Event)) {
	if d.stopped {
		return
	}
	d.stopped = true
	emit(contracts.Event{Kind: contracts.EventMessageStop})
}

// ---------------------------------------------------------------------------
// 流式编码：IR 事件 → 客户端 Gemini SSE 帧
// ---------------------------------------------------------------------------

type geminiStreamEncoder struct {
	id      string
	model   string
	started bool
	stopped bool
	stop    contracts.StopReason
	usage   *contracts.Usage
	// 工具参数按函数名累积：IR 给的是增量片段，这里拼成完整对象再发。
	toolArgs  map[string]*strings.Builder
	toolOrder []string
}

// NewStreamEncoder 返回 Gemini 的流式编码器。
func (geminiCodec) NewStreamEncoder() contracts.StreamEncoder {
	return &geminiStreamEncoder{toolArgs: make(map[string]*strings.Builder)}
}

func (e *geminiStreamEncoder) Encode(event contracts.Event) ([][]byte, error) {
	switch event.Kind {
	case contracts.EventMessageStart:
		if event.ID != "" {
			e.id = event.ID
		}
		if event.Model != "" {
			e.model = event.Model
		}
		return nil, nil

	case contracts.EventBlockStart:
		if event.Part != nil && event.Part.Kind == contracts.KindToolUse {
			e.toolName(event.Part.ToolName)
		}
		return nil, nil

	case contracts.EventBlockDelta:
		switch event.DeltaKind {
		case contracts.DeltaText:
			// 增量形态：每帧只带新增片段（Gemini 客户端按累加处理）。
			return e.frame(e.candidate(geminiWirePart{Text: event.Text})), nil
		case contracts.DeltaThinking:
			// Gemini 的 thought 标记无法在跨协议后保留：按普通文本增量发出。
			return e.frame(e.candidate(geminiWirePart{Text: event.Text})), nil
		case contracts.DeltaToolInputJSON:
			name := e.toolNameOf(event.Index)
			if name == "" {
				return nil, nil
			}
			builder := e.toolArgs[name]
			builder.WriteString(event.Text)
			return e.frame(e.candidate(geminiWirePart{
				FunctionCall: &geminiWireFunctionCall{
					Name: name,
					Args: json.RawMessage(builder.String()),
				},
			})), nil
		}
		return nil, nil

	case contracts.EventMessageDelta:
		if event.Usage != nil {
			usage := *event.Usage
			e.usage = &usage
		}
		if event.Stop != "" {
			e.stop = event.Stop
		}
		return nil, nil

	case contracts.EventMessageStop:
		if e.stopped {
			return nil, nil
		}
		e.stopped = true
		frame := e.candidate()
		frame["finishReason"] = irStopToGeminiFinish(e.stop)
		return e.frame(frame), nil

	case contracts.EventError:
		return e.EncodeError(derefStreamError(event.Err))
	}
	return nil, nil
}

func (e *geminiStreamEncoder) EncodeError(se contracts.StreamError) ([][]byte, error) {
	if se.Type == "" {
		se.Type = "api_error"
	}
	payload := mustRaw(map[string]any{
		"error": map[string]any{
			"code":    se.Code,
			"message": se.Message,
			"status":  "UNKNOWN",
		},
	})
	return [][]byte{encodeSSEFrame("", payload)}, nil
}

func (e *geminiStreamEncoder) Flush() ([][]byte, error) { return nil, nil }

// toolName 登记一个工具名（按首次出现的顺序）。
func (e *geminiStreamEncoder) toolName(name string) string {
	if name == "" {
		return ""
	}
	if _, ok := e.toolArgs[name]; !ok {
		e.toolArgs[name] = &strings.Builder{}
		e.toolOrder = append(e.toolOrder, name)
	}
	return name
}

// toolNameOf 按块索引找出对应的函数名。
func (e *geminiStreamEncoder) toolNameOf(index int) string {
	if index < 0 || index >= len(e.toolOrder) {
		return ""
	}
	return e.toolOrder[index]
}

// candidate 组装一个 candidate 对象：已知的工具调用（累计参数）+ 本次增量。
func (e *geminiStreamEncoder) candidate(extra ...geminiWirePart) map[string]any {
	parts := make([]geminiWirePart, 0, len(e.toolOrder)+len(extra))
	for _, name := range e.toolOrder {
		builder := e.toolArgs[name]
		args := builder.String()
		if args == "" {
			args = "{}"
		}
		parts = append(parts, geminiWirePart{
			FunctionCall: &geminiWireFunctionCall{Name: name, Args: json.RawMessage(args)},
		})
	}
	parts = append(parts, extra...)
	return map[string]any{
		"candidates": []any{map[string]any{
			"content": map[string]any{
				"role":  "model",
				"parts": parts,
			},
			"index": 0,
		}},
	}
}

// frame 渲染一帧：Gemini 的流式帧是完整 GenerateContentResponse。
func (e *geminiStreamEncoder) frame(payload map[string]any) [][]byte {
	if e.id != "" {
		payload["responseId"] = e.id
	}
	if e.model != "" {
		payload["modelVersion"] = e.model
	}
	if e.usage != nil {
		payload["usageMetadata"] = geminiUsageToWire(*e.usage)
	}
	return [][]byte{encodeSSEFrame("", mustRaw(payload))}
}
