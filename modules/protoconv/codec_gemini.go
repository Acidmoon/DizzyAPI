package protoconv

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// geminiCodec 是 Google Gemini（generateContent）协议的完整 codec。
//
// 线上格式依据 Gemini 官方文档核实（2026-10 复核）：
//   - 请求 POST /v1beta/models/{model}:generateContent：
//     body 必填 contents；systemInstruction 是 {parts:[{text}]}；
//     contents[] 是 {role:"user"|"model", parts:[{text} | {functionCall} | {functionResponse} |
//     {inlineData:{mimeType,data}}]}；tools[] 是 {functionDeclarations:[{name,description,parameters}]}；
//     toolConfig 是 {functionCallingConfig:{mode:"AUTO"|"ANY"|"NONE", allowedFunctionNames:[...]}}；
//     generationConfig 是 {temperature,topP,topK,maxOutputTokens,stopSequences,candidateCount,
//     responseMimeType,responseSchema,thinkingConfig}。
//     **模型名在 URL 路径里，不在 body 里**（见 httpapi 的 Gemini 入口）。
//   - 响应 {candidates:[{content:{parts:[...],role}, finishReason, index, safetyRatings}],
//     usageMetadata:{promptTokenCount, candidatesTokenCount, cachedContentTokenCount,
//     thoughtsTokenCount, totalTokenCount}, modelVersion, responseId}。
//   - 流式 POST /v1beta/models/{model}:streamGenerateContent?alt=sse：
//     每帧是一个完整 GenerateContentResponse（不是事件名 + 增量）。
//
// 与其它协议的关键差异（决定了本 codec 的映射方式）：
//   - 角色只有 user / model：assistant 对应 model，tool 结果用 functionResponse 表达；
//   - 工具调用是 functionCall（名字 + args 对象），没有独立的 tool_call_id；
//   - 图片是 inlineData（base64 + mimeType），不支持 URL 引用；
//   - **usage 口径**：promptTokenCount 含缓存命中，candidatesTokenCount 是输出，
//     thoughtsTokenCount 是思考 token（是输出的子集）。
type geminiCodec struct{}

// NewGeminiCodec 返回 Gemini generateContent codec。
func NewGeminiCodec() contracts.Codec { return geminiCodec{} }

func (geminiCodec) Protocol() contracts.Protocol { return contracts.ProtocolGemini }

// geminiKnownKeys 是 IR 已建模的顶层请求字段；其余进 Request.Extras。
var geminiKnownKeys = map[string]struct{}{
	"contents": {}, "systemInstruction": {}, "system_instruction": {}, "tools": {},
	"toolConfig": {}, "tool_config": {}, "generationConfig": {}, "generation_config": {},
	"safetySettings": {}, "safety_settings": {}, "cachedContent": {}, "cached_content": {},
}

// ---------------------------------------------------------------------------
// 请求：线格式
// ---------------------------------------------------------------------------

type geminiWireRequest struct {
	Contents          []geminiWireContent `json:"contents"`
	SystemInstruction json.RawMessage     `json:"systemInstruction,omitempty"`
	Tools             []geminiWireTool    `json:"tools,omitempty"`
	ToolConfig        json.RawMessage     `json:"toolConfig,omitempty"`
	GenerationConfig  json.RawMessage     `json:"generationConfig,omitempty"`
}

type geminiWireContent struct {
	Role  string           `json:"role,omitempty"`
	Parts []geminiWirePart `json:"parts"`
}

type geminiWirePart struct {
	Text             string                      `json:"text,omitempty"`
	InlineData       *geminiWireInlineData       `json:"inlineData,omitempty"`
	FunctionCall     *geminiWireFunctionCall     `json:"functionCall,omitempty"`
	FunctionResponse *geminiWireFunctionResponse `json:"functionResponse,omitempty"`
	Thought          bool                        `json:"thought,omitempty"`
	ThoughtSignature string                      `json:"thoughtSignature,omitempty"`
}

type geminiWireInlineData struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

