package protoconv

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const anthropicRequestJSON = `{
  "model": "claude-3-5-sonnet",
  "max_tokens": 100,
  "stream": true,
  "system": [{"type": "text", "text": "be nice", "cache_control": {"type": "ephemeral"}}],
  "messages": [
    {"role": "user", "content": [
      {"type": "text", "text": "hi"},
      {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAA"}},
      {"type": "image", "source": {"type": "url", "url": "https://example.com/x.png"}}
    ]},
    {"role": "assistant", "content": [
      {"type": "thinking", "thinking": "let me think", "signature": "sig-1"},
      {"type": "redacted_thinking", "data": "opaque"},
      {"type": "text", "text": "sure"},
      {"type": "tool_use", "id": "toolu_1", "name": "f", "input": {"x": 1}}
    ]},
    {"role": "user", "content": [
      {"type": "tool_result", "tool_use_id": "toolu_1", "content": "42", "is_error": false}
    ]}
  ],
  "tools": [{"name": "f", "description": "d", "input_schema": {"type": "object"}, "strict": true}],
  "tool_choice": {"type": "tool", "name": "f"},
  "temperature": 0.5,
  "top_p": 0.9,
  "top_k": 5,
  "stop_sequences": ["END"],
  "metadata": {"user_id": "u1"},
  "thinking": {"type": "enabled", "budget_tokens": 2048}
}`

func hasNote(notes []contracts.LossyNote, field, action string) bool {
	for _, note := range notes {
		if note.Field == field && note.Action == action {
			return true
		}
	}
	return false
}

func TestAnthropicParseRequest(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{})
	request, err := codec.ParseRequest([]byte(anthropicRequestJSON))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	if request.Model != "claude-3-5-sonnet" || !request.Stream {
		t.Fatalf("model/stream 不对：%+v", request)
	}
	if request.MaxTokens == nil || *request.MaxTokens != 100 {
		t.Fatalf("max_tokens 不对：%+v", request.MaxTokens)
	}
	if request.User != "u1" {
		t.Fatalf("metadata.user_id 未映射到 User：%q", request.User)
	}
	if len(request.System) != 1 || request.System[0].Text != "be nice" || !hasCacheControl(request.System[0].Raw) {
		t.Fatalf("system 不对：%+v", request.System)
	}
	if len(request.Messages) != 3 {
		t.Fatalf("消息数不对：%d", len(request.Messages))
	}

	user := request.Messages[0]
	if user.Role != contracts.RoleUser || len(user.Parts) != 3 {
		t.Fatalf("user 消息不对：%+v", user)
	}
	if user.Parts[0].Kind != contracts.KindText || user.Parts[0].Text != "hi" {
		t.Fatalf("文本片段不对：%+v", user.Parts[0])
	}
	if user.Parts[1].Kind != contracts.KindImage || user.Parts[1].ImageURL != "data:image/png;base64,AAA" {
		t.Fatalf("base64 图片未转成 data URL：%+v", user.Parts[1])
	}
	if user.Parts[2].Kind != contracts.KindImage || user.Parts[2].ImageURL != "https://example.com/x.png" {
		t.Fatalf("url 图片不对：%+v", user.Parts[2])
	}

	assistant := request.Messages[1]
	var thinking, redacted, toolUse *contracts.Part
	for index := range assistant.Parts {
		switch {
		case assistant.Parts[index].Kind == contracts.KindThinking && assistant.Parts[index].Redacted:
			redacted = &assistant.Parts[index]
		case assistant.Parts[index].Kind == contracts.KindThinking:
			thinking = &assistant.Parts[index]
		case assistant.Parts[index].Kind == contracts.KindToolUse:
			toolUse = &assistant.Parts[index]
		}
	}
	if thinking == nil || thinking.Text != "let me think" || thinking.Signature != "sig-1" {
		t.Fatalf("thinking 签名未保留：%+v", assistant.Parts)
	}
	if redacted == nil || redacted.Text != "opaque" {
		t.Fatalf("redacted_thinking 未保留：%+v", assistant.Parts)
	}
	if toolUse == nil || toolUse.ToolCallID != "toolu_1" || toolUse.ToolName != "f" {
		t.Fatalf("tool_use 不对：%+v", assistant.Parts)
	}

	result := request.Messages[2]
	if result.Role != contracts.RoleUser || result.Parts[0].Kind != contracts.KindToolResult || result.Parts[0].ToolResultFor != "toolu_1" {
		t.Fatalf("tool_result 不对：%+v", result)
	}
	if result.Parts[0].Text != "42" {
		t.Fatalf("tool_result 文本不对：%+v", result.Parts[0])
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
	if request.Sampling.TopK == nil || *request.Sampling.TopK != 5 {
		t.Fatalf("top_k 不对：%+v", request.Sampling.TopK)
	}
	if len(request.Sampling.Stop) != 1 || request.Sampling.Stop[0] != "END" {
		t.Fatalf("stop_sequences 不对：%+v", request.Sampling.Stop)
	}
	// thinking 配置是 Anthropic 专有：进 Extras。
	if _, ok := request.Extras["thinking"]; !ok {
		t.Fatalf("thinking 配置应进 Extras：%+v", request.Extras)
	}
}

