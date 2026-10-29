package protoconv

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Gemini 请求 → IR 的映射。
const geminiRequestJSON = `{
  "systemInstruction": {"parts": [{"text": "be nice"}]},
  "contents": [
    {"role": "user", "parts": [{"text": "hi"}]},
    {"role": "model", "parts": [
      {"text": "sure"},
      {"functionCall": {"name": "f", "args": {"x": 1}}}
    ]},
    {"role": "user", "parts": [
      {"functionResponse": {"name": "f", "response": {"result": "42"}}}
    ]}
  ],
  "tools": [{"functionDeclarations": [{"name": "f", "description": "d", "parameters": {"type": "object"}}]}],
  "toolConfig": {"functionCallingConfig": {"mode": "ANY"}},
  "generationConfig": {"temperature": 0.5, "topP": 0.9, "topK": 5, "maxOutputTokens": 100, "stopSequences": ["END"]}
}`

func TestGeminiParseRequest(t *testing.T) {
	codec := NewGeminiCodec()
	request, err := codec.ParseRequest([]byte(geminiRequestJSON))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	if len(request.System) != 1 || request.System[0].Text != "be nice" {
		t.Fatalf("systemInstruction 不对：%+v", request.System)
	}
	if len(request.Messages) != 3 {
		t.Fatalf("消息数不对：%d", len(request.Messages))
	}
	if request.Messages[0].Role != contracts.RoleUser || request.Messages[0].Parts[0].Text != "hi" {
		t.Fatalf("第一条消息不对：%+v", request.Messages[0])
	}
	if request.Messages[1].Role != contracts.RoleAssistant {
		t.Fatalf("model 回合应映射为 assistant：%+v", request.Messages[1])
	}
	// functionCall → tool_use。
	toolUse := request.Messages[1].Parts[1]
	if toolUse.Kind != contracts.KindToolUse || toolUse.ToolName != "f" {
		t.Fatalf("functionCall 不对：%+v", toolUse)
	}
	if string(toolUse.ToolInput) != `{"x": 1}` {
		t.Fatalf("functionCall.args 不对：%s", toolUse.ToolInput)
	}
	// functionResponse → tool_result。
	toolResult := request.Messages[2].Parts[0]
	if toolResult.Kind != contracts.KindToolResult {
		t.Fatalf("functionResponse 不对：%+v", toolResult)
	}
	if !strings.Contains(toolResult.Text, "42") {
		t.Fatalf("functionResponse 文本不对：%q", toolResult.Text)
	}
	// 工具声明。
	if len(request.Tools) != 1 || request.Tools[0].Name != "f" {
		t.Fatalf("工具声明不对：%+v", request.Tools)
	}
	if string(request.Tools[0].InputSchema) != `{"type": "object"}` {
		t.Fatalf("工具 schema 不对：%s", request.Tools[0].InputSchema)
	}
	// toolConfig.mode=ANY → required。
	if request.ToolChoice == nil || request.ToolChoice.Mode != contracts.ToolChoiceRequired {
		t.Fatalf("toolChoice 不对：%+v", request.ToolChoice)
	}
	// generationConfig → 采样参数。
	if request.Sampling.Temperature == nil || *request.Sampling.Temperature != 0.5 {
		t.Fatalf("temperature 不对：%+v", request.Sampling.Temperature)
	}
	if request.Sampling.TopK == nil || *request.Sampling.TopK != 5 {
		t.Fatalf("topK 不对：%+v", request.Sampling.TopK)
	}
	if request.MaxTokens == nil || *request.MaxTokens != 100 {
		t.Fatalf("maxOutputTokens 不对：%+v", request.MaxTokens)
	}
	if len(request.Sampling.Stop) != 1 || request.Sampling.Stop[0] != "END" {
		t.Fatalf("stopSequences 不对：%+v", request.Sampling.Stop)
	}
}

func TestGeminiParseRequestRejectsBadJSON(t *testing.T) {
	codec := NewGeminiCodec()
	if _, err := codec.ParseRequest([]byte(`{not json`)); err == nil {
		t.Fatal("坏 JSON 必须报错")
	}
	if _, err := codec.ParseRequest([]byte(`[]`)); err == nil {
		t.Fatal("非对象请求体必须报错")
	}
}