type geminiWireFunctionCall struct {
	Name string          `json:"name"`
	Args json.RawMessage `json:"args,omitempty"`
}

type geminiWireFunctionResponse struct {
	Name     string          `json:"name"`
	Response json.RawMessage `json:"response,omitempty"`
}

type geminiWireTool struct {
	FunctionDeclarations []geminiWireFunctionDeclaration `json:"functionDeclarations,omitempty"`
}

type geminiWireFunctionDeclaration struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

// geminiWireGenerationConfig 是 generationConfig 里 IR 关心的字段。
type geminiWireGenerationConfig struct {
	Temperature     *float64 `json:"temperature,omitempty"`
	TopP            *float64 `json:"topP,omitempty"`
	TopK            *int     `json:"topK,omitempty"`
	MaxOutputTokens *int     `json:"maxOutputTokens,omitempty"`
	StopSequences   []string `json:"stopSequences,omitempty"`
	CandidateCount  *int     `json:"candidateCount,omitempty"`
	Seed            *int64   `json:"seed,omitempty"`
}

// geminiWireToolConfig 是 toolConfig 的形状。
type geminiWireToolConfig struct {
	FunctionCallingConfig struct {
		Mode                 string   `json:"mode,omitempty"`
		AllowedFunctionNames []string `json:"allowedFunctionNames,omitempty"`
	} `json:"functionCallingConfig"`
}

// ---------------------------------------------------------------------------
// 请求：解析
// ---------------------------------------------------------------------------

// ParseRequest 把 Gemini generateContent 请求体解析成 IR。
func (geminiCodec) ParseRequest(body []byte) (*contracts.Request, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("gemini: 请求体不是 JSON 对象: %w", err)
	}
	var wire geminiWireRequest
	if err := json.Unmarshal(body, &wire); err != nil {
		return nil, fmt.Errorf("gemini: 请求体字段不合法: %w", err)
	}

	request := &contracts.Request{}
	request.System = parseGeminiSystem(wire.SystemInstruction)

	for _, content := range wire.Contents {
		role := contracts.RoleUser
		switch content.Role {
		case "model":
			role = contracts.RoleAssistant
		case "user", "":
			role = contracts.RoleUser
		default:
			request.Lossy = append(request.Lossy, lossyNote("request",
				contracts.ProtocolGemini, "", "contents[].role", "coerced", "未知角色按 user 处理"))
		}
		message := contracts.Message{Role: role}
		for _, part := range content.Parts {
			message.Parts = append(message.Parts, parseGeminiPart(part, request))
		}
		if len(message.Parts) == 0 {
			continue
		}
		request.Messages = append(request.Messages, message)
	}

	for _, tool := range wire.Tools {
		for _, declaration := range tool.FunctionDeclarations {
			request.Tools = append(request.Tools, contracts.Tool{
				Name:        declaration.Name,
				Description: declaration.Description,
				InputSchema: declaration.Parameters,
			})
		}
	}
	request.ToolChoice = parseGeminiToolChoice(wire.ToolConfig)

	var generation geminiWireGenerationConfig
	if len(bytes.TrimSpace(wire.GenerationConfig)) > 0 {
		if err := json.Unmarshal(wire.GenerationConfig, &generation); err != nil {
			return nil, fmt.Errorf("gemini: generationConfig 字段不合法: %w", err)
		}
	}
	request.Sampling.Temperature = generation.Temperature
	request.Sampling.TopP = generation.TopP
	request.Sampling.TopK = generation.TopK
	request.Sampling.Stop = generation.StopSequences
	request.Sampling.Seed = generation.Seed
	request.Sampling.N = generation.CandidateCount
	request.MaxTokens = generation.MaxOutputTokens

	request.Extras = extrasOf(raw, geminiKnownKeys)
	return request, nil
}