func TestAnthropicRequestRoundTrip(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{})
	first, err := codec.ParseRequest([]byte(anthropicRequestJSON))
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
	if len(second.Tools) != 1 || second.Tools[0].Name != "f" || !second.Tools[0].Strict {
		t.Fatalf("往返 tools 不一致：%+v", second.Tools)
	}
	if second.ToolChoice == nil || second.ToolChoice.Name != "f" {
		t.Fatalf("往返 tool_choice 不一致：%+v", second.ToolChoice)
	}
	// 图片、system 的 cache_control 都要能原样带回。
	if !hasCacheControl(second.System[0].Raw) {
		t.Fatalf("往返 system cache_control 丢失：%+v", second.System)
	}
	if second.Messages[0].Parts[1].ImageURL != "data:image/png;base64,AAA" {
		t.Fatalf("往返图片丢失：%+v", second.Messages[0].Parts)
	}
}

func TestAnthropicRenderDefaultsMaxTokens(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{DefaultMaxTokens: 777})
	request := &contracts.Request{
		Model:    "claude",
		Messages: []contracts.Message{{Role: contracts.RoleUser, Parts: []contracts.Part{{Kind: contracts.KindText, Text: "hi"}}}},
	}
	rendered, err := codec.RenderRequest(request)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	var wire struct {
		MaxTokens int `json:"max_tokens"`
	}
	if err := json.Unmarshal(rendered, &wire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if wire.MaxTokens != 777 {
		t.Fatalf("max_tokens 应补默认值 777，得到 %d", wire.MaxTokens)
	}
	if !hasNote(request.Lossy, "max_tokens", "defaulted") {
		t.Fatalf("max_tokens 补齐应记 note：%+v", request.Lossy)
	}
}

func TestAnthropicRenderRejectsMultipleN(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{})
	n := 2
	request := &contracts.Request{Model: "claude", Sampling: contracts.Sampling{N: &n}}
	if _, err := codec.RenderRequest(request); err == nil {
		t.Fatal("n>1 必须报错")
	}
}

