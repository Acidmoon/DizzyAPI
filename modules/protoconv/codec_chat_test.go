package protoconv

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const chatRequestJSON = `{
  "model": "gpt-4",
  "stream": true,
  "messages": [
    {"role": "system", "content": "be nice"},
    {"role": "user", "content": [{"type": "text", "text": "hi"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}}]},
    {"role": "assistant", "content": "sure", "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "f", "arguments": "{\"x\":1}"}}]},
    {"role": "tool", "tool_call_id": "call_1", "content": "42"}
  ],
  "tools": [{"type": "function", "function": {"name": "f", "description": "d", "parameters": {"type": "object"}, "strict": true}}],
  "tool_choice": {"type": "function", "function": {"name": "f"}},
  "temperature": 0.5,
  "max_tokens": 100,
  "stop": ["END"],
  "response_format": {"type": "json_object"},
  "user": "u1"
}`

func TestChatParseRequest(t *testing.T) {
	codec := NewChatCodec()
	request, err := codec.ParseRequest([]byte(chatRequestJSON))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	if request.Model != "gpt-4" || !request.Stream {
		t.Fatalf("model/stream 不对：%+v", request)
	}
	if len(request.System) != 1 || request.System[0].Text != "be nice" {
		t.Fatalf("system 不对：%+v", request.System)
	}
	if len(request.Messages) != 3 {
		t.Fatalf("消息数不对：%d", len(request.Messages))
	}
	user := request.Messages[0]
	if user.Role != contracts.RoleUser || len(user.Parts) != 2 {
		t.Fatalf("user 消息不对：%+v", user)
	}
	if user.Parts[0].Kind != contracts.KindText || user.Parts[0].Text != "hi" {
		t.Fatalf("文本片段不对：%+v", user.Parts[0])
	}
	if user.Parts[1].Kind != contracts.KindImage || user.Parts[1].ImageURL != "data:image/png;base64,AAA" {
		t.Fatalf("图片片段不对：%+v", user.Parts[1])
	}
	assistant := request.Messages[1]
	var toolUse *contracts.Part
	for index := range assistant.Parts {
		if assistant.Parts[index].Kind == contracts.KindToolUse {
			toolUse = &assistant.Parts[index]
		}
	}
	if toolUse == nil || toolUse.ToolCallID != "call_1" || toolUse.ToolName != "f" {
		t.Fatalf("tool_use 片段不对：%+v", assistant.Parts)
	}
	tool := request.Messages[2]
	if tool.Role != contracts.RoleTool || tool.Parts[0].Kind != contracts.KindToolResult || tool.Parts[0].ToolResultFor != "call_1" {
		t.Fatalf("tool 消息不对：%+v", tool)
	}
	if len(request.Tools) != 1 || request.Tools[0].Name != "f" || !request.Tools[0].Strict {
		t.Fatalf("tools 不对：%+v", request.Tools)
	}
	if request.ToolChoice == nil || request.ToolChoice.Mode != contracts.ToolChoiceTool || request.ToolChoice.Name != "f" {
		t.Fatalf("tool_choice 不对：%+v", request.ToolChoice)
	}
	if request.Sampling.Temperature == nil || *request.Sampling.Temperature != 0.5 {
		t.Fatalf("temperature 不对：%+v", request.Sampling.Temperature)
	}
	if len(request.Sampling.Stop) != 1 || request.Sampling.Stop[0] != "END" {
		t.Fatalf("stop 不对：%+v", request.Sampling.Stop)
	}
	if request.MaxTokens == nil || *request.MaxTokens != 100 {
		t.Fatalf("max_tokens 不对：%+v", request.MaxTokens)
	}
	if request.ResponseFormat == nil || request.ResponseFormat.Type != "json_object" {
		t.Fatalf("response_format 不对：%+v", request.ResponseFormat)
	}
}

func TestChatRequestRoundTrip(t *testing.T) {
	codec := NewChatCodec()
	first, err := codec.ParseRequest([]byte(chatRequestJSON))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	rendered, err := codec.RenderRequest(first)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	second, err := codec.ParseRequest(rendered)
	if err != nil {
		t.Fatalf("再次 ParseRequest: %v", err)
	}
	if second.Model != first.Model || second.Stream != first.Stream {
		t.Fatalf("往返 model/stream 不一致：%+v", second)
	}
	if len(second.Messages) != len(first.Messages) {
		t.Fatalf("往返消息数不一致：%d vs %d", len(second.Messages), len(first.Messages))
	}
	if len(second.Tools) != 1 || second.Tools[0].Name != "f" {
		t.Fatalf("往返 tools 不一致：%+v", second.Tools)
	}
	if second.ToolChoice == nil || second.ToolChoice.Name != "f" {
		t.Fatalf("往返 tool_choice 不一致：%+v", second.ToolChoice)
	}
}