// parseGeminiSystem 解析 systemInstruction（{parts:[{text}]}）。
func parseGeminiSystem(raw json.RawMessage) []contracts.Part {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	var holder struct {
		Parts []geminiWirePart `json:"parts"`
	}
	if json.Unmarshal(trimmed, &holder) != nil {
		return nil
	}
	parts := make([]contracts.Part, 0, len(holder.Parts))
	for _, part := range holder.Parts {
		if part.Text == "" {
			continue
		}
		parts = append(parts, contracts.Part{Kind: contracts.KindText, Text: part.Text})
	}
	return parts
}

// parseGeminiPart 把一个 Gemini part 映射成 IR 片段。
func parseGeminiPart(part geminiWirePart, request *contracts.Request) contracts.Part {
	switch {
	case part.FunctionCall != nil:
		out := contracts.Part{
			Kind:       contracts.KindToolUse,
			ToolName:   part.FunctionCall.Name,
			ToolCallID: geminiCallID(part.FunctionCall.Name),
		}
		if len(bytes.TrimSpace(part.FunctionCall.Args)) > 0 {
			out.ToolInput = part.FunctionCall.Args
		}
		return out
	case part.FunctionResponse != nil:
		out := contracts.Part{
			Kind:          contracts.KindToolResult,
			ToolResultFor: geminiCallID(part.FunctionResponse.Name),
			Text:          geminiFunctionResponseText(part.FunctionResponse.Response),
		}
		return out
	case part.InlineData != nil:
		return contracts.Part{
			Kind:      contracts.KindImage,
			MediaType: part.InlineData.MimeType,
			ImageURL:  "data:" + part.InlineData.MimeType + ";base64," + part.InlineData.Data,
		}
	case part.Thought:
		// 思考片段：签名在 Gemini 侧无法表达，渲染出去时记 note。
		return contracts.Part{Kind: contracts.KindThinking, Text: part.Text, Signature: part.ThoughtSignature}
	case part.Text != "":
		return contracts.Part{Kind: contracts.KindText, Text: part.Text}
	default:
		return contracts.Part{Kind: contracts.KindUnknown, Raw: mustRaw(part)}
	}
}

// geminiFunctionResponseText 把 functionResponse.response 压成文本。
func geminiFunctionResponseText(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(trimmed, &text) == nil {
		return text
	}
	// 非字符串：原样序列化（不丢信息）。
	return string(trimmed)
}

// ---------------------------------------------------------------------------
// 请求：渲染
// ---------------------------------------------------------------------------

// RenderRequest 把 IR 渲染成 Gemini generateContent 请求体。
func (geminiCodec) RenderRequest(request *contracts.Request) ([]byte, error) {
	if request == nil {
		return nil, errors.New("gemini: 请求为空")
	}
	// Gemini 的 candidateCount > 1 会返回多个候选；IR 只承载一个，明确失败。
	if request.Sampling.N != nil && *request.Sampling.N > 1 {
		return nil, fmt.Errorf("gemini: 不支持 candidateCount>1 的多候选")
	}

	wire := geminiWireRequest{}
	if text := partsText(request.System); text != "" {
		wire.SystemInstruction = mustRaw(map[string]any{
			"parts": []any{map[string]any{"text": text}},
		})
	}
	for _, message := range request.Messages {
		content, ok := renderGeminiContent(message, request)
		if !ok {
			continue
		}
		wire.Contents = append(wire.Contents, content)
	}

	if len(request.Tools) > 0 {
		declarations := make([]geminiWireFunctionDeclaration, 0, len(request.Tools))
		for _, tool := range request.Tools {
			schema := tool.InputSchema
			if len(bytes.TrimSpace(schema)) == 0 {
				schema = json.RawMessage(`{"type":"object"}`)
			}
			declarations = append(declarations, geminiWireFunctionDeclaration{
				Name:        tool.Name,
				Description: tool.Description,
				Parameters:  schema,
			})
		}
		wire.Tools = []geminiWireTool{{FunctionDeclarations: declarations}}
	}
	wire.ToolConfig = renderGeminiToolChoice(request.ToolChoice)

	generation := geminiWireGenerationConfig{
		Temperature:     request.Sampling.Temperature,
		TopP:            request.Sampling.TopP,
		TopK:            request.Sampling.TopK,
		MaxOutputTokens: request.MaxTokens,
		StopSequences:   request.Sampling.Stop,
		Seed:            request.Sampling.Seed,
	}
	generationRaw := mergeGenerationConfig(mustRaw(generation), request.Extras)
	wire.GenerationConfig = generationRaw

	dropOpenAIOnlyForGemini(request)

	for key := range request.Extras {
		if key == "generationConfig" || key == "generation_config" {
			continue
		}
		request.Lossy = append(request.Lossy, lossyNote("request", "",
			contracts.ProtocolGemini, "extras."+key, "dropped", "Gemini 无法表示"))
	}
	return json.Marshal(wire)
}