func TestAnthropicToolPairingCoerced(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{})
	request := &contracts.Request{
		Model: "claude",
		Messages: []contracts.Message{
			{Role: contracts.RoleUser, Parts: []contracts.Part{{Kind: contracts.KindText, Text: "hi"}}},
			{Role: contracts.RoleAssistant, Parts: []contracts.Part{
				{Kind: contracts.KindToolUse, ToolCallID: "call_1", ToolName: "f", ToolInput: json.RawMessage(`{"x":1}`)},
			}},
		},
	}
	rendered, err := codec.RenderRequest(request)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	if !hasNote(request.Lossy, "tool_result", "coerced") {
		t.Fatalf("配对修补应记 note：%+v", request.Lossy)
	}
	var wire struct {
		Messages []struct {
			Role    string            `json:"role"`
			Content []json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(rendered, &wire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(wire.Messages) != 3 {
		t.Fatalf("应补出一个 user 占位消息，得到 %d 条", len(wire.Messages))
	}
	last := wire.Messages[2]
	if last.Role != "user" {
		t.Fatalf("占位消息角色应为 user：%+v", last)
	}
	var result struct {
		Type      string `json:"type"`
		ToolUseID string `json:"tool_use_id"`
		IsError   bool   `json:"is_error"`
	}
	if err := json.Unmarshal(last.Content[0], &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if result.Type != "tool_result" || result.ToolUseID != "call_1" || !result.IsError {
		t.Fatalf("占位结果应为 is_error 的 tool_result：%+v", result)
	}
}

func TestAnthropicToolPairingOrphanResultDropped(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{})
	request := &contracts.Request{
		Model: "claude",
		Messages: []contracts.Message{
			{Role: contracts.RoleAssistant, Parts: []contracts.Part{{Kind: contracts.KindText, Text: "no tool"}}},
			{Role: contracts.RoleUser, Parts: []contracts.Part{{Kind: contracts.KindToolResult, ToolResultFor: "call_orphan", Text: "x"}}},
		},
	}
	rendered, err := codec.RenderRequest(request)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	if !hasNote(request.Lossy, "tool_result", "coerced") {
		t.Fatalf("孤儿 tool_result 应记 note：%+v", request.Lossy)
	}
	if strings.Contains(string(rendered), "call_orphan") {
		t.Fatalf("孤儿 tool_result 应被丢弃：%s", rendered)
	}
}

func TestAnthropicToolIDMappingReversible(t *testing.T) {
	cases := []string{
		"call_abc123",         // OpenAI 形态（安全，原样）
		"toolu_01ABCdef",      // Anthropic 原生（安全，原样）
		"dv_QmFzaDowI2E2NWI2", // 安全
		"Bash:0#a65b",         // 含非法字符，必须编码
		"weird id with space", // 含空格
	}
	for _, id := range cases {
		out := anthropicOutID(id)
		if !anthropicSafeID.MatchString(out) {
			t.Fatalf("anthropicOutID(%q) = %q 不是 Anthropic 合法 id", id, out)
		}
		if back := anthropicInID(out); back != id {
			t.Fatalf("id 映射不可逆：%q -> %q -> %q", id, out, back)
		}
	}
	// 安全 id 不应被改动。
	if got := anthropicOutID("call_abc"); got != "call_abc" {
		t.Fatalf("安全 id 应原样：%q", got)
	}
	// 带标记前缀的原始 id 不能被误判为已编码。
	marker := anthropicToolIDMark + "abc"
	if back := anthropicInID(marker); back != marker {
		t.Fatalf("非法 base64 的标记 id 不应被还原：%q -> %q", marker, back)
	}
}

func TestAnthropicMultiTurnToolLoopKeepsIDsPaired(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{})
	// 客户端用 OpenAI 形态 id，跨协议渲染到 Anthropic 后，assistant tool_use 与 user tool_result 的 id 必须一致。
	request := &contracts.Request{
		Model: "claude",
		Messages: []contracts.Message{
			{Role: contracts.RoleUser, Parts: []contracts.Part{{Kind: contracts.KindText, Text: "weather?"}}},
			{Role: contracts.RoleAssistant, Parts: []contracts.Part{
				{Kind: contracts.KindToolUse, ToolCallID: "call_1", ToolName: "get_weather", ToolInput: json.RawMessage(`{"city":"SF"}`)},
			}},
			{Role: contracts.RoleTool, Parts: []contracts.Part{
				{Kind: contracts.KindToolResult, ToolResultFor: "call_1", Text: "sunny"},
			}},
		},
	}
	rendered, err := codec.RenderRequest(request)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	// 没有缺失结果，不该出现 coerced 修补。
	if hasNote(request.Lossy, "tool_result", "coerced") {
		t.Fatalf("成对的 tool_use/tool_result 不该被修补：%+v", request.Lossy)
	}
	// 回读并检查 id 配对。
	second, err := codec.ParseRequest(rendered)
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	var useID, resultFor string
	for _, message := range second.Messages {
		for _, part := range message.Parts {
			if part.Kind == contracts.KindToolUse {
				useID = part.ToolCallID
			}
			if part.Kind == contracts.KindToolResult {
				resultFor = part.ToolResultFor
			}
		}
	}
	if useID == "" || useID != resultFor {
		t.Fatalf("tool_use/tool_result id 未配对：use=%q result=%q", useID, resultFor)
	}
}

func TestAnthropicStopReasonMapping(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{})
	cases := []struct {
		wire string
		want contracts.StopReason
		note bool
	}{
		{"end_turn", contracts.StopEndTurn, false},
		{"max_tokens", contracts.StopMaxTokens, false},
		{"tool_use", contracts.StopToolUse, false},
		{"stop_sequence", contracts.StopSequence, false},
		{"refusal", contracts.StopUnknown, true},
		{"pause_turn", contracts.StopUnknown, true},
		{"model_context_window_exceeded", contracts.StopMaxTokens, true},
	}
	for _, tc := range cases {
		response, err := codec.ParseResponse([]byte(`{"id":"msg_1","type":"message","stop_reason":"` + tc.wire + `"}`))
		if err != nil {
			t.Fatalf("ParseResponse(%s): %v", tc.wire, err)
		}
		if response.Stop != tc.want {
			t.Fatalf("stop_reason %q 应映射为 %q，得到 %q", tc.wire, tc.want, response.Stop)
		}
		if tc.note && !hasNote(response.Lossy, "stop_reason", "mapped") {
			t.Fatalf("stop_reason %q 应记 note：%+v", tc.wire, response.Lossy)
		}
	}
}

