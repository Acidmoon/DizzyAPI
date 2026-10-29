package protoconv

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// geminiStreamSSE 是 Gemini 的流式帧：每帧是一个完整 GenerateContentResponse。
//
// 文本是**累计**形态（每帧给全文），这是 Gemini 官方流的行为；解码器必须
// 把它归一成增量事件（否则客户端会收到重复文本）。
const geminiStreamSSE = `data: {"responseId":"resp-1","modelVersion":"gemini-2.0-flash","candidates":[{"content":{"role":"model","parts":[{"text":"你"}]},"index":0}]}

data: {"responseId":"resp-1","modelVersion":"gemini-2.0-flash","candidates":[{"content":{"role":"model","parts":[{"text":"你好"}]},"index":0}]}

data: {"responseId":"resp-1","modelVersion":"gemini-2.0-flash","candidates":[{"content":{"role":"model","parts":[{"text":"你好啊"}]},"index":0,"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"cachedContentTokenCount":30,"thoughtsTokenCount":5,"totalTokenCount":120}}

data: [DONE]

`

// geminiStreamSSEIncremental 是增量形态：每帧只给新增片段。
const geminiStreamSSEIncremental = `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"你"}]}}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"好"}]}}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"！"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3}}

`

func collectEvents(t *testing.T, chunks []string) []contracts.Event {
	t.Helper()
	decoder := NewGeminiCodec().NewStreamDecoder()
	var events []contracts.Event
	emit := func(event contracts.Event) { events = append(events, event) }
	for _, chunk := range chunks {
		if err := decoder.Push([]byte(chunk), emit); err != nil {
			t.Fatalf("Push: %v", err)
		}
	}
	if err := decoder.Close(emit); err != nil {
		t.Fatalf("Close: %v", err)
	}
	return events
}

func TestGeminiStreamDecoderHandlesCumulativeText(t *testing.T) {
	events := collectEvents(t, []string{geminiStreamSSE})
	var text strings.Builder
	sawStart := false
	sawStop := false
	var usage *contracts.Usage
	for _, event := range events {
		switch event.Kind {
		case contracts.EventMessageStart:
			sawStart = true
			if event.ID != "resp-1" || event.Model != "gemini-2.0-flash" {
				t.Fatalf("message_start 不对：%+v", event)
			}
		case contracts.EventBlockDelta:
			if event.DeltaKind == contracts.DeltaText {
				text.WriteString(event.Text)
			}
		case contracts.EventMessageDelta:
			if event.Usage != nil {
				usage = event.Usage
			}
			if event.Stop != contracts.StopEndTurn {
				t.Fatalf("finishReason=STOP 应映射为 end_turn：%s", event.Stop)
			}
		case contracts.EventMessageStop:
			sawStop = true
		}
	}
	if !sawStart || !sawStop {
		t.Fatalf("缺少开始 / 结束事件：%+v", events)
	}
	// 累计形态必须被归一成纯增量：最终文本是「你好啊」，不是三段重复。
	if text.String() != "你好啊" {
		t.Fatalf("累计文本应归一成增量，最终为 %q", text.String())
	}
	if usage == nil {
		t.Fatal("应解析到 usage")
	}
	if usage.InputTokens != 100 || usage.OutputTokens != 20 || usage.CacheReadInputTokens != 30 {
		t.Fatalf("usage 不对：%+v", usage)
	}
	if usage.ReasoningTokens != 5 {
		t.Fatalf("reasoning 应为 5：%d", usage.ReasoningTokens)
	}
}

func TestGeminiStreamDecoderHandlesIncrementalText(t *testing.T) {
	events := collectEvents(t, []string{geminiStreamSSEIncremental})
	var text strings.Builder
	for _, event := range events {
		if event.Kind == contracts.EventBlockDelta && event.DeltaKind == contracts.DeltaText {
			text.WriteString(event.Text)
		}
	}
	if text.String() != "你好！" {
		t.Fatalf("增量形态应原样拼接，得到 %q", text.String())
	}
}

func TestGeminiStreamDecoderHandlesSplitChunks(t *testing.T) {
	// 逐字节喂入：跨 chunk 的半截 JSON 必须被正确重组。
	full := geminiStreamSSE
	var chunks []string
	for index := 0; index < len(full); index += 7 {
		end := index + 7
		if end > len(full) {
			end = len(full)
		}
		chunks = append(chunks, full[index:end])
	}
	events := collectEvents(t, chunks)
	var text strings.Builder
	for _, event := range events {
		if event.Kind == contracts.EventBlockDelta && event.DeltaKind == contracts.DeltaText {
			text.WriteString(event.Text)
		}
	}
	if text.String() != "你好啊" {
		t.Fatalf("逐字节喂入后文本应为「你好啊」，得到 %q", text.String())
	}
}

