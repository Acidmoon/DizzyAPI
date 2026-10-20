package protoconv

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const responsesRequestJSON = `{
  "model": "gpt-5",
  "stream": true,
  "instructions": "be nice",
  "input": [
    {"type": "message", "role": "user", "content": [
      {"type": "input_text", "text": "hi"},
      {"type": "input_image", "image_url": "data:image/png;base64,AAA"}
    ]},
    {"type": "function_call", "call_id": "call_1", "name": "f", "arguments": "{\"x\":1}"},
    {"type": "function_call_output", "call_id": "call_1", "output": "42"}
  ],
  "tools": [{"type": "function", "name": "f", "description": "d", "parameters": {"type": "object"}, "strict": true}],
  "tool_choice": {"type": "function", "name": "f"},
  "temperature": 0.5,
  "top_p": 0.9,
  "max_output_tokens": 100,
  "store": true,
  "metadata": {"trace": "abc"},
  "reasoning": {"effort": "low"},
  "previous_response_id": "resp_prev"
}`

func TestResponsesParseRequest(t *testing.T) {
	codec := NewResponsesCodec()
	request, err := codec.ParseRequest([]byte(responsesRequestJSON))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	if request.Model != "gpt-5" || !request.Stream {
		t.Fatalf("model/stream 不对：%+v", request)
	}
	if len(request.System) != 1 || request.System[0].Text != "be nice" {
		t.Fatalf("instructions 应映射到 System：%+v", request.System)
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
	call := request.Messages[1]
	if call.Role != contracts.RoleAssistant || call.Parts[0].Kind != contracts.KindToolUse ||
		call.Parts[0].ToolCallID != "call_1" || call.Parts[0].ToolName != "f" {
		t.Fatalf("function_call 不对：%+v", call)
	}
	result := request.Messages[2]
	if result.Role != contracts.RoleTool || result.Parts[0].Kind != contracts.KindToolResult ||
		result.Parts[0].ToolResultFor != "call_1" || result.Parts[0].Text != "42" {
		t.Fatalf("function_call_output 不对：%+v", result)
	}
	if len(request.Tools) != 1 || request.Tools[0].Name != "f" || !request.Tools[0].Strict {
		t.Fatalf("tools 不对：%+v", request.Tools)
	}
	if request.ToolChoice == nil || request.ToolChoice.Mode != contracts.ToolChoiceTool || request.ToolChoice.Name != "f" {
		t.Fatalf("tool_choice 不对：%+v", request.ToolChoice)
	}
	if request.MaxTokens == nil || *request.MaxTokens != 100 {
		t.Fatalf("max_output_tokens 不对：%+v", request.MaxTokens)
	}
	if request.Sampling.Temperature == nil || *request.Sampling.Temperature != 0.5 {
		t.Fatalf("temperature 不对：%+v", request.Sampling.Temperature)
	}
	for _, key := range []string{"store", "metadata", "reasoning", "previous_response_id"} {
		if _, ok := request.Extras[key]; !ok {
			t.Fatalf("未建模字段 %s 应进 Extras：%+v", key, request.Extras)
		}
	}
}

func TestResponsesRequestRoundTrip(t *testing.T) {
	codec := NewResponsesCodec()
	first, err := codec.ParseRequest([]byte(responsesRequestJSON))
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
	if len(second.System) != 1 || second.System[0].Text != "be nice" {
		t.Fatalf("往返 instructions 不一致：%+v", second.System)
	}
	if len(second.Messages) != len(first.Messages) {
		t.Fatalf("往返消息数不一致：%d vs %d", len(second.Messages), len(first.Messages))
	}
	if len(second.Tools) != 1 || second.Tools[0].Name != "f" || !second.Tools[0].Strict {
		t.Fatalf("往返 tools 不一致：%+v", second.Tools)
	}
	if second.ToolChoice == nil || second.ToolChoice.Name != "f" {
		t.Fatalf("往返 tool_choice 不一致：%+v", second.ToolChoice)
	}
	if second.MaxTokens == nil || *second.MaxTokens != 100 {
		t.Fatalf("往返 max_output_tokens 不一致：%+v", second.MaxTokens)
	}
}

// TestResponsesToolLoopCallIDReversible 覆盖多轮工具循环：call_id 必须成对且可逆。
func TestResponsesToolLoopCallIDReversible(t *testing.T) {
	codec := NewResponsesCodec()
	body := `{
	  "model": "gpt-5",
	  "input": [
	    {"type": "message", "role": "user", "content": "weather?"},
	    {"type": "function_call", "id": "fc_abc", "call_id": "call_xyz", "name": "get_weather", "arguments": "{\"city\":\"SF\"}"},
	    {"type": "function_call_output", "call_id": "call_xyz", "output": "sunny"}
	  ]
	}`
	request, err := codec.ParseRequest([]byte(body))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	// IR 只保留 call_id（item id 不进 IR）。
	var callPart, resultPart *contracts.Part
	for index := range request.Messages {
		for partIndex := range request.Messages[index].Parts {
			part := &request.Messages[index].Parts[partIndex]
			switch part.Kind {
			case contracts.KindToolUse:
				callPart = part
			case contracts.KindToolResult:
				resultPart = part
			}
		}
	}
	if callPart == nil || resultPart == nil {
		t.Fatalf("工具对不完整：%+v", request.Messages)
	}
	if callPart.ToolCallID != "call_xyz" {
		t.Fatalf("ToolCallID 应取 call_id：%q", callPart.ToolCallID)
	}
	if resultPart.ToolResultFor != callPart.ToolCallID {
		t.Fatalf("回填必须配对：%q vs %q", resultPart.ToolResultFor, callPart.ToolCallID)
	}

	// 渲染后再解析，call_id 必须稳定可逆。
	rendered, err := codec.RenderRequest(request)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	if !strings.Contains(string(rendered), `"call_id":"call_xyz"`) {
		t.Fatalf("渲染丢失 call_id：%s", rendered)
	}
	second, err := codec.ParseRequest(rendered)
	if err != nil {
		t.Fatalf("再次 ParseRequest: %v", err)
	}
	var secondCall, secondResult string
	for _, message := range second.Messages {
		for _, part := range message.Parts {
			if part.Kind == contracts.KindToolUse {
				secondCall = part.ToolCallID
			}
			if part.Kind == contracts.KindToolResult {
				secondResult = part.ToolResultFor
			}
		}
	}
	if secondCall != "call_xyz" || secondResult != "call_xyz" {
		t.Fatalf("往返 call_id 不可逆：call=%q result=%q", secondCall, secondResult)
	}
}

func TestResponsesMaxOutputTokensBothWays(t *testing.T) {
	codec := NewResponsesCodec()
	request, err := codec.ParseRequest([]byte(`{"model":"m","max_output_tokens":7}`))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	if request.MaxTokens == nil || *request.MaxTokens != 7 {
		t.Fatalf("max_output_tokens 应映射到 MaxTokens：%+v", request.MaxTokens)
	}
	rendered, err := codec.RenderRequest(request)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	if !strings.Contains(string(rendered), `"max_output_tokens":7`) {
		t.Fatalf("渲染缺少 max_output_tokens：%s", rendered)
	}
}

func TestResponsesRejectsN(t *testing.T) {
	// 跨协议：Chat 客户端给 n=3，渲染到 Responses 必须报错，不能静默取第一个。
	chat, err := NewChatCodec().ParseRequest([]byte(`{"model":"m","messages":[],"n":3}`))
	if err != nil {
		t.Fatalf("Chat ParseRequest: %v", err)
	}
	if _, err := NewResponsesCodec().RenderRequest(chat); err == nil {
		t.Fatal("n>1 必须报错")
	}
}

func TestResponsesParseResponse(t *testing.T) {
	codec := NewResponsesCodec()
	body := `{
	  "id": "resp_1", "object": "response", "status": "completed", "model": "gpt-5",
	  "output": [
	    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "hi"}]},
	    {"type": "function_call", "call_id": "call_1", "name": "f", "arguments": "{}"}
	  ],
	  "output_text": "hi",
	  "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5,
	            "input_tokens_details": {"cached_tokens": 1},
	            "output_tokens_details": {"reasoning_tokens": 4}}
	}`
	response, err := codec.ParseResponse([]byte(body))
	if err != nil {
		t.Fatalf("ParseResponse: %v", err)
	}
	if response.ID != "resp_1" {
		t.Fatalf("id 不对：%q", response.ID)
	}
	if response.Stop != contracts.StopToolUse {
		t.Fatalf("含 function_call 应映射 StopToolUse：%q", response.Stop)
	}
	if response.Usage.InputTokens != 3 || response.Usage.OutputTokens != 2 ||
		response.Usage.CacheReadInputTokens != 1 || response.Usage.ReasoningTokens != 4 {
		t.Fatalf("用量不对：%+v", response.Usage)
	}
	var hasText, hasTool bool
	for _, part := range response.Parts {
		if part.Kind == contracts.KindText && part.Text == "hi" {
			hasText = true
		}
		if part.Kind == contracts.KindToolUse && part.ToolCallID == "call_1" {
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
	if !strings.Contains(string(rendered), `"object":"response"`) {
		t.Fatalf("响应缺 object=response：%s", rendered)
	}
	roundTrip, err := codec.ParseResponse(rendered)
	if err != nil {
		t.Fatalf("再次 ParseResponse: %v", err)
	}
	if roundTrip.Stop != contracts.StopToolUse || roundTrip.ID != "resp_1" {
		t.Fatalf("往返响应不一致：%+v", roundTrip)
	}
}

func TestResponsesStopReasonMapping(t *testing.T) {
	codec := NewResponsesCodec()
	cases := []struct {
		status string
		reason string
		want   contracts.StopReason
	}{
		{"completed", "", contracts.StopEndTurn},
		{"incomplete", "max_output_tokens", contracts.StopMaxTokens},
		{"incomplete", "content_filter", contracts.StopContentFilter},
		{"failed", "", contracts.StopUnknown},
	}
	for _, item := range cases {
		body := `{"id":"r","status":"` + item.status + `","output":[]`
		if item.reason != "" {
			body += `,"incomplete_details":{"reason":"` + item.reason + `"}`
		}
		body += `}`
		response, err := codec.ParseResponse([]byte(body))
		if err != nil {
			t.Fatalf("ParseResponse(%s/%s): %v", item.status, item.reason, err)
		}
		if response.Stop != item.want {
			t.Fatalf("stop 映射不对（%s/%s）：得到 %q，期望 %q", item.status, item.reason, response.Stop, item.want)
		}
	}

	// 渲染方向：max_tokens → incomplete + max_output_tokens。
	rendered, err := codec.RenderResponse(&contracts.Response{ID: "r", Stop: contracts.StopMaxTokens})
	if err != nil {
		t.Fatalf("RenderResponse: %v", err)
	}
	if !strings.Contains(string(rendered), `"status":"incomplete"`) ||
		!strings.Contains(string(rendered), `"reason":"max_output_tokens"`) {
		t.Fatalf("max_tokens 渲染不对：%s", rendered)
	}
}

func TestResponsesUnknownStopReasonNotes(t *testing.T) {
	codec := NewResponsesCodec()
	response, err := codec.ParseResponse([]byte(`{"id":"r","status":"incomplete","output":[],"incomplete_details":{"reason":"weird"}}`))
	if err != nil {
		t.Fatalf("ParseResponse: %v", err)
	}
	if response.Stop != contracts.StopUnknown {
		t.Fatalf("未知 reason 应为 StopUnknown：%q", response.Stop)
	}
	if len(response.Lossy) == 0 {
		t.Fatal("未知停止原因应记 LossyNote")
	}
}

func TestResponsesLossyNotes(t *testing.T) {
	codec := NewResponsesCodec()

	// 解析：input_image.file_id 是 IR 无法表示的，必须记 note。
	request, err := codec.ParseRequest([]byte(`{"model":"m","input":[{"type":"message","role":"user","content":[{"type":"input_image","file_id":"file-1"}]}]}`))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	if !hasLossyField(request.Lossy, "input[].content.input_image.file_id") {
		t.Fatalf("file_id 应记 LossyNote：%+v", request.Lossy)
	}

	// 解析：未知工具类型必须记 note。
	request, err = codec.ParseRequest([]byte(`{"model":"m","input":"hi","tools":[{"type":"web_search"}]}`))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	if !hasLossyField(request.Lossy, "tools.web_search") {
		t.Fatalf("未知工具应记 LossyNote：%+v", request.Lossy)
	}

	// 渲染：top_k / stop / seed / presence_penalty 等 Responses 不支持，必须记 note。
	topK := 5
	seed := int64(7)
	penalty := 0.1
	request = &contracts.Request{
		Model: "m",
		Sampling: contracts.Sampling{
			TopK:            &topK,
			Seed:            &seed,
			PresencePenalty: &penalty,
			Stop:            []string{"END"},
		},
	}
	if _, err := codec.RenderRequest(request); err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	for _, field := range []string{"top_k", "stop", "seed", "presence_penalty"} {
		if !hasLossyField(request.Lossy, field) {
			t.Fatalf("%s 应记 LossyNote：%+v", field, request.Lossy)
		}
	}

	// 其他来源的 Extras（如 Chat 的 logit_bias）不属于 Responses：丢弃并记 note，不得泄漏到上游。
	leaky := &contracts.Request{
		Model:  "m",
		Extras: map[string]json.RawMessage{"logit_bias": json.RawMessage(`{"1":2}`)},
	}
	rendered, err := codec.RenderRequest(leaky)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	if strings.Contains(string(rendered), "logit_bias") {
		t.Fatalf("非 Responses 字段不得写进上游请求：%s", rendered)
	}
	if !hasLossyField(leaky.Lossy, "extras.logit_bias") {
		t.Fatalf("丢弃 Extras 应记 LossyNote：%+v", leaky.Lossy)
	}

	// Responses 原生 Extras 原样写回。
	native := &contracts.Request{
		Model:  "m",
		Extras: map[string]json.RawMessage{"store": json.RawMessage(`true`)},
	}
	rendered, err = codec.RenderRequest(native)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	if !strings.Contains(string(rendered), `"store":true`) {
		t.Fatalf("Responses 原生 Extras 应写回：%s", rendered)
	}
}

func TestResponsesAssistantImageIsRejected(t *testing.T) {
	codec := NewResponsesCodec()
	request := &contracts.Request{
		Model: "m",
		Messages: []contracts.Message{{
			Role:  contracts.RoleAssistant,
			Parts: []contracts.Part{{Kind: contracts.KindImage, ImageURL: "data:image/png;base64,AAA"}},
		}},
	}
	if _, err := codec.RenderRequest(request); err == nil {
		t.Fatal("assistant 消息里的图片必须报错，不能静默丢图")
	}
}

func TestResponsesStreamDecodeFromTestdataSplit(t *testing.T) {
	payload, err := os.ReadFile("testdata/responses_stream.sse")
	if err != nil {
		t.Fatalf("读 testdata: %v", err)
	}
	decoder := NewResponsesCodec().NewStreamDecoder()
	events := pushSplit(decoder, payload, 5)

	if len(events) == 0 || events[0].Kind != contracts.EventMessageStart || events[0].ID != "resp_1" {
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

func TestResponsesStreamDecodeToolCalls(t *testing.T) {
	stream := strings.Join([]string{
		`event: response.created`,
		`data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
		``,
		`event: response.output_item.added`,
		`data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":""}}`,
		``,
		`event: response.function_call_arguments.delta`,
		`data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\"city\":"}`,
		``,
		`event: response.function_call_arguments.delta`,
		`data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"\"SF\"}"}`,
		``,
		`event: response.function_call_arguments.done`,
		`data: {"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc_1","name":"get_weather","arguments":"{\"city\":\"SF\"}"}`,
		``,
		`event: response.output_item.done`,
		`data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":"{\"city\":\"SF\"}"}}`,
		``,
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")

	decoder := NewResponsesCodec().NewStreamDecoder()
	var events []contracts.Event
	emit := func(event contracts.Event) { events = append(events, event) }
	if err := decoder.Push([]byte(stream), emit); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := decoder.Close(emit); err != nil {
		t.Fatalf("Close: %v", err)
	}

	var toolName, callID string
	var args strings.Builder
	var stop contracts.StopReason
	var stopCount int
	for _, event := range events {
		switch event.Kind {
		case contracts.EventBlockStart:
			if event.Part != nil && event.Part.Kind == contracts.KindToolUse {
				toolName = event.Part.ToolName
				callID = event.Part.ToolCallID
			}
		case contracts.EventBlockDelta:
			if event.DeltaKind == contracts.DeltaToolInputJSON {
				args.WriteString(event.Text)
			}
		case contracts.EventMessageDelta:
			stop = event.Stop
		case contracts.EventMessageStop:
			stopCount++
		}
	}
	if toolName != "get_weather" || callID != "call_1" {
		t.Fatalf("工具信息不对：name=%q call=%q", toolName, callID)
	}
	if args.String() != `{"city":"SF"}` {
		t.Fatalf("工具参数拼接不对：%q", args.String())
	}
	if stop != contracts.StopToolUse {
		t.Fatalf("停止原因应为 tool_use：%q", stop)
	}
	if stopCount != 1 {
		t.Fatalf("message_stop 应恰好一次：%d", stopCount)
	}
}

func TestResponsesStreamEncodeLifecycle(t *testing.T) {
	encoder := NewResponsesCodec().NewStreamEncoder()
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
	stop := contracts.StopEndTurn
	write(contracts.Event{Kind: contracts.EventMessageStart, ID: "resp_1", Model: "gpt-5"})
	write(contracts.Event{Kind: contracts.EventBlockStart, Index: 0, Part: &contracts.Part{Kind: contracts.KindText}})
	write(contracts.Event{Kind: contracts.EventBlockDelta, Index: 0, DeltaKind: contracts.DeltaText, Text: "Hel"})
	write(contracts.Event{Kind: contracts.EventBlockDelta, Index: 0, DeltaKind: contracts.DeltaText, Text: "lo"})
	write(contracts.Event{Kind: contracts.EventMessageDelta, Stop: stop})
	write(contracts.Event{Kind: contracts.EventMessageStop})

	payload := out.String()
	order := []string{
		"response.created",
		"response.output_item.added",
		"response.content_part.added",
		"response.output_text.delta",
		"response.output_text.done",
		"response.content_part.done",
		"response.output_item.done",
		"response.completed",
	}
	last := -1
	for _, name := range order {
		index := strings.Index(payload, name)
		if index < 0 {
			t.Fatalf("缺少事件 %s：\n%s", name, payload)
		}
		if index <= last {
			t.Fatalf("事件顺序不对，%s 出现在 %d（上次 %d）：\n%s", name, index, last, payload)
		}
		last = index
	}
	if strings.Contains(payload, "data: [DONE]") {
		t.Fatalf("Responses 流不应发 [DONE]：\n%s", payload)
	}
	if !strings.Contains(payload, `"delta":"Hel"`) || !strings.Contains(payload, `"delta":"lo"`) {
		t.Fatalf("文本增量不对：\n%s", payload)
	}
}

func TestResponsesStreamEncodeFunctionCall(t *testing.T) {
	encoder := NewResponsesCodec().NewStreamEncoder()
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
	write(contracts.Event{Kind: contracts.EventMessageStart, ID: "resp_1"})
	write(contracts.Event{Kind: contracts.EventBlockStart, Index: 1, Part: &contracts.Part{Kind: contracts.KindToolUse, ToolCallID: "call_1", ToolName: "f"}})
	write(contracts.Event{Kind: contracts.EventBlockDelta, Index: 1, DeltaKind: contracts.DeltaToolInputJSON, Text: `{"x":1}`})
	write(contracts.Event{Kind: contracts.EventMessageDelta, Stop: contracts.StopToolUse})
	write(contracts.Event{Kind: contracts.EventMessageStop})

	payload := out.String()
	if !strings.Contains(payload, "response.function_call_arguments.delta") {
		t.Fatalf("缺参数增量事件：\n%s", payload)
	}
	if !strings.Contains(payload, "response.function_call_arguments.done") {
		t.Fatalf("缺参数完成事件：\n%s", payload)
	}
	if !strings.Contains(payload, `"call_id":"call_1"`) {
		t.Fatalf("缺 call_id：\n%s", payload)
	}
	if !strings.Contains(payload, `"status":"completed"`) {
		t.Fatalf("completed 事件状态不对：\n%s", payload)
	}
}

func TestResponsesStreamEncodeError(t *testing.T) {
	encoder := NewResponsesCodec().NewStreamEncoder()
	frames, err := encoder.EncodeError(contracts.StreamError{Type: "api_error", Code: "X", Message: "boom"})
	if err != nil || len(frames) != 1 {
		t.Fatalf("EncodeError: %v %d", err, len(frames))
	}
	payload := string(frames[0])
	if !strings.Contains(payload, "response.failed") || !strings.Contains(payload, "boom") {
		t.Fatalf("错误帧不对：%s", payload)
	}
}

func TestResponsesStreamFlushIsEmpty(t *testing.T) {
	frames, err := NewResponsesCodec().NewStreamEncoder().Flush()
	if err != nil || len(frames) != 0 {
		t.Fatalf("Flush 应为空：%v %d", err, len(frames))
	}
}

func TestResponsesExtrasCaptured(t *testing.T) {
	codec := NewResponsesCodec()
	request, err := codec.ParseRequest([]byte(`{"model":"m","input":"hi","store":false,"truncation":"auto"}`))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	for _, key := range []string{"store", "truncation"} {
		if _, ok := request.Extras[key]; !ok {
			t.Fatalf("未建模字段 %s 应进 Extras：%+v", key, request.Extras)
		}
	}
	if _, err := json.Marshal(request.Extras); err != nil {
		t.Fatalf("Extras 序列化失败：%v", err)
	}
}

func TestResponsesTextFormatRoundTrip(t *testing.T) {
	codec := NewResponsesCodec()
	body := `{"model":"m","input":"hi","text":{"format":{"type":"json_schema","name":"out","schema":{"type":"object"},"strict":true}}}`
	request, err := codec.ParseRequest([]byte(body))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	if request.ResponseFormat == nil || request.ResponseFormat.Type != "json_schema" {
		t.Fatalf("text.format 应映射到 ResponseFormat：%+v", request.ResponseFormat)
	}
	rendered, err := codec.RenderRequest(request)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	if !strings.Contains(string(rendered), `"format":{"`) || !strings.Contains(string(rendered), `"name":"out"`) {
		t.Fatalf("text.format 渲染不对：%s", rendered)
	}
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

func pushSplit(decoder contracts.StreamDecoder, payload []byte, step int) []contracts.Event {
	var events []contracts.Event
	emit := func(event contracts.Event) { events = append(events, event) }
	for offset := 0; offset < len(payload); offset += step {
		end := offset + step
		if end > len(payload) {
			end = len(payload)
		}
		_ = decoder.Push(payload[offset:end], emit)
	}
	_ = decoder.Close(emit)
	return events
}

func hasLossyField(notes []contracts.LossyNote, field string) bool {
	for _, note := range notes {
		if note.Field == field {
			return true
		}
	}
	return false
}