func TestChatParseRequestMaxCompletionTokensIsCoerced(t *testing.T) {
	codec := NewChatCodec()
	request, err := codec.ParseRequest([]byte(`{"model":"m","max_completion_tokens":10}`))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	if request.MaxTokens == nil || *request.MaxTokens != 10 {
		t.Fatalf("max_completion_tokens 应映射到 MaxTokens：%+v", request.MaxTokens)
	}
	found := false
	for _, note := range request.Lossy {
		if note.Field == "max_completion_tokens" {
			found = true
		}
	}
	if !found {
		t.Fatal("max_completion_tokens 应记一条 LossyNote")
	}
}

func TestChatParseRequestRejectsNonJSON(t *testing.T) {
	if _, err := NewChatCodec().ParseRequest([]byte("not json")); err == nil {
		t.Fatal("非 JSON 必须报错")
	}
}

func TestChatRenderTextOnlyMessageIsString(t *testing.T) {
	codec := NewChatCodec()
	request, err := codec.ParseRequest([]byte(`{"model":"m","messages":[{"role":"user","content":"hello"}]}`))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	rendered, err := codec.RenderRequest(request)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	if !strings.Contains(string(rendered), `"content":"hello"`) {
		t.Fatalf("纯文本内容应以字符串渲染：%s", rendered)
	}
}

func TestChatParseAndRenderResponse(t *testing.T) {
	codec := NewChatCodec()
	body := `{"id":"chatcmpl-1","model":"gpt-4","choices":[{"index":0,"message":{"role":"assistant","content":"hi","tool_calls":[{"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"completion_tokens_details":{"reasoning_tokens":1}}}`
	response, err := codec.ParseResponse([]byte(body))
	if err != nil {
		t.Fatalf("ParseResponse: %v", err)
	}
	if response.ID != "chatcmpl-1" || response.Stop != contracts.StopToolUse {
		t.Fatalf("响应头不对：%+v", response)
	}
	if response.Usage.InputTokens != 3 || response.Usage.OutputTokens != 2 || response.Usage.ReasoningTokens != 1 {
		t.Fatalf("用量不对：%+v", response.Usage)
	}
	var hasText, hasTool bool
	for _, part := range response.Parts {
		if part.Kind == contracts.KindText && part.Text == "hi" {
			hasText = true
		}
		if part.Kind == contracts.KindToolUse && part.ToolName == "f" {
			hasTool = true
		}
	}
	if !hasText || !hasTool {
		t.Fatalf("响应片段不对：%+v", response.Parts)
	}

	rendered, err := codec.RenderResponse(response)
	if err != nil {
		t.Fatalf("RenderResponse: %v", err)
	}
	roundTrip, err := codec.ParseResponse(rendered)
	if err != nil {
		t.Fatalf("再次 ParseResponse: %v", err)
	}
	if roundTrip.ID != response.ID || roundTrip.Stop != contracts.StopToolUse {
		t.Fatalf("往返响应不一致：%+v", roundTrip)
	}
}

func TestChatStreamDecodeFromTestdataSplit(t *testing.T) {
	payload, err := os.ReadFile("testdata/chat_stream.sse")
	if err != nil {
		t.Fatalf("读 testdata: %v", err)
	}
	codec := NewChatCodec()
	decoder := codec.NewStreamDecoder()

	var events []contracts.Event
	emit := func(event contracts.Event) { events = append(events, event) }

	// 以 5 字节为一块，强制把 data: 行切成半截。
	for offset := 0; offset < len(payload); offset += 5 {
		end := offset + 5
		if end > len(payload) {
			end = len(payload)
		}
		if err := decoder.Push(payload[offset:end], emit); err != nil {
			t.Fatalf("Push(%d): %v", offset, err)
		}
	}
	if err := decoder.Close(emit); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if len(events) == 0 || events[0].Kind != contracts.EventMessageStart || events[0].ID != "chatcmpl-1" {
		t.Fatalf("首个事件应是 message_start：%+v", events)
	}
	var text strings.Builder
	var sawBlockStart, sawDelta, sawStop bool
	for _, event := range events {
		switch event.Kind {
		case contracts.EventBlockStart:
			if event.Part != nil && event.Part.Kind == contracts.KindText {
				sawBlockStart = true
			}
		case contracts.EventBlockDelta:
			if event.DeltaKind == contracts.DeltaText {
				text.WriteString(event.Text)
			}
		case contracts.EventMessageDelta:
			if event.Stop == contracts.StopEndTurn {
				sawDelta = true
				if event.Usage == nil || event.Usage.InputTokens != 3 {
					t.Fatalf("message_delta 用量不对：%+v", event.Usage)
				}
			}
		case contracts.EventMessageStop:
			sawStop = true
		}
	}
	if !sawBlockStart || !sawDelta || !sawStop {
		t.Fatalf("事件序列不完整：%+v", events)
	}
	if text.String() != "Hello" {
		t.Fatalf("文本增量拼接不对：%q", text.String())
	}
}