func TestAnthropicRenderDropsOpenAIOnlyFields(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{})
	logprobs := true
	topLogprobs := 3
	presence := 0.1
	frequency := 0.2
	seed := int64(7)
	request := &contracts.Request{
		Model: "claude",
		Sampling: contracts.Sampling{
			Logprobs:         &logprobs,
			TopLogprobs:      &topLogprobs,
			PresencePenalty:  &presence,
			FrequencyPenalty: &frequency,
			Seed:             &seed,
		},
		ResponseFormat: &contracts.ResponseFormat{Type: "json_object"},
		Extras:         map[string]json.RawMessage{"parallel_tool_calls": json.RawMessage("false")},
	}
	if _, err := codec.RenderRequest(request); err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	for _, field := range []string{"logprobs", "top_logprobs", "presence_penalty", "frequency_penalty", "seed", "response_format", "extras.parallel_tool_calls"} {
		if !hasNote(request.Lossy, field, "dropped") {
			t.Fatalf("字段 %s 应记 dropped note：%+v", field, request.Lossy)
		}
	}
}

func TestAnthropicParseAndRenderResponse(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{})
	body := `{"id":"msg_1","type":"message","role":"assistant","model":"claude-3","content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"toolu_9","name":"f","input":{"x":1}}],"stop_reason":"tool_use","usage":{"input_tokens":3,"output_tokens":2,"cache_read_input_tokens":5}}`
	response, err := codec.ParseResponse([]byte(body))
	if err != nil {
		t.Fatalf("ParseResponse: %v", err)
	}
	if response.ID != "msg_1" || response.Stop != contracts.StopToolUse {
		t.Fatalf("响应头不对：%+v", response)
	}
	if response.Usage.InputTokens != 3 || response.Usage.OutputTokens != 2 || response.Usage.CacheReadInputTokens != 5 {
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
	var wire struct {
		Type       string `json:"type"`
		Role       string `json:"role"`
		StopReason string `json:"stop_reason"`
	}
	if err := json.Unmarshal(rendered, &wire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if wire.Type != "message" || wire.Role != "assistant" || wire.StopReason != "tool_use" {
		t.Fatalf("Anthropic 响应形状不对：%+v", wire)
	}
}

func TestAnthropicThinkingSignatureDroppedToChat(t *testing.T) {
	chat := NewChatCodec()
	response := &contracts.Response{
		ID:    "x",
		Model: "m",
		Parts: []contracts.Part{
			{Kind: contracts.KindThinking, Text: "reason", Signature: "sig"},
			{Kind: contracts.KindThinking, Redacted: true, Text: "opaque"},
			{Kind: contracts.KindText, Text: "answer"},
		},
	}
	if _, err := chat.RenderResponse(response); err != nil {
		t.Fatalf("RenderResponse: %v", err)
	}
	if !hasNote(response.Lossy, "thinking.signature", "dropped") {
		t.Fatalf("thinking.signature 应记 dropped note：%+v", response.Lossy)
	}
	if !hasNote(response.Lossy, "redacted_thinking", "dropped") {
		t.Fatalf("redacted_thinking 应记 dropped note：%+v", response.Lossy)
	}
}

func TestAnthropicCacheControlDroppedToChat(t *testing.T) {
	chat := NewChatCodec()
	request := &contracts.Request{
		Model: "m",
		Messages: []contracts.Message{{Role: contracts.RoleUser, Parts: []contracts.Part{{
			Kind: contracts.KindText, Text: "hi",
			Raw: json.RawMessage(`{"cache_control":{"type":"ephemeral"}}`),
		}}}},
	}
	if _, err := chat.RenderRequest(request); err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	if !hasNote(request.Lossy, "cache_control", "dropped") {
		t.Fatalf("cache_control 应记 dropped note：%+v", request.Lossy)
	}
}

func TestAnthropicExtrasCaptured(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{})
	request, err := codec.ParseRequest([]byte(`{"model":"m","service_tier":"auto","messages":[]}`))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	if _, ok := request.Extras["service_tier"]; !ok {
		t.Fatalf("未建模字段应进 Extras：%+v", request.Extras)
	}
}