// mergeGenerationConfig 把客户端原始 generationConfig 里 IR 未建模的字段合回去。
func mergeGenerationConfig(base json.RawMessage, extras map[string]json.RawMessage) json.RawMessage {
	var fields map[string]json.RawMessage
	if json.Unmarshal(base, &fields) != nil {
		return base
	}
	for _, key := range []string{"generationConfig", "generation_config"} {
		raw, ok := extras[key]
		if !ok {
			continue
		}
		var original map[string]json.RawMessage
		if json.Unmarshal(raw, &original) != nil {
			continue
		}
		for name, value := range original {
			if _, exists := fields[name]; exists {
				continue
			}
			switch name {
			case "temperature", "topP", "topK", "maxOutputTokens", "stopSequences", "candidateCount", "seed":
				// IR 已建模的字段由 IR 决定，不被原值覆盖。
				continue
			}
			fields[name] = value
		}
	}
	return mustRaw(fields)
}

// renderGeminiContent 把一条 IR 消息渲染成 Gemini content。
func renderGeminiContent(message contracts.Message, request *contracts.Request) (geminiWireContent, bool) {
	role := "user"
	switch message.Role {
	case contracts.RoleAssistant:
		role = "model"
	case contracts.RoleUser:
		role = "user"
	case contracts.RoleTool:
		// 工具结果在 Gemini 里是 user 回合里的 functionResponse。
		role = "user"
	default:
		request.Lossy = append(request.Lossy, lossyNote("request", "",
			contracts.ProtocolGemini, "messages[].role", "coerced", "Gemini 按 user 处理"))
	}
	content := geminiWireContent{Role: role}
	for _, part := range message.Parts {
		switch part.Kind {
		case contracts.KindText:
			content.Parts = append(content.Parts, geminiWirePart{Text: part.Text})
		case contracts.KindImage:
			wire, ok := renderGeminiInlineData(part)
			if !ok {
				request.Lossy = append(request.Lossy, lossyNote("request", "",
					contracts.ProtocolGemini, "image", "dropped", "Gemini 只接受 inlineData(base64)"))
				continue
			}
			content.Parts = append(content.Parts, wire)
		case contracts.KindToolUse:
			content.Parts = append(content.Parts, geminiWirePart{
				FunctionCall: &geminiWireFunctionCall{
					Name: part.ToolName,
					Args: toolInputOrDefault(part.ToolInput),
				},
			})
		case contracts.KindToolResult:
			content.Parts = append(content.Parts, geminiWirePart{
				FunctionResponse: &geminiWireFunctionResponse{
					Name:     geminiToolNameOf(part),
					Response: mustRaw(map[string]any{"result": part.Text}),
				},
			})
		case contracts.KindThinking:
			request.Lossy = append(request.Lossy, lossyNote("request", "",
				contracts.ProtocolGemini, thinkingLossyField(part), "dropped", "Gemini 无法表示 thinking 片段"))
		default:
			request.Lossy = append(request.Lossy, lossyNote("request", "",
				contracts.ProtocolGemini, string(part.Kind), "dropped", "Gemini 无法表示"))
		}
	}
	if len(content.Parts) == 0 {
		return geminiWireContent{}, false
	}
	return content, true
}