func TestGeminiRenderRequest(t *testing.T) {
	codec := NewGeminiCodec()
	request := &contracts.Request{
		System: []contracts.Part{{Kind: contracts.KindText, Text: "be nice"}},
		Messages: []contracts.Message{
			{Role: contracts.RoleUser, Parts: []contracts.Part{{Kind: contracts.KindText, Text: "hi"}}},
			{Role: contracts.RoleAssistant, Parts: []contracts.Part{
				{Kind: contracts.KindToolUse, ToolName: "f", ToolCallID: "gemini_call_f", ToolInput: json.RawMessage(`{"x":1}`)},
			}},
			{Role: contracts.RoleTool, Parts: []contracts.Part{
				{Kind: contracts.KindToolResult, ToolResultFor: "gemini_call_f", Text: "42"},
			}},
		},
		Tools:      []contracts.Tool{{Name: "f", Description: "d", InputSchema: json.RawMessage(`{"type":"object"}`)}},
		ToolChoice: &contracts.ToolChoice{Mode: contracts.ToolChoiceRequired},
		MaxTokens:  intPtr(64),
	}
	body, err := codec.RenderRequest(request)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	var wire struct {
		SystemInstruction struct {
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"systemInstruction"`
		Contents []struct {
			Role  string `json:"role"`
			Parts []struct {
				Text         string `json:"text"`
				FunctionCall *struct {
					Name string          `json:"name"`
					Args json.RawMessage `json:"args"`
				} `json:"functionCall"`
				FunctionResponse *struct {
					Name     string          `json:"name"`
					Response json.RawMessage `json:"response"`
				} `json:"functionResponse"`
			} `json:"parts"`
		} `json:"contents"`
		Tools []struct {
			FunctionDeclarations []struct {
				Name       string          `json:"name"`
				Parameters json.RawMessage `json:"parameters"`
			} `json:"functionDeclarations"`
		} `json:"tools"`
		ToolConfig struct {
			FunctionCallingConfig struct {
				Mode string `json:"mode"`
			} `json:"functionCallingConfig"`
		} `json:"toolConfig"`
		GenerationConfig struct {
			MaxOutputTokens int      `json:"maxOutputTokens"`
			Temperature     *float64 `json:"temperature"`
		} `json:"generationConfig"`
	}
	if err := json.Unmarshal(body, &wire); err != nil {
		t.Fatalf("渲染结果不是合法 JSON：%v（%s）", err, body)
	}
	if len(wire.SystemInstruction.Parts) != 1 || wire.SystemInstruction.Parts[0].Text != "be nice" {
		t.Fatalf("systemInstruction 渲染不对：%s", body)
	}
	if len(wire.Contents) != 3 {
		t.Fatalf("contents 数不对：%d（%s）", len(wire.Contents), body)
	}
	if wire.Contents[0].Role != "user" || wire.Contents[0].Parts[0].Text != "hi" {
		t.Fatalf("user 回合渲染不对：%s", body)
	}
	if wire.Contents[1].Role != "model" {
		t.Fatalf("assistant 回合应渲染成 model：%s", body)
	}
	call := wire.Contents[1].Parts[0].FunctionCall
	if call == nil || call.Name != "f" || string(call.Args) != `{"x":1}` {
		t.Fatalf("functionCall 渲染不对：%s", body)
	}
	// 工具结果渲染成 user 回合里的 functionResponse。
	response := wire.Contents[2].Parts[0].FunctionResponse
	if response == nil || response.Name != "f" {
		t.Fatalf("functionResponse 渲染不对：%s", body)
	}
	if len(wire.Tools) != 1 || wire.Tools[0].FunctionDeclarations[0].Name != "f" {
		t.Fatalf("tools 渲染不对：%s", body)
	}
	if wire.ToolConfig.FunctionCallingConfig.Mode != "ANY" {
		t.Fatalf("toolConfig 渲染不对：%s", body)
	}
	if wire.GenerationConfig.MaxOutputTokens != 64 {
		t.Fatalf("maxOutputTokens 渲染不对：%s", body)
	}
}

func TestGeminiRenderRequestRecordsLossy(t *testing.T) {
	codec := NewGeminiCodec()
	request := &contracts.Request{
		Messages: []contracts.Message{
			{Role: contracts.RoleUser, Parts: []contracts.Part{{Kind: contracts.KindText, Text: "hi"}}},
		},
		Sampling: contracts.Sampling{
			PresencePenalty:  floatPtr(0.5),
			FrequencyPenalty: floatPtr(0.2),
		},
		ResponseFormat: &contracts.ResponseFormat{Type: "json_object"},
	}
	body, err := codec.RenderRequest(request)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	if len(body) == 0 {
		t.Fatal("渲染结果不能为空")
	}
	// presence_penalty / frequency_penalty / response_format 是 OpenAI 专有，
	// Gemini 无法表达 → 必须记 dropped。
	for _, field := range []string{"presence_penalty", "frequency_penalty", "response_format"} {
		if !hasNote(request.Lossy, field, "dropped") {
			t.Fatalf("字段 %s 必须记一条 dropped 的有损映射：%+v", field, request.Lossy)
		}
	}
	// seed 是 Gemini **支持**的（generationConfig.seed）：不许记有损，必须落进 body。
	if hasNote(request.Lossy, "seed", "dropped") {
		t.Fatalf("seed 是 Gemini 支持的字段，不该记有损：%+v", request.Lossy)
	}
}

func TestGeminiRenderRequestDropsThinkingAndNonInlineImage(t *testing.T) {
	codec := NewGeminiCodec()
	request := &contracts.Request{
		Messages: []contracts.Message{
			{Role: contracts.RoleUser, Parts: []contracts.Part{
				{Kind: contracts.KindThinking, Text: "thought", Signature: "sig"},
				{Kind: contracts.KindImage, ImageURL: "https://example.com/x.png"},
			}},
		},
	}
	if _, err := codec.RenderRequest(request); err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	if !hasNote(request.Lossy, "thinking.signature", "dropped") {
		t.Fatalf("thinking 必须记有损映射：%+v", request.Lossy)
	}
	if !hasNote(request.Lossy, "image", "dropped") {
		t.Fatalf("非 inlineData 图片必须记有损映射：%+v", request.Lossy)
	}
}

// Gemini 响应 → IR。
func TestGeminiParseResponse(t *testing.T) {
	codec := NewGeminiCodec()
	body := []byte(`{
      "responseId": "resp-1",
      "modelVersion": "gemini-2.0-flash",
      "candidates": [{"content": {"role": "model", "parts": [{"text": "hello"}]}, "finishReason": "STOP", "index": 0}],
      "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20, "cachedContentTokenCount": 30, "thoughtsTokenCount": 5, "totalTokenCount": 120}
    }`)
	response, err := codec.ParseResponse(body)
	if err != nil {
		t.Fatalf("ParseResponse: %v", err)
	}
	if response.ID != "resp-1" || response.Model != "gemini-2.0-flash" {
		t.Fatalf("id/model 不对：%+v", response)
	}
	if len(response.Parts) != 1 || response.Parts[0].Text != "hello" {
		t.Fatalf("parts 不对：%+v", response.Parts)
	}
	if response.Stop != contracts.StopEndTurn {
		t.Fatalf("finishReason=STOP 应映射为 end_turn：%s", response.Stop)
	}
	// usage 归一化：promptTokenCount 含缓存命中，input 保持原值由 probe 归一化。
	if response.Usage.InputTokens != 100 {
		t.Fatalf("input 应为 100：%d", response.Usage.InputTokens)
	}
	if response.Usage.CacheReadInputTokens != 30 {
		t.Fatalf("cacheRead 应为 30：%d", response.Usage.CacheReadInputTokens)
	}
	if response.Usage.OutputTokens != 20 {
		t.Fatalf("output 应为 20：%d", response.Usage.OutputTokens)
	}
	if response.Usage.ReasoningTokens != 5 {
		t.Fatalf("reasoning 应为 5：%d", response.Usage.ReasoningTokens)
	}
	if response.Usage.CacheCreationInputTokens != 0 {
		t.Fatalf("Gemini 没有写缓存，cacheCreation 应为 0：%d", response.Usage.CacheCreationInputTokens)
	}
}

// Gemini 响应 → Gemini 形状。
func TestGeminiRenderResponse(t *testing.T) {
	codec := NewGeminiCodec()
	response := &contracts.Response{
		ID:    "resp-1",
		Model: "gemini-2.0-flash",
		Parts: []contracts.Part{
			{Kind: contracts.KindText, Text: "hello"},
			{Kind: contracts.KindToolUse, ToolName: "f", ToolInput: json.RawMessage(`{"x":1}`)},
		},
		Stop: contracts.StopMaxTokens,
		Usage: contracts.Usage{
			InputTokens: 70, OutputTokens: 20, CacheReadInputTokens: 30, ReasoningTokens: 5,
		},
	}
	body, err := codec.RenderResponse(response)
	if err != nil {
		t.Fatalf("RenderResponse: %v", err)
	}
	var wire struct {
		ResponseID   string `json:"responseId"`
		ModelVersion string `json:"modelVersion"`
		Candidates   []struct {
			Content struct {
				Role  string `json:"role"`
				Parts []struct {
					Text         string `json:"text"`
					FunctionCall *struct {
						Name string          `json:"name"`
						Args json.RawMessage `json:"args"`
					} `json:"functionCall"`
				} `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
		UsageMetadata struct {
			PromptTokenCount        int `json:"promptTokenCount"`
			CandidatesTokenCount    int `json:"candidatesTokenCount"`
			CachedContentTokenCount int `json:"cachedContentTokenCount"`
			ThoughtsTokenCount      int `json:"thoughtsTokenCount"`
			TotalTokenCount         int `json:"totalTokenCount"`
		} `json:"usageMetadata"`
	}
	if err := json.Unmarshal(body, &wire); err != nil {
		t.Fatalf("渲染结果不是合法 JSON：%v（%s）", err, body)
	}
	if wire.ResponseID != "resp-1" || wire.ModelVersion != "gemini-2.0-flash" {
		t.Fatalf("id/model 渲染不对：%s", body)
	}
	if len(wire.Candidates) != 1 || wire.Candidates[0].Content.Role != "model" {
		t.Fatalf("candidate 渲染不对：%s", body)
	}
	if wire.Candidates[0].FinishReason != "MAX_TOKENS" {
		t.Fatalf("finishReason 渲染不对：%s", body)
	}
	call := wire.Candidates[0].Content.Parts[1].FunctionCall
	if call == nil || call.Name != "f" || string(call.Args) != `{"x":1}` {
		t.Fatalf("functionCall 渲染不对：%s", body)
	}
	// usage 原样带过（减法由 usageprobe.Normalize 按上游协议做）。
	if wire.UsageMetadata.PromptTokenCount != 70 || wire.UsageMetadata.CachedContentTokenCount != 30 {
		t.Fatalf("usageMetadata 渲染不对：%s", body)
	}
	if wire.UsageMetadata.TotalTokenCount != 90 {
		t.Fatalf("totalTokenCount 应为 input+output：%s", body)
	}
}

// 跨协议：Gemini 客户端 → OpenAI 上游（请求与响应双向）。
func TestGeminiClientToOpenAIUpstream(t *testing.T) {
	gemini := NewGeminiCodec()
	chat := NewChatCodec()

	request, err := gemini.ParseRequest([]byte(geminiRequestJSON))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	rendered, err := chat.RenderRequest(request)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	var wire struct {
		Messages []struct {
			Role    string `json:"role"`
			Content any    `json:"content"`
		} `json:"messages"`
		Tools []struct {
			Type     string `json:"type"`
			Function struct {
				Name string `json:"name"`
			} `json:"function"`
		} `json:"tools"`
		MaxTokens int `json:"max_tokens"`
	}
	if err := json.Unmarshal(rendered, &wire); err != nil {
		t.Fatalf("OpenAI 请求不是合法 JSON：%v（%s）", err, rendered)
	}
	// systemInstruction → system 消息。
	if wire.Messages[0].Role != "system" {
		t.Fatalf("system 应映射成 system 消息：%s", rendered)
	}
	// model 回合 → assistant。
	roles := map[string]int{}
	for _, message := range wire.Messages {
		roles[message.Role]++
	}
	if roles["assistant"] != 1 {
		t.Fatalf("model 回合应映射成 assistant：%s", rendered)
	}
	if len(wire.Tools) != 1 || wire.Tools[0].Type != "function" {
		t.Fatalf("工具声明渲染不对：%s", rendered)
	}
	if wire.MaxTokens != 100 {
		t.Fatalf("max_tokens 不对：%s", rendered)
	}

	// 响应方向：OpenAI 响应 → Gemini 形状。
	openaiResponse := []byte(`{"id":"c1","model":"gpt-4o","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}`)
	parsed, err := chat.ParseResponse(openaiResponse)
	if err != nil {
		t.Fatalf("ParseResponse: %v", err)
	}
	geminiBody, err := gemini.RenderResponse(parsed)
	if err != nil {
		t.Fatalf("RenderResponse: %v", err)
	}
	if !strings.Contains(string(geminiBody), `"text":"hi"`) {
		t.Fatalf("Gemini 响应形状不对：%s", geminiBody)
	}
	if !strings.Contains(string(geminiBody), `"finishReason":"STOP"`) {
		t.Fatalf("finishReason 不对：%s", geminiBody)
	}
	if !strings.Contains(string(geminiBody), `"candidatesTokenCount":5`) {
		t.Fatalf("usage 渲染不对：%s", geminiBody)
	}
}

// 跨协议：Gemini 客户端 → Anthropic 上游。
func TestGeminiClientToAnthropicUpstream(t *testing.T) {
	gemini := NewGeminiCodec()
	anthropic := NewAnthropicCodec(AnthropicConfig{})

	request, err := gemini.ParseRequest([]byte(geminiRequestJSON))
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	rendered, err := anthropic.RenderRequest(request)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	var wire struct {
		System    any `json:"system"`
		MaxTokens int `json:"max_tokens"`
		Messages  []struct {
			Role string `json:"role"`
		} `json:"messages"`
		Tools []struct {
			Name        string          `json:"name"`
			InputSchema json.RawMessage `json:"input_schema"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(rendered, &wire); err != nil {
		t.Fatalf("Anthropic 请求不是合法 JSON：%v（%s）", err, rendered)
	}
	if wire.MaxTokens != 100 {
		t.Fatalf("max_tokens 不对：%s", rendered)
	}
	if len(wire.Tools) != 1 || wire.Tools[0].Name != "f" {
		t.Fatalf("工具声明不对：%s", rendered)
	}
	foundAssistant := false
	for _, message := range wire.Messages {
		if message.Role == "assistant" {
			foundAssistant = true
		}
	}
	if !foundAssistant {
		t.Fatalf("model 回合应映射成 assistant：%s", rendered)
	}

	// 响应方向：Anthropic 响应 → Gemini 形状。
	anthropicResponse := []byte(`{"id":"a1","type":"message","role":"assistant","model":"claude","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":12,"output_tokens":7}}`)
	parsed, err := anthropic.ParseResponse(anthropicResponse)
	if err != nil {
		t.Fatalf("ParseResponse: %v", err)
	}
	geminiBody, err := gemini.RenderResponse(parsed)
	if err != nil {
		t.Fatalf("RenderResponse: %v", err)
	}
	if !strings.Contains(string(geminiBody), `"text":"hi"`) {
		t.Fatalf("Gemini 响应形状不对：%s", geminiBody)
	}
	if !strings.Contains(string(geminiBody), `"candidatesTokenCount":7`) {
		t.Fatalf("usage 渲染不对：%s", geminiBody)
	}
}

// 同协议直通：请求体必须逐字节不变。
func TestGeminiSameProtocolPassthroughIsByteExact(t *testing.T) {
	body := []byte(`{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"temperature":0.3}}`)
	// 同协议走快路径：protoconv 阶段根本不会调用 codec。
	// 这里验证的是 codec 自己：解析再渲染的语义正确（真正的直通在 stage 层）。
	codec := NewGeminiCodec()
	request, err := codec.ParseRequest(body)
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	if request.Sampling.Temperature == nil || *request.Sampling.Temperature != 0.3 {
		t.Fatalf("temperature 不对：%+v", request.Sampling.Temperature)
	}
	// 渲染回 Gemini 时不得凭空多出 model 字段（Gemini 的 body 里没有它）。
	rendered, err := codec.RenderRequest(request)
	if err != nil {
		t.Fatalf("RenderRequest: %v", err)
	}
	if strings.Contains(string(rendered), `"model"`) {
		t.Fatalf("Gemini 请求体不许含 model 字段：%s", rendered)
	}
}

func TestGeminiRejectsMultipleCandidates(t *testing.T) {
	codec := NewGeminiCodec()
	request := &contracts.Request{
		Messages: []contracts.Message{{Role: contracts.RoleUser, Parts: []contracts.Part{{Kind: contracts.KindText, Text: "hi"}}}},
		Sampling: contracts.Sampling{N: intPtr(2)},
	}
	if _, err := codec.RenderRequest(request); err == nil {
		t.Fatal("candidateCount>1 必须明确失败")
	}
}

func TestGeminiFinishReasonMapping(t *testing.T) {
	cases := map[string]contracts.StopReason{
		"STOP":       contracts.StopEndTurn,
		"MAX_TOKENS": contracts.StopMaxTokens,
		"SAFETY":     contracts.StopContentFilter,
		"":           contracts.StopUnknown,
	}
	for reason, want := range cases {
		if got := geminiFinishToStop(reason, nil); got != want {
			t.Fatalf("finishReason %q 应映射为 %s，得到 %s", reason, want, got)
		}
	}
	if got := irStopToGeminiFinish(contracts.StopMaxTokens); got != "MAX_TOKENS" {
		t.Fatalf("反向映射不对：%s", got)
	}
	if got := irStopToGeminiFinish(contracts.StopEndTurn); got != "STOP" {
		t.Fatalf("反向映射不对：%s", got)
	}
}

func intPtr(value int) *int           { return &value }
func floatPtr(value float64) *float64 { return &value }
func int64Ptr(value int64) *int64     { return &value }