func TestGeminiStreamDecoderHandlesToolCall(t *testing.T) {
	stream := `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"f","args":{"x":1}}}]}}]}

data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}]}

`
	events := collectEvents(t, []string{stream})
	var toolName string
	var toolArgs string
	sawBlock := false
	for _, event := range events {
		if event.Kind == contracts.EventBlockStart && event.Part != nil &&
			event.Part.Kind == contracts.KindToolUse {
			sawBlock = true
			toolName = event.Part.ToolName
		}
		if event.Kind == contracts.EventBlockDelta && event.DeltaKind == contracts.DeltaToolInputJSON {
			toolArgs += event.Text
		}
	}
	if !sawBlock || toolName != "f" {
		t.Fatalf("应产出 tool_use 块：name=%q", toolName)
	}
	if toolArgs != `{"x":1}` {
		t.Fatalf("工具参数不对：%q", toolArgs)
	}
}

func TestGeminiStreamDecoderRejectsBadJSON(t *testing.T) {
	events := collectEvents(t, []string{"data: {not json\n\n"})
	sawError := false
	for _, event := range events {
		if event.Kind == contracts.EventError {
			sawError = true
		}
	}
	if !sawError {
		t.Fatalf("坏 JSON 应产出错误事件：%+v", events)
	}
}

// IR 事件 → Gemini SSE 帧。
func TestGeminiStreamEncoderProducesGeminiFrames(t *testing.T) {
	encoder := NewGeminiCodec().NewStreamEncoder()
	var frames []string
	encode := func(event contracts.Event) {
		out, err := encoder.Encode(event)
		if err != nil {
			t.Fatalf("Encode: %v", err)
		}
		for _, frame := range out {
			frames = append(frames, string(frame))
		}
	}
	encode(contracts.Event{Kind: contracts.EventMessageStart, ID: "resp-1", Model: "gemini-2.0-flash"})
	encode(contracts.Event{Kind: contracts.EventBlockStart, Index: 0, Part: &contracts.Part{Kind: contracts.KindText}})
	encode(contracts.Event{Kind: contracts.EventBlockDelta, Index: 0, DeltaKind: contracts.DeltaText, Text: "hi"})
	encode(contracts.Event{Kind: contracts.EventMessageDelta, Stop: contracts.StopEndTurn, Usage: &contracts.Usage{
		InputTokens: 70, OutputTokens: 5, CacheReadInputTokens: 30,
	}})
	encode(contracts.Event{Kind: contracts.EventMessageStop})

	if len(frames) == 0 {
		t.Fatal("没有产出任何帧")
	}
	joined := strings.Join(frames, "")
	if !strings.Contains(joined, `"text":"hi"`) {
		t.Fatalf("帧里缺少文本：%s", joined)
	}
	if !strings.Contains(joined, `"finishReason":"STOP"`) {
		t.Fatalf("帧里缺少 finishReason：%s", joined)
	}
	if !strings.Contains(joined, `"responseId":"resp-1"`) {
		t.Fatalf("帧里缺少 responseId：%s", joined)
	}
	if !strings.Contains(joined, `"candidatesTokenCount":5`) {
		t.Fatalf("帧里缺少 usage：%s", joined)
	}
	// 每帧必须是合法 JSON（Gemini 的流式帧是完整响应对象）。
	for _, frame := range frames {
		payload := strings.TrimPrefix(strings.TrimSpace(frame), "data: ")
		payload = strings.TrimSpace(payload)
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var decoded map[string]any
		if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
			t.Fatalf("帧不是合法 JSON：%v（%s）", err, payload)
		}
	}
}

// Gemini 客户端 → OpenAI 上游的流式：事件能串起来。
func TestGeminiStreamRoundTripThroughChatEncoder(t *testing.T) {
	decoder := NewGeminiCodec().NewStreamDecoder()
	encoder := NewChatCodec().NewStreamEncoder()
	var frames []string
	emit := func(event contracts.Event) {
		out, err := encoder.Encode(event)
		if err != nil {
			t.Fatalf("Encode: %v", err)
		}
		for _, frame := range out {
			frames = append(frames, string(frame))
		}
	}
	if err := decoder.Push([]byte(geminiStreamSSE), emit); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := decoder.Close(emit); err != nil {
		t.Fatalf("Close: %v", err)
	}
	joined := strings.Join(frames, "")
	if !strings.Contains(joined, `"content":"你"`) {
		t.Fatalf("Chat 帧里缺少文本增量：%s", joined)
	}
	if !strings.Contains(joined, `"finish_reason":"stop"`) {
		t.Fatalf("Chat 帧里缺少 finish_reason：%s", joined)
	}
	if !strings.Contains(joined, "[DONE]") {
		t.Fatalf("Chat 帧里缺少结束哨兵：%s", joined)
	}
}