// renderGeminiInlineData 把 IR 图片渲染成 Gemini inlineData。
func renderGeminiInlineData(part contracts.Part) (geminiWirePart, bool) {
	url := part.ImageURL
	if !strings.HasPrefix(url, "data:") {
		return geminiWirePart{}, false
	}
	rest := strings.TrimPrefix(url, "data:")
	mediaType, data, ok := strings.Cut(rest, ";base64,")
	if !ok {
		return geminiWirePart{}, false
	}
	return geminiWirePart{InlineData: &geminiWireInlineData{MimeType: mediaType, Data: data}}, true
}

// geminiToolNameOf 取工具结果对应的工具名。
//
// Gemini 的 functionResponse 只带函数名，不带调用 id；IR 里存的是调用 id，
// 所以这里按「id → 名字」的映射还原（IR 的 ToolCallID 形如 gemini_call_<name>）。
func geminiToolNameOf(part contracts.Part) string {
	id := part.ToolResultFor
	if strings.HasPrefix(id, geminiCallIDPrefix) {
		return strings.TrimPrefix(id, geminiCallIDPrefix)
	}
	return id
}

// dropOpenAIOnlyForGemini 记录 OpenAI / Anthropic 专有字段渲染到 Gemini 时的丢弃。
func dropOpenAIOnlyForGemini(request *contracts.Request) {
	note := func(field string) {
		request.Lossy = append(request.Lossy, lossyNote("request", "",
			contracts.ProtocolGemini, field, "dropped", "Gemini 不支持该字段"))
	}
	if request.Sampling.PresencePenalty != nil {
		note("presence_penalty")
	}
	if request.Sampling.FrequencyPenalty != nil {
		note("frequency_penalty")
	}
	if request.Sampling.Logprobs != nil {
		note("logprobs")
	}
	if request.Sampling.TopLogprobs != nil {
		note("top_logprobs")
	}
	if request.ResponseFormat != nil {
		// Gemini 用 generationConfig.responseMimeType / responseSchema 表达，
		// IR 的 response_format（json_schema）语义相近但字段不同：明确记丢弃。
		note("response_format")
	}
	if request.User != "" {
		note("user")
	}
}

// ---------------------------------------------------------------------------
// 工具调用 id
// ---------------------------------------------------------------------------

// geminiCallIDPrefix 是网关生成的工具调用 id 前缀。
//
// Gemini 的 functionCall / functionResponse 只带函数名，没有独立的调用 id；
// 为了让 IR 能把结果对回调用，这里用「前缀 + 函数名」构造一个可逆的 id。
const geminiCallIDPrefix = "gemini_call_"

func geminiCallID(name string) string { return geminiCallIDPrefix + name }

// ---------------------------------------------------------------------------
// 响应：线格式
// ---------------------------------------------------------------------------

type geminiWireUsage struct {
	PromptTokenCount        int `json:"promptTokenCount,omitempty"`
	CandidatesTokenCount    int `json:"candidatesTokenCount,omitempty"`
	CachedContentTokenCount int `json:"cachedContentTokenCount,omitempty"`
	ThoughtsTokenCount      int `json:"thoughtsTokenCount,omitempty"`
	TotalTokenCount         int `json:"totalTokenCount,omitempty"`
}

type geminiWireResponse struct {
	ResponseID    string                `json:"responseId,omitempty"`
	ModelVersion  string                `json:"modelVersion,omitempty"`
	Candidates    []geminiWireCandidate `json:"candidates,omitempty"`
	UsageMetadata *geminiWireUsage      `json:"usageMetadata,omitempty"`
}

type geminiWireCandidate struct {
	Content      geminiWireContent `json:"content"`
	FinishReason string            `json:"finishReason,omitempty"`
	Index        int               `json:"index,omitempty"`
}