func TestAnthropicParseRequestRejectsNonJSON(t *testing.T) {
	if _, err := NewAnthropicCodec(AnthropicConfig{}).ParseRequest([]byte("not json")); err == nil {
		t.Fatal("非 JSON 必须报错")
	}
}

// ---------------------------------------------------------------------------
// 流式
// ---------------------------------------------------------------------------

func TestAnthropicStreamDecodeFromTestdataSplit(t *testing.T) {
	payload, err := os.ReadFile("testdata/anthropic_stream.sse")
	if err != nil {
		t.Fatalf("读 testdata: %v", err)
	}
	codec := NewAnthropicCodec(AnthropicConfig{})
	decoder := codec.NewStreamDecoder()

	var events []contracts.Event
	emit := func(event contracts.Event) { events = append(events, event) }

	// 每次只喂 5 个字节，强制把 event:/data: 行切成半截。
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

	if len(events) == 0 || events[0].Kind != contracts.EventMessageStart || events[0].ID != "msg_1" {
		t.Fatalf("首个事件应是 message_start：%+v", events)
	}
	var text strings.Builder
	var args strings.Builder
	var toolName string
	var sawPing, sawStop, sawDelta bool
	var stop contracts.StopReason
	for _, event := range events {
		switch event.Kind {
		case contracts.EventPing:
			sawPing = true
		case contracts.EventBlockStart:
			if event.Part != nil && event.Part.Kind == contracts.KindToolUse {
				toolName = event.Part.ToolName
			}
		case contracts.EventBlockDelta:
			switch event.DeltaKind {
			case contracts.DeltaText:
				text.WriteString(event.Text)
			case contracts.DeltaToolInputJSON:
				args.WriteString(event.Text)
			}
		case contracts.EventMessageDelta:
			stop = event.Stop
			sawDelta = true
			if event.Usage == nil || event.Usage.OutputTokens != 15 {
				t.Fatalf("message_delta 用量不对：%+v", event.Usage)
			}
		case contracts.EventMessageStop:
			sawStop = true
		}
	}
	if !sawPing || !sawDelta || !sawStop {
		t.Fatalf("事件序列不完整：%+v", events)
	}
	if text.String() != "Hello" {
		t.Fatalf("文本增量拼接不对：%q", text.String())
	}
	if toolName != "get_weather" || args.String() != `{"city":"SF"}` {
		t.Fatalf("工具增量不对：name=%q args=%q", toolName, args.String())
	}
	if stop != contracts.StopToolUse {
		t.Fatalf("停止原因不对：%q", stop)
	}
}

func TestAnthropicStreamEncodeFramesAndOrder(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{})
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
	write(contracts.Event{Kind: contracts.EventMessageStart, ID: "msg_1", Model: "claude"})
	write(contracts.Event{Kind: contracts.EventBlockStart, Index: 0, Part: &contracts.Part{Kind: contracts.KindText}})
	write(contracts.Event{Kind: contracts.EventBlockDelta, Index: 0, DeltaKind: contracts.DeltaText, Text: "hi"})
	write(contracts.Event{Kind: contracts.EventBlockStop, Index: 0})
	write(contracts.Event{Kind: contracts.EventMessageDelta, Stop: contracts.StopEndTurn})
	write(contracts.Event{Kind: contracts.EventMessageStop})

	payload := out.String()
	wantOrder := []string{"message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"}
	got := frameEventNames(payload)
	if strings.Join(got, ",") != strings.Join(wantOrder, ",") {
		t.Fatalf("帧顺序不对：\n得到 %v\n期望 %v", got, wantOrder)
	}
	if !strings.Contains(payload, `"text_delta"`) || !strings.Contains(payload, `"end_turn"`) {
		t.Fatalf("帧内容不对：%s", payload)
	}
}