func TestChatStreamDecodeToolCalls(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"id":"c","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}`,
		``,
		`data: {"id":"c","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]},"finish_reason":null}]}`,
		``,
		`data: {"id":"c","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"SF\"}"}}]},"finish_reason":null}]}`,
		``,
		`data: {"id":"c","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")

	codec := NewChatCodec()
	decoder := codec.NewStreamDecoder()
	var events []contracts.Event
	emit := func(event contracts.Event) { events = append(events, event) }
	if err := decoder.Push([]byte(stream), emit); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := decoder.Close(emit); err != nil {
		t.Fatalf("Close: %v", err)
	}

	var toolName string
	var args strings.Builder
	var stop contracts.StopReason
	for _, event := range events {
		switch event.Kind {
		case contracts.EventBlockStart:
			if event.Part != nil && event.Part.Kind == contracts.KindToolUse {
				toolName = event.Part.ToolName
			}
		case contracts.EventBlockDelta:
			if event.DeltaKind == contracts.DeltaToolInputJSON {
				args.WriteString(event.Text)
			}
		case contracts.EventMessageDelta:
			stop = event.Stop
		}
	}
	if toolName != "get_weather" {
		t.Fatalf("工具名不对：%q", toolName)
	}
	if args.String() != `{"city":"SF"}` {
		t.Fatalf("工具参数拼接不对：%q", args.String())
	}
	if stop != contracts.StopToolUse {
		t.Fatalf("停止原因不对：%q", stop)
	}
}

func TestChatStreamEncodeProducesChatFrames(t *testing.T) {
	codec := NewChatCodec()
	encoder := codec.NewStreamEncoder()

	var out strings.Builder
	write := func(events ...contracts.Event) {
		for _, event := range events {
			frames, err := encoder.Encode(event)
			if err != nil {
				t.Fatalf("Encode: %v", err)
			}
			for _, frame := range frames {
				out.Write(frame)
			}
		}
	}
	write(contracts.Event{Kind: contracts.EventMessageStart, ID: "c1", Model: "m"})
	write(contracts.Event{Kind: contracts.EventBlockStart, Index: 0, Part: &contracts.Part{Kind: contracts.KindText}})
	write(contracts.Event{Kind: contracts.EventBlockDelta, Index: 0, DeltaKind: contracts.DeltaText, Text: "hi"})
	stop := contracts.StopEndTurn
	write(contracts.Event{Kind: contracts.EventMessageDelta, Stop: stop})
	write(contracts.Event{Kind: contracts.EventMessageStop})

	payload := out.String()
	if !strings.Contains(payload, `"role":"assistant"`) {
		t.Fatalf("缺少 role 帧：%s", payload)
	}
	if !strings.Contains(payload, `"content":"hi"`) {
		t.Fatalf("缺少内容增量：%s", payload)
	}
	if !strings.Contains(payload, `"finish_reason":"stop"`) {
		t.Fatalf("缺少 finish_reason：%s", payload)
	}
	if !strings.Contains(payload, "data: [DONE]") {
		t.Fatalf("缺少 [DONE]：%s", payload)
	}
}

func TestChatStreamEncodeError(t *testing.T) {
	codec := NewChatCodec()
	encoder := codec.NewStreamEncoder()
	frames, err := encoder.EncodeError(contracts.StreamError{Type: "api_error", Code: "X", Message: "boom"})
	if err != nil || len(frames) != 1 {
		t.Fatalf("EncodeError: %v %d", err, len(frames))
	}
	if !strings.Contains(string(frames[0]), "api_error") {
		t.Fatalf("错误帧不对：%s", frames[0])
	}
}

func TestChatExtrasCaptured(t *testing.T) {
	codec := NewChatCodec()
	request, err := codec.ParseRequest([]byte(`{"model":"m","logit_bias":{"1":2},"parallel_tool_calls":false}`))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	if _, ok := request.Extras["logit_bias"]; !ok {
		t.Fatalf("未建模字段应进 Extras：%+v", request.Extras)
	}
	// Extras 必须可序列化，供审计。
	if _, err := json.Marshal(request.Extras); err != nil {
		t.Fatalf("Extras 序列化失败：%v", err)
	}
}