// ParseResponse 把 Gemini 响应解析成 IR。
func (geminiCodec) ParseResponse(body []byte) (*contracts.Response, error) {
	var wire geminiWireResponse
	if err := json.Unmarshal(body, &wire); err != nil {
		return nil, fmt.Errorf("gemini: 响应体不是 JSON: %w", err)
	}
	response := &contracts.Response{ID: wire.ResponseID, Model: wire.ModelVersion}
	if len(wire.Candidates) > 0 {
		candidate := wire.Candidates[0]
		holder := &contracts.Request{}
		for _, part := range candidate.Content.Parts {
			response.Parts = append(response.Parts, parseGeminiPart(part, holder))
		}
		response.Lossy = append(response.Lossy, holder.Lossy...)
		response.Stop = geminiFinishToStop(candidate.FinishReason, func(note contracts.LossyNote) {
			response.Lossy = append(response.Lossy, note)
		})
	}
	response.Usage = geminiUsageFromWire(wire.UsageMetadata)
	return response, nil
}

// RenderResponse 把 IR 渲染成 Gemini 响应。
func (geminiCodec) RenderResponse(response *contracts.Response) ([]byte, error) {
	if response == nil {
		return nil, errors.New("gemini: 响应为空")
	}
	candidate := geminiWireCandidate{
		Content:      geminiWireContent{Role: "model"},
		FinishReason: irStopToGeminiFinish(response.Stop),
	}
	var builder strings.Builder
	for _, part := range response.Parts {
		switch part.Kind {
		case contracts.KindText:
			builder.WriteString(part.Text)
			candidate.Content.Parts = append(candidate.Content.Parts, geminiWirePart{Text: part.Text})
		case contracts.KindToolUse:
			candidate.Content.Parts = append(candidate.Content.Parts, geminiWirePart{
				FunctionCall: &geminiWireFunctionCall{
					Name: part.ToolName,
					Args: toolInputOrDefault(part.ToolInput),
				},
			})
		case contracts.KindThinking:
			response.Lossy = append(response.Lossy, lossyNote("response", "",
				contracts.ProtocolGemini, thinkingLossyField(part), "dropped", "Gemini 响应无法表示 thinking 片段"))
		default:
			response.Lossy = append(response.Lossy, lossyNote("response", "",
				contracts.ProtocolGemini, string(part.Kind), "dropped", "Gemini 响应无法表示"))
		}
	}
	wire := geminiWireResponse{
		ResponseID:   response.ID,
		ModelVersion: response.Model,
		Candidates:   []geminiWireCandidate{candidate},
	}
	if usage := geminiUsageToWire(response.Usage); usage != nil {
		wire.UsageMetadata = usage
	}
	return json.Marshal(wire)
}

// ---------------------------------------------------------------------------
// usage 归一化
// ---------------------------------------------------------------------------

// geminiUsageFromWire 把 Gemini 的 usageMetadata 归一成 IR 四桶。
//
// 口径（与现有三个 codec 一致，**不新造**）：
//   - promptTokenCount **含** cachedContentTokenCount（Google 官方明确说明：
//     设了 cachedContent 时它仍是总提示长度）→ 与 OpenAI 一样是「含缓存」口径；
//   - candidatesTokenCount 是输出；thoughtsTokenCount 是思考 token
//     （按现有惯例当作输出的子集记进 ReasoningTokens，不重复相加）；
//   - Gemini 没有「写缓存」的概念 → cacheCreation 恒为 0。
//
// 「input 不含缓存」的那一步由 internal/usageprobe.Normalize 按上游协议完成
// （它对 OpenAI 与 Gemini 都做减法，对 Anthropic 不做，因为 Anthropic 的
// input_tokens 本来就不含缓存）。
func geminiUsageFromWire(usage *geminiWireUsage) contracts.Usage {
	if usage == nil {
		return contracts.Usage{}
	}
	out := contracts.Usage{
		InputTokens:          usage.PromptTokenCount,
		OutputTokens:         usage.CandidatesTokenCount,
		CacheReadInputTokens: usage.CachedContentTokenCount,
		ReasoningTokens:      usage.ThoughtsTokenCount,
		Raw: map[string]int{
			"promptTokenCount":        usage.PromptTokenCount,
			"candidatesTokenCount":    usage.CandidatesTokenCount,
			"cachedContentTokenCount": usage.CachedContentTokenCount,
			"thoughtsTokenCount":      usage.ThoughtsTokenCount,
			"totalTokenCount":         usage.TotalTokenCount,
		},
	}
	return out
}