func TestAnthropicStreamEncoderToolBlock(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{})
	encoder := codec.NewStreamEncoder()
	var out strings.Builder
	emit := func(events ...contracts.Event) {
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
	emit(contracts.Event{Kind: contracts.EventMessageStart, ID: "m", Model: "c"})
	emit(contracts.Event{Kind: contracts.EventBlockStart, Index: 0, Part: &contracts.Part{Kind: contracts.KindToolUse, ToolCallID: "call_1", ToolName: "f"}})
	emit(contracts.Event{Kind: contracts.EventBlockDelta, Index: 0, DeltaKind: contracts.DeltaToolInputJSON, Text: `{"x":`})
	emit(contracts.Event{Kind: contracts.EventBlockDelta, Index: 0, DeltaKind: contracts.DeltaToolInputJSON, Text: `1}`})
	emit(contracts.Event{Kind: contracts.EventBlockStop, Index: 0})
	emit(contracts.Event{Kind: contracts.EventMessageStop})
	payload := out.String()
	if !strings.Contains(payload, `"type":"tool_use"`) || !strings.Contains(payload, `"partial_json"`) {
		t.Fatalf("tool_use 帧不对：%s", payload)
	}
	if !strings.Contains(payload, "event: message_stop") {
		t.Fatalf("缺少 message_stop：%s", payload)
	}
}

func TestAnthropicStreamEncodeErrorAndFlush(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{})

	// 错误帧走 event: error。
	encoder := codec.NewStreamEncoder()
	frames, err := encoder.EncodeError(contracts.StreamError{Type: "overloaded_error", Message: "Overloaded"})
	if err != nil || len(frames) != 1 {
		t.Fatalf("EncodeError: %v %d", err, len(frames))
	}
	if !strings.Contains(string(frames[0]), "event: error") || !strings.Contains(string(frames[0]), "overloaded_error") {
		t.Fatalf("错误帧不对：%s", frames[0])
	}
	// 出错后流已结束：Flush 不应再补 message_stop。
	if after, _ := encoder.Flush(); len(after) != 0 {
		t.Fatalf("错误后 Flush 不应再输出：%s", joinFrames(after))
	}

	// 正常的 Flush 在没有 message_stop 时补一个，且只补一次。
	clean := codec.NewStreamEncoder()
	flushed, err := clean.Flush()
	if err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if !strings.Contains(string(joinFrames(flushed)), "message_stop") {
		t.Fatalf("Flush 应补 message_stop：%s", joinFrames(flushed))
	}
	if again, _ := clean.Flush(); len(again) != 0 {
		t.Fatalf("重复 Flush 不应再输出：%s", joinFrames(again))
	}
}

func TestAnthropicStreamEncoderClosesOpenBlockOnFlush(t *testing.T) {
	codec := NewAnthropicCodec(AnthropicConfig{})
	encoder := codec.NewStreamEncoder()
	if _, err := encoder.Encode(contracts.Event{Kind: contracts.EventMessageStart, ID: "m"}); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if _, err := encoder.Encode(contracts.Event{Kind: contracts.EventBlockStart, Index: 0, Part: &contracts.Part{Kind: contracts.KindText}}); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	frames, err := encoder.Flush()
	if err != nil {
		t.Fatalf("Flush: %v", err)
	}
	names := frameEventNames(string(joinFrames(frames)))
	want := []string{"content_block_stop", "message_stop"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("Flush 顺序不对：%v", names)
	}
}

// ---------------------------------------------------------------------------
// 测试小工具
// ---------------------------------------------------------------------------

// frameEventNames 从 SSE 载荷里按出现顺序提取 event: 名字。
func frameEventNames(payload string) []string {
	var names []string
	for _, block := range strings.Split(payload, "\n\n") {
		for _, line := range strings.Split(block, "\n") {
			if strings.HasPrefix(line, "event: ") {
				names = append(names, strings.TrimPrefix(line, "event: "))
			}
		}
	}
	return names
}

func joinFrames(frames [][]byte) []byte {
	var out []byte
	for _, frame := range frames {
		out = append(out, frame...)
	}
	return out
}
