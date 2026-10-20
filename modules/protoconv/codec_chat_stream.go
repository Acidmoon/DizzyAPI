package protoconv

import (
	"encoding/json"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// ---------------------------------------------------------------------------
// 流式解码：上游 Chat SSE → IR 事件
// ---------------------------------------------------------------------------

type chatStreamDecoder struct {
	framer      *sseFramer
	started     bool
	textStarted bool
	toolStarted map[int]bool
	stopped     bool
}

// NewStreamDecoder 返回 Chat Completions 的流式解码器。
func (chatCodec) NewStreamDecoder() contracts.StreamDecoder {
	return &chatStreamDecoder{framer: newSSEFramer(), toolStarted: make(map[int]bool)}
}

type chatWireChunk struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		Index int `json:"index"`
		Delta struct {
			Role      string `json:"role"`
			Content   string `json:"content"`
			ToolCalls []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *chatWireUsage `json:"usage"`
}

func (d *chatStreamDecoder) Push(chunk []byte, emit func(contracts.Event)) error {
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

func (d *chatStreamDecoder) Close(emit func(contracts.Event)) error {
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

func (d *chatStreamDecoder) handleFrame(frame sseFrame, emit func(contracts.Event)) {
	if frame.Done {
		d.stopped = true
		emit(contracts.Event{Kind: contracts.EventMessageStop})
		return
	}
	if len(frame.Data) == 0 {
		return
	}
	var chunk chatWireChunk
	if err := json.Unmarshal(frame.Data, &chunk); err != nil {
		emit(streamErrorEvent(CodeTranscodeFailed, "上游流片段不是合法 JSON"))
		return
	}
	if !d.started {
		d.started = true
		emit(contracts.Event{Kind: contracts.EventMessageStart, ID: chunk.ID, Model: chunk.Model})
	}
	for _, choice := range chunk.Choices {
		if choice.Delta.Content != "" {
			if !d.textStarted {
				d.textStarted = true
				emit(contracts.Event{
					Kind:  contracts.EventBlockStart,
					Index: 0,
					Part:  &contracts.Part{Kind: contracts.KindText},
				})
			}
			emit(contracts.Event{
				Kind:      contracts.EventBlockDelta,
				Index:     0,
				DeltaKind: contracts.DeltaText,
				Text:      choice.Delta.Content,
			})
		}
		for _, call := range choice.Delta.ToolCalls {
			index := call.Index + 1
			if !d.toolStarted[index] {
				d.toolStarted[index] = true
				emit(contracts.Event{
					Kind:  contracts.EventBlockStart,
					Index: index,
					Part: &contracts.Part{
						Kind:       contracts.KindToolUse,
						ToolCallID: call.ID,
						ToolName:   call.Function.Name,
					},
				})
			}
			if call.Function.Arguments != "" {
				emit(contracts.Event{
					Kind:      contracts.EventBlockDelta,
					Index:     index,
					DeltaKind: contracts.DeltaToolInputJSON,
					Text:      call.Function.Arguments,
				})
			}
		}
		if choice.FinishReason != nil {
			event := contracts.Event{Kind: contracts.EventMessageDelta, Stop: chatFinishToStop(*choice.FinishReason)}
			if chunk.Usage != nil {
				usage := usageFromWire(chunk.Usage)
				event.Usage = &usage
			}
			emit(event)
		}
	}
	if chunk.Usage != nil && len(chunk.Choices) == 0 {
		usage := usageFromWire(chunk.Usage)
		emit(contracts.Event{Kind: contracts.EventMessageDelta, Usage: &usage})
	}
}

// ---------------------------------------------------------------------------
// 流式编码：IR 事件 → 客户端 Chat SSE 帧
// ---------------------------------------------------------------------------

type chatStreamEncoder struct {
	id        string
	model     string
	toolIndex map[int]int
}

// NewStreamEncoder 返回 Chat Completions 的流式编码器。
func (chatCodec) NewStreamEncoder() contracts.StreamEncoder {
	return &chatStreamEncoder{toolIndex: make(map[int]int)}
}

type chatStreamChunk struct {
	ID      string             `json:"id,omitempty"`
	Object  string             `json:"object,omitempty"`
	Model   string             `json:"model,omitempty"`
	Choices []chatStreamChoice `json:"choices"`
	Usage   *chatWireUsage     `json:"usage,omitempty"`
}

type chatStreamChoice struct {
	Index        int             `json:"index"`
	Delta        chatStreamDelta `json:"delta"`
	FinishReason *string         `json:"finish_reason"`
}

type chatStreamDelta struct {
	Role      string               `json:"role,omitempty"`
	Content   string               `json:"content,omitempty"`
	ToolCalls []chatStreamToolCall `json:"tool_calls,omitempty"`
}

type chatStreamToolCall struct {
	Index    int    `json:"index"`
	ID       string `json:"id,omitempty"`
	Type     string `json:"type,omitempty"`
	Function struct {
		Name      string `json:"name,omitempty"`
		Arguments string `json:"arguments,omitempty"`
	} `json:"function"`
}

func (e *chatStreamEncoder) Encode(event contracts.Event) ([][]byte, error) {
	switch event.Kind {
	case contracts.EventMessageStart:
		if event.ID != "" {
			e.id = event.ID
		}
		if event.Model != "" {
			e.model = event.Model
		}
		return e.frames(e.chunkWithDelta(chatStreamDelta{Role: "assistant"})), nil

	case contracts.EventBlockStart:
		if event.Part != nil && event.Part.Kind == contracts.KindToolUse {
			index := len(e.toolIndex)
			e.toolIndex[event.Index] = index
			call := chatStreamToolCall{Index: index, ID: event.Part.ToolCallID, Type: "function"}
			call.Function.Name = event.Part.ToolName
			return e.frames(e.chunkWithDelta(chatStreamDelta{ToolCalls: []chatStreamToolCall{call}})), nil
		}
		return nil, nil

	case contracts.EventBlockDelta:
		switch event.DeltaKind {
		case contracts.DeltaText:
			return e.frames(e.chunkWithDelta(chatStreamDelta{Content: event.Text})), nil
		case contracts.DeltaToolInputJSON:
			index, ok := e.toolIndex[event.Index]
			if !ok {
				index = event.Index
			}
			call := chatStreamToolCall{Index: index}
			call.Function.Arguments = event.Text
			return e.frames(e.chunkWithDelta(chatStreamDelta{ToolCalls: []chatStreamToolCall{call}})), nil
		default:
			return nil, nil
		}

	case contracts.EventMessageDelta:
		finish := stopToChatFinish(event.Stop)
		chunk := e.chunkWithChoice(chatStreamChoice{Index: 0, FinishReason: &finish})
		if event.Usage != nil {
			chunk.Usage = usageToWire(*event.Usage)
		}
		return e.frames(chunk), nil

	case contracts.EventMessageStop:
		return [][]byte{encodeSSEFrame("", []byte("[DONE]"))}, nil

	case contracts.EventError:
		return e.EncodeError(derefStreamError(event.Err))
	}
	return nil, nil
}

func (e *chatStreamEncoder) EncodeError(se contracts.StreamError) ([][]byte, error) {
	if se.Type == "" {
		se.Type = "api_error"
	}
	payload := mustRaw(map[string]any{
		"error": map[string]any{
			"type":    se.Type,
			"code":    se.Code,
			"message": se.Message,
		},
	})
	return [][]byte{encodeSSEFrame("", payload)}, nil
}

func (e *chatStreamEncoder) Flush() ([][]byte, error) { return nil, nil }

func (e *chatStreamEncoder) chunkWithDelta(delta chatStreamDelta) chatStreamChunk {
	return e.chunkWithChoice(chatStreamChoice{Index: 0, Delta: delta})
}

func (e *chatStreamEncoder) chunkWithChoice(choice chatStreamChoice) chatStreamChunk {
	return chatStreamChunk{
		ID:      e.id,
		Object:  "chat.completion.chunk",
		Model:   e.model,
		Choices: []chatStreamChoice{choice},
	}
}

func (e *chatStreamEncoder) frames(chunk chatStreamChunk) [][]byte {
	return [][]byte{encodeSSEFrame("", mustRaw(chunk))}
}

func streamErrorEvent(code, message string) contracts.Event {
	return contracts.Event{
		Kind: contracts.EventError,
		Err:  &contracts.StreamError{Type: "api_error", Code: code, Message: message},
	}
}

func derefStreamError(se *contracts.StreamError) contracts.StreamError {
	if se == nil {
		return contracts.StreamError{Type: "api_error", Message: "上游流错误"}
	}
	return *se
}