// geminiUsageToWire 把 IR 四桶渲染回 Gemini 的 usageMetadata。
//
// 与其它 codec 一样**原样带过**（不做减法）：减法统一由 usageprobe.Normalize
// 按上游协议完成，避免两处各扣一次。
func geminiUsageToWire(usage contracts.Usage) *geminiWireUsage {
	wire := &geminiWireUsage{
		PromptTokenCount:        usage.InputTokens,
		CandidatesTokenCount:    usage.OutputTokens,
		CachedContentTokenCount: usage.CacheReadInputTokens,
		ThoughtsTokenCount:      usage.ReasoningTokens,
	}
	wire.TotalTokenCount = wire.PromptTokenCount + wire.CandidatesTokenCount
	return wire
}

// ---------------------------------------------------------------------------
// 枚举互译
// ---------------------------------------------------------------------------

// geminiFinishToStop 把 Gemini 的 finishReason 翻成 IR 停止原因。
func geminiFinishToStop(reason string, add func(contracts.LossyNote)) contracts.StopReason {
	switch reason {
	case "STOP":
		return contracts.StopEndTurn
	case "MAX_TOKENS":
		return contracts.StopMaxTokens
	case "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII":
		return contracts.StopContentFilter
	case "":
		return contracts.StopUnknown
	default:
		if add != nil {
			add(lossyNote("response", contracts.ProtocolGemini, "", "finishReason", "mapped", "未知 finishReason 归为 unknown"))
		}
		return contracts.StopUnknown
	}
}

// irStopToGeminiFinish 把 IR 停止原因翻成 Gemini 的 finishReason。
func irStopToGeminiFinish(stop contracts.StopReason) string {
	switch stop {
	case contracts.StopEndTurn, contracts.StopSequence:
		return "STOP"
	case contracts.StopMaxTokens:
		return "MAX_TOKENS"
	case contracts.StopContentFilter:
		return "SAFETY"
	case contracts.StopToolUse:
		// Gemini 用 parts 里的 functionCall 表示工具调用，没有专门的 finishReason；
		// 这里按正常结束处理（工具调用本身已经在 parts 里）。
		return "STOP"
	default:
		return "STOP"
	}
}

// parseGeminiToolChoice 解析 toolConfig.functionCallingConfig。
func parseGeminiToolChoice(raw json.RawMessage) *contracts.ToolChoice {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	var config geminiWireToolConfig
	if json.Unmarshal(trimmed, &config) != nil {
		return nil
	}
	switch config.FunctionCallingConfig.Mode {
	case "AUTO":
		return &contracts.ToolChoice{Mode: contracts.ToolChoiceAuto}
	case "ANY":
		return &contracts.ToolChoice{Mode: contracts.ToolChoiceRequired}
	case "NONE":
		return &contracts.ToolChoice{Mode: contracts.ToolChoiceNone}
	default:
		return nil
	}
}

// renderGeminiToolChoice 渲染 toolConfig。
func renderGeminiToolChoice(choice *contracts.ToolChoice) json.RawMessage {
	if choice == nil {
		return nil
	}
	mode := "AUTO"
	switch choice.Mode {
	case contracts.ToolChoiceRequired:
		mode = "ANY"
	case contracts.ToolChoiceNone:
		mode = "NONE"
	case contracts.ToolChoiceTool:
		// 指定函数：Gemini 用 allowedFunctionNames 表达。
		return mustRaw(map[string]any{
			"functionCallingConfig": map[string]any{
				"mode":                 "ANY",
				"allowedFunctionNames": []string{choice.Name},
			},
		})
	}
	return mustRaw(map[string]any{
		"functionCallingConfig": map[string]any{"mode": mode},
	})
}
