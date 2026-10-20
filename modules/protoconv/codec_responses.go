package protoconv

// OpenAI Responses 编解码（codec）。
//
// 线上格式对照 OpenAI 官方文档核实（2026-10，platform.openai.com/docs/api-reference/responses、
// Azure OpenAI REST 参考与 openai-go v2 / openai_dart 的 wire 常量）：
//
//   - 请求：POST /v1/responses，body {model, input, instructions, tools, tool_choice,
//     temperature, top_p, max_output_tokens, stream, metadata, store, reasoning, text,
//     previous_response_id, ...}。
//     - input 可以是字符串，也可以是 item 数组：
//     {type:"message", role, content:[{type:"input_text",text} | {type:"output_text",text} |
//     {type:"input_image", image_url, detail, file_id}]}、
//     {type:"function_call", call_id, name, arguments}、
//     {type:"function_call_output", call_id, output}、{type:"reasoning", summary}。
//     - tools[] 是**扁平**的 {type:"function", name, description, parameters, strict}，
//     与 Chat Completions 的 {type:"function", function:{...}} 不同。
//     - tool_choice 是 "none"|"auto"|"required" 或 {type:"function", name}。
//     - instructions 对应 IR 的 Request.System。
//   - 响应：{id, object:"response", status, model, output:[...], output_text,
//     usage:{input_tokens, output_tokens, total_tokens, input_tokens_details.cached_tokens,
//     output_tokens_details.reasoning_tokens}}。status 取 completed / incomplete / failed；
//     incomplete 时 incomplete_details.reason 说明原因（如 max_output_tokens）。
//     output[] item：{type:"message", role:"assistant", content:[{type:"output_text",text}]}、
//     {type:"function_call", call_id, name, arguments}、{type:"reasoning", summary}。
//
// 工具调用 id：Responses 的 function_call 同时有 id（item id）与 call_id；回填
// function_call_output 用的是 call_id。IR 只有 Part.ToolCallID，这里一律映射 call_id，
// 渲染时原样写回 call_id —— 映射是恒等且可逆的，多轮工具循环不会串号。

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// responsesCodec 是 OpenAI Responses 的完整 codec。
//
// 同协议直通时它不会被调用（stage 走快路径），它主要服务跨协议场景。
type responsesCodec struct{}

// NewResponsesCodec 返回 OpenAI Responses codec。
func NewResponsesCodec() contracts.Codec { return responsesCodec{} }

func (responsesCodec) Protocol() contracts.Protocol { return contracts.ProtocolOpenAIResponses }

// responsesKnownKeys 是 IR 已建模的顶层请求字段；其余进 Request.Extras。
var responsesKnownKeys = map[string]struct{}{
	"model": {}, "stream": {}, "input": {}, "instructions": {}, "tools": {},
	"tool_choice": {}, "temperature": {}, "top_p": {}, "max_output_tokens": {},
	"top_logprobs": {}, "user": {}, "text": {},
}

// responsesPassthroughKeys 是 Responses 原生、但 IR 未建模的字段名。
//
// 渲染 Responses 请求时它们从 Request.Extras 原样写回（保住 Responses 语义）；
// 其他来源的 Extras（如 Chat 的 logit_bias）不属于 Responses，丢弃并各记一条 LossyNote。
var responsesPassthroughKeys = map[string]struct{}{
	"store": {}, "metadata": {}, "reasoning": {}, "previous_response_id": {},
	"parallel_tool_calls": {}, "truncation": {}, "include": {}, "background": {},
	"prompt": {}, "conversation": {}, "max_tool_calls": {}, "stream_options": {},
	"safety_identifier": {}, "prompt_cache_key": {}, "context_management": {}, "service_tier": {},
}

// ---------------------------------------------------------------------------
// 请求：线格式
// ---------------------------------------------------------------------------

type responsesWireRequest struct {
	Model           string              `json:"model"`
	Stream          bool                `json:"stream"`
	Input           json.RawMessage     `json:"input"`
	Instructions    string              `json:"instructions"`
	Tools           []responsesWireTool `json:"tools"`
	ToolChoice      json.RawMessage     `json:"tool_choice"`
	Text            json.RawMessage     `json:"text"`
	Temperature     *float64            `json:"temperature"`
	TopP            *float64            `json:"top_p"`
	MaxOutputTokens *int                `json:"max_output_tokens"`
	TopLogprobs     *int                `json:"top_logprobs"`
	User            string              `json:"user"`
}

type responsesWireTool struct {
	Type        string          `json:"type"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
	Strict      *bool           `json:"strict"`
}

type responsesWireInputItem struct {
	Type      string          `json:"type"`
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	CallID    string          `json:"call_id"`
	Name      string          `json:"name"`
	Arguments string          `json:"arguments"`
	Output    json.RawMessage `json:"output"`
	Summary   json.RawMessage `json:"summary"`
}

// ParseRequest 把 Responses 请求体解析成 IR。
func (responsesCodec) ParseRequest(body []byte) (*contracts.Request, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("responses: 请求体不是 JSON 对象: %w", err)
	}
	var wire responsesWireRequest
	if err := json.Unmarshal(body, &wire); err != nil {
		return nil, fmt.Errorf("responses: 请求体字段不合法: %w", err)
	}

	request := &contracts.Request{
		Model:  wire.Model,
		Stream: wire.Stream,
		User:   wire.User,
	}
	request.MaxTokens = wire.MaxOutputTokens
	request.Sampling.Temperature = wire.Temperature
	request.Sampling.TopP = wire.TopP
	request.Sampling.TopLogprobs = wire.TopLogprobs

	if wire.Instructions != "" {
		request.System = []contracts.Part{{Kind: contracts.KindText, Text: wire.Instructions}}
	}

	parseResponsesInput(request, wire.Input)

	for _, tool := range wire.Tools {
		if tool.Type != "" && tool.Type != "function" {
			request.Lossy = append(request.Lossy, lossyNote("request",
				contracts.ProtocolOpenAIResponses, "", "tools."+tool.Type, "dropped", "只支持 function 工具"))
			continue
		}
		strict := false
		if tool.Strict != nil {
			strict = *tool.Strict
		}
		request.Tools = append(request.Tools, contracts.Tool{
			Name:        tool.Name,
			Description: tool.Description,
			InputSchema: tool.Parameters,
			Strict:      strict,
		})
	}

	request.ToolChoice = parseResponsesToolChoice(wire.ToolChoice)
	request.ResponseFormat = parseResponsesTextFormat(wire.Text, request)
	request.Extras = extrasOf(raw, responsesKnownKeys)
	return request, nil
}

func parseResponsesInput(request *contracts.Request, raw json.RawMessage) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return
	}
	switch trimmed[0] {
	case '"':
		var text string
		if json.Unmarshal(trimmed, &text) == nil && text != "" {
			request.Messages = append(request.Messages, contracts.Message{
				Role:  contracts.RoleUser,
				Parts: []contracts.Part{{Kind: contracts.KindText, Text: text}},
			})
		}
	case '[':
		var items []json.RawMessage
		if json.Unmarshal(trimmed, &items) != nil {
			return
		}
		for _, item := range items {
			parseResponsesInputItem(request, item)
		}
	default:
		request.Lossy = append(request.Lossy, lossyNote("request",
			contracts.ProtocolOpenAIResponses, "", "input", "coerced", "input 只支持字符串或 item 数组"))
	}
}

func parseResponsesInputItem(request *contracts.Request, raw json.RawMessage) {
	var item responsesWireInputItem
	if json.Unmarshal(raw, &item) != nil {
		request.Lossy = append(request.Lossy, lossyNote("request",
			contracts.ProtocolOpenAIResponses, "", "input[]", "dropped", "无法解析的 item"))
		return
	}
	switch item.Type {
	case "", "message":
		appendResponsesMessage(request, item)
	case "function_call":
		part := contracts.Part{
			Kind:       contracts.KindToolUse,
			ToolCallID: item.CallID,
			ToolName:   item.Name,
		}
		if strings.TrimSpace(item.Arguments) != "" {
			part.ToolInput = json.RawMessage(item.Arguments)
		}
		request.Messages = append(request.Messages, contracts.Message{
			Role:  contracts.RoleAssistant,
			Parts: []contracts.Part{part},
		})
	case "function_call_output":
		request.Messages = append(request.Messages, contracts.Message{
			Role:       contracts.RoleTool,
			ToolCallID: item.CallID,
			Parts: []contracts.Part{{
				Kind:          contracts.KindToolResult,
				ToolResultFor: item.CallID,
				Text:          responsesOutputText(&request.Lossy, item.Output),
			}},
		})
	case "reasoning":
		parts := parseResponsesReasoningParts(item.Summary)
		if len(parts) > 0 {
			request.Messages = append(request.Messages, contracts.Message{
				Role:  contracts.RoleAssistant,
				Parts: parts,
			})
		}
	case "item_reference":
		request.Lossy = append(request.Lossy, lossyNote("request",
			contracts.ProtocolOpenAIResponses, "", "input[].type=item_reference", "dropped", "IR 无 item 引用"))
	default:
		request.Lossy = append(request.Lossy, lossyNote("request",
			contracts.ProtocolOpenAIResponses, "", "input[].type="+item.Type, "dropped", "未支持的输入项"))
	}
}

func appendResponsesMessage(request *contracts.Request, item responsesWireInputItem) {
	switch item.Role {
	case "system", "developer":
		for _, part := range parseResponsesContent(&request.Lossy, item.Content) {
			if part.Kind == contracts.KindText {
				request.System = append(request.System, part)
				continue
			}
			request.Lossy = append(request.Lossy, lossyNote("request",
				contracts.ProtocolOpenAIResponses, "", "input[].content", "dropped", "system 只保留文本"))
		}
		return
	}

	role := contracts.RoleUser
	switch item.Role {
	case "assistant":
		role = contracts.RoleAssistant
	case "user", "":
		role = contracts.RoleUser
	default:
		request.Lossy = append(request.Lossy, lossyNote("request",
			contracts.ProtocolOpenAIResponses, "", "input[].role", "coerced", "未知角色按 user 处理"))
	}
	request.Messages = append(request.Messages, contracts.Message{
		Role:  role,
		Parts: parseResponsesContent(&request.Lossy, item.Content),
	})
}

// parseResponsesContent 解析 message 的 content（字符串或内容块数组）。
//
// lossy 是接收有损映射的落点（请求方向是 Request.Lossy，响应方向是 Response.Lossy）。
func parseResponsesContent(lossy *[]contracts.LossyNote, raw json.RawMessage) []contracts.Part {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	switch trimmed[0] {
	case '"':
		var text string
		if json.Unmarshal(trimmed, &text) != nil || text == "" {
			return nil
		}
		return []contracts.Part{{Kind: contracts.KindText, Text: text}}
	case '[':
		var items []json.RawMessage
		if json.Unmarshal(trimmed, &items) != nil {
			return nil
		}
		parts := make([]contracts.Part, 0, len(items))
		for _, item := range items {
			parts = append(parts, parseResponsesContentPart(lossy, item))
		}
		return parts
	default:
		return nil
	}
}

func parseResponsesContentPart(lossy *[]contracts.LossyNote, raw json.RawMessage) contracts.Part {
	var envelope struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		Refusal  string `json:"refusal"`
		ImageURL string `json:"image_url"`
		FileID   string `json:"file_id"`
		Detail   string `json:"detail"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		return contracts.Part{Kind: contracts.KindUnknown, Raw: raw}
	}
	switch envelope.Type {
	case "input_text", "output_text", "text":
		return contracts.Part{Kind: contracts.KindText, Text: envelope.Text}
	case "input_image":
		if envelope.FileID != "" {
			*lossy = append(*lossy, lossyNote("request",
				contracts.ProtocolOpenAIResponses, "", "input[].content.input_image.file_id", "dropped", "IR 只保留 image_url"))
		}
		if envelope.Detail != "" {
			*lossy = append(*lossy, lossyNote("request",
				contracts.ProtocolOpenAIResponses, "", "input[].content.input_image.detail", "dropped", "IR 无 detail 字段"))
		}
		return contracts.Part{Kind: contracts.KindImage, ImageURL: envelope.ImageURL}
	case "refusal":
		return contracts.Part{Kind: contracts.KindUnknown, Raw: raw}
	default:
		return contracts.Part{Kind: contracts.KindUnknown, Raw: raw}
	}
}

// responsesOutputText 把 function_call_output 的 output 归一成文本。
func responsesOutputText(lossy *[]contracts.LossyNote, raw json.RawMessage) string {
	parts := parseResponsesContent(lossy, raw)
	var builder strings.Builder
	for _, part := range parts {
		if part.Kind == contracts.KindText {
			builder.WriteString(part.Text)
		}
	}
	return builder.String()
}

func parseResponsesReasoningParts(raw json.RawMessage) []contracts.Part {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	var summary []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(trimmed, &summary) != nil {
		return nil
	}
	parts := make([]contracts.Part, 0, len(summary))
	for _, item := range summary {
		if item.Text == "" {
			continue
		}
		parts = append(parts, contracts.Part{Kind: contracts.KindThinking, Text: item.Text})
	}
	return parts
}

// ---------------------------------------------------------------------------
// 请求：渲染
// ---------------------------------------------------------------------------

// RenderRequest 把 IR 渲染成 Responses 请求体。
func (responsesCodec) RenderRequest(request *contracts.Request) ([]byte, error) {
	if request == nil {
		return nil, errors.New("responses: 请求为空")
	}
	if request.Sampling.N != nil && *request.Sampling.N > 1 {
		return nil, errors.New("responses: 不支持 n>1（Responses 只返回单个候选）")
	}

	object := map[string]any{"model": request.Model}
	if request.Stream {
		object["stream"] = true
	}
	if text := partsText(request.System); text != "" {
		object["instructions"] = text
	}
	for _, part := range request.System {
		if part.Kind != contracts.KindText {
			request.Lossy = append(request.Lossy, lossyNote("request", "",
				contracts.ProtocolOpenAIResponses, "instructions", "dropped", "instructions 只保留文本"))
		}
	}

	counter := 0
	items, err := renderResponsesInput(request, &counter)
	if err != nil {
		return nil, err
	}
	object["input"] = items

	if len(request.Tools) > 0 {
		tools := make([]any, 0, len(request.Tools))
		for _, tool := range request.Tools {
			parameters := tool.InputSchema
			if len(bytes.TrimSpace(parameters)) == 0 {
				parameters = json.RawMessage(`{}`)
			}
			wire := map[string]any{"type": "function", "name": tool.Name, "parameters": parameters}
			if tool.Description != "" {
				wire["description"] = tool.Description
			}
			if tool.Strict {
				wire["strict"] = true
			}
			tools = append(tools, wire)
		}
		object["tools"] = tools
	}
	if request.ToolChoice != nil {
		object["tool_choice"] = renderResponsesToolChoice(request.ToolChoice)
	}
	if request.ResponseFormat != nil {
		object["text"] = renderResponsesTextFormat(request.ResponseFormat)
	}
	if request.Sampling.Temperature != nil {
		object["temperature"] = *request.Sampling.Temperature
	}
	if request.Sampling.TopP != nil {
		object["top_p"] = *request.Sampling.TopP
	}
	if request.MaxTokens != nil {
		object["max_output_tokens"] = *request.MaxTokens
	}
	if request.Sampling.TopLogprobs != nil {
		object["top_logprobs"] = *request.Sampling.TopLogprobs
	}
	if request.User != "" {
		object["user"] = request.User
	}

	responsesNoteUnsupportedSampling(request)

	// Extras：Responses 原生字段（store / metadata / reasoning / previous_response_id …）
	// 原样写回；其余来源的字段不属于 Responses，丢弃并各记一条 LossyNote。
	for key, value := range request.Extras {
		if _, ok := responsesPassthroughKeys[key]; ok {
			object[key] = value
			continue
		}
		request.Lossy = append(request.Lossy, lossyNote("request", "",
			contracts.ProtocolOpenAIResponses, "extras."+key, "dropped", "Responses 无法表示"))
	}
	return json.Marshal(object)
}

func responsesNoteUnsupportedSampling(request *contracts.Request) {
	note := func(field string) {
		request.Lossy = append(request.Lossy, lossyNote("request", "",
			contracts.ProtocolOpenAIResponses, field, "dropped", "Responses 不支持"))
	}
	if request.Sampling.TopK != nil {
		note("top_k")
	}
	if len(request.Sampling.Stop) > 0 {
		note("stop")
	}
	if request.Sampling.PresencePenalty != nil {
		note("presence_penalty")
	}
	if request.Sampling.FrequencyPenalty != nil {
		note("frequency_penalty")
	}
	if request.Sampling.Seed != nil {
		note("seed")
	}
	if request.Sampling.Logprobs != nil {
		note("logprobs")
	}
}

func renderResponsesInput(request *contracts.Request, counter *int) ([]any, error) {
	items := make([]any, 0, len(request.Messages))
	for _, message := range request.Messages {
		rendered, err := renderResponsesMessage(message, request, counter)
		if err != nil {
			return nil, err
		}
		items = append(items, rendered...)
	}
	return items, nil
}

func renderResponsesMessage(message contracts.Message, request *contracts.Request, counter *int) ([]any, error) {
	if message.Role == contracts.RoleTool {
		var items []any
		for _, part := range message.Parts {
			if part.Kind != contracts.KindToolResult {
				continue
			}
			items = append(items, map[string]any{
				"type":    "function_call_output",
				"call_id": part.ToolResultFor,
				"output":  part.Text,
			})
		}
		return items, nil
	}

	role := "user"
	switch message.Role {
	case contracts.RoleAssistant:
		role = "assistant"
	case contracts.RoleUser:
		role = "user"
	default:
		request.Lossy = append(request.Lossy, lossyNote("request", "",
			contracts.ProtocolOpenAIResponses, "input[].role", "coerced", "Responses 按 user 处理"))
	}
	contentType := "input_text"
	if role == "assistant" {
		contentType = "output_text"
	}

	var content []any
	var toolItems []any
	var reasoningItems []any
	for _, part := range message.Parts {
		switch part.Kind {
		case contracts.KindText:
			content = append(content, map[string]any{"type": contentType, "text": part.Text})
		case contracts.KindImage:
			if role == "assistant" {
				return nil, fmt.Errorf("responses: assistant 消息不支持图片")
			}
			content = append(content, map[string]any{"type": "input_image", "image_url": part.ImageURL})
		case contracts.KindToolUse:
			callID := part.ToolCallID
			if callID == "" {
				*counter++
				callID = fmt.Sprintf("call_%d", *counter)
				request.Lossy = append(request.Lossy, lossyNote("request", "",
					contracts.ProtocolOpenAIResponses, "tool_call_id", "defaulted", "缺失时按序号补 call_id"))
			}
			arguments := "{}"
			if len(part.ToolInput) > 0 {
				arguments = string(part.ToolInput)
			}
			toolItems = append(toolItems, map[string]any{
				"type":      "function_call",
				"id":        "fc_" + callID,
				"call_id":   callID,
				"name":      part.ToolName,
				"arguments": arguments,
			})
		case contracts.KindThinking:
			if part.Redacted || part.Signature != "" {
				request.Lossy = append(request.Lossy, lossyNote("request", "",
					contracts.ProtocolOpenAIResponses, "thinking.signature", "dropped", "Responses reasoning 无对应字段"))
			}
			*counter++
			reasoningItems = append(reasoningItems, map[string]any{
				"type":    "reasoning",
				"id":      fmt.Sprintf("rs_%d", *counter),
				"summary": []any{map[string]any{"type": "summary_text", "text": part.Text}},
			})
		case contracts.KindToolResult:
			request.Lossy = append(request.Lossy, lossyNote("request", "",
				contracts.ProtocolOpenAIResponses, "tool_result", "dropped", "tool_result 必须是顶层 item"))
		default:
			request.Lossy = append(request.Lossy, lossyNote("request", "",
				contracts.ProtocolOpenAIResponses, string(part.Kind), "dropped", "Responses 无法表示"))
		}
	}

	var items []any
	items = append(items, reasoningItems...)
	if len(content) > 0 {
		items = append(items, map[string]any{"type": "message", "role": role, "content": content})
	}
	items = append(items, toolItems...)
	return items, nil
}

// ---------------------------------------------------------------------------
// 响应：线格式
// ---------------------------------------------------------------------------

type responsesWireOutputItem struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Status    string          `json:"status"`
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	CallID    string          `json:"call_id"`
	Name      string          `json:"name"`
	Arguments string          `json:"arguments"`
	Summary   json.RawMessage `json:"summary"`
}

type responsesWireUsage struct {
	InputTokens        int `json:"input_tokens"`
	OutputTokens       int `json:"output_tokens"`
	TotalTokens        int `json:"total_tokens"`
	InputTokensDetails *struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"input_tokens_details,omitempty"`
	OutputTokensDetails *struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"output_tokens_details,omitempty"`
}

type responsesWireResponse struct {
	ID                string                    `json:"id"`
	Object            string                    `json:"object"`
	Status            string                    `json:"status"`
	Model             string                    `json:"model"`
	Output            []responsesWireOutputItem `json:"output"`
	OutputText        string                    `json:"output_text"`
	Usage             *responsesWireUsage       `json:"usage"`
	IncompleteDetails *struct {
		Reason string `json:"reason"`
	} `json:"incomplete_details"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// ParseResponse 把 Responses 响应体解析成 IR。
func (responsesCodec) ParseResponse(body []byte) (*contracts.Response, error) {
	var wire responsesWireResponse
	if err := json.Unmarshal(body, &wire); err != nil {
		return nil, fmt.Errorf("responses: 响应体不是 JSON: %w", err)
	}
	response := &contracts.Response{ID: wire.ID, Model: wire.Model}
	hasToolUse := false
	for _, item := range wire.Output {
		switch item.Type {
		case "message":
			response.Parts = append(response.Parts, parseResponsesContent(&response.Lossy, item.Content)...)
		case "function_call":
			hasToolUse = true
			part := contracts.Part{
				Kind:       contracts.KindToolUse,
				ToolCallID: item.CallID,
				ToolName:   item.Name,
			}
			if strings.TrimSpace(item.Arguments) != "" {
				part.ToolInput = json.RawMessage(item.Arguments)
			}
			response.Parts = append(response.Parts, part)
		case "reasoning":
			response.Parts = append(response.Parts, parseResponsesReasoningParts(item.Summary)...)
		case "":
			response.Lossy = append(response.Lossy, lossyNote("response",
				contracts.ProtocolOpenAIResponses, "", "output[]", "dropped", "缺少 type 的输出项"))
		default:
			response.Lossy = append(response.Lossy, lossyNote("response",
				contracts.ProtocolOpenAIResponses, "", "output[].type="+item.Type, "dropped", "未支持的输出项"))
		}
	}
	response.Stop = responsesStopFromStatus(wire.Status, responsesIncompleteReason(wire), hasToolUse, response)
	response.Usage = responsesUsageFromWire(wire.Usage)
	return response, nil
}

// RenderResponse 把 IR 渲染成 Responses 响应体。
func (responsesCodec) RenderResponse(response *contracts.Response) ([]byte, error) {
	if response == nil {
		return nil, errors.New("responses: 响应为空")
	}
	id := response.ID
	if id == "" {
		id = "resp_gateway"
	}
	output := make([]any, 0, len(response.Parts))
	var text strings.Builder
	for index, part := range response.Parts {
		switch part.Kind {
		case contracts.KindText:
			text.WriteString(part.Text)
			output = append(output, responsesMessageItem(id, index, part.Text))
		case contracts.KindToolUse:
			output = append(output, responsesFunctionCallItem(id, index, part))
		case contracts.KindThinking:
			if part.Redacted || part.Signature != "" {
				response.Lossy = append(response.Lossy, lossyNote("response", "",
					contracts.ProtocolOpenAIResponses, "thinking.signature", "dropped", "Responses reasoning 无对应字段"))
			}
			output = append(output, responsesReasoningItem(id, index, part.Text))
		default:
			response.Lossy = append(response.Lossy, lossyNote("response", "",
				contracts.ProtocolOpenAIResponses, string(part.Kind), "dropped", "Responses 无法表示"))
		}
	}

	object := map[string]any{
		"id":     id,
		"object": "response",
		"status": responsesStatusFor(response.Stop, response),
		"model":  response.Model,
		"output": output,
	}
	if text.Len() > 0 {
		object["output_text"] = text.String()
	}
	object["usage"] = responsesUsageToWire(response.Usage)
	if reason := responsesIncompleteReasonFor(response.Stop); reason != "" {
		object["incomplete_details"] = map[string]any{"reason": reason}
	}
	return json.Marshal(object)
}

func responsesMessageItem(responseID string, index int, text string) map[string]any {
	return map[string]any{
		"type":   "message",
		"id":     responsesItemID("msg", responseID, index),
		"status": "completed",
		"role":   "assistant",
		"content": []any{
			map[string]any{"type": "output_text", "text": text, "annotations": []any{}},
		},
	}
}

func responsesFunctionCallItem(responseID string, index int, part contracts.Part) map[string]any {
	arguments := "{}"
	if len(part.ToolInput) > 0 {
		arguments = string(part.ToolInput)
	}
	item := map[string]any{
		"type":      "function_call",
		"id":        responsesItemID("fc", responseID, index),
		"call_id":   part.ToolCallID,
		"name":      part.ToolName,
		"arguments": arguments,
		"status":    "completed",
	}
	return item
}

func responsesReasoningItem(responseID string, index int, text string) map[string]any {
	return map[string]any{
		"type":    "reasoning",
		"id":      responsesItemID("rs", responseID, index),
		"summary": []any{map[string]any{"type": "summary_text", "text": text}},
	}
}

func responsesItemID(prefix, responseID string, index int) string {
	return fmt.Sprintf("%s_%s_%d", prefix, responseID, index)
}

// ---------------------------------------------------------------------------
// 枚举互译
// ---------------------------------------------------------------------------

// responsesStopFromStatus 把 status + incomplete_details.reason 映射成 IR StopReason。
func responsesStopFromStatus(status, reason string, hasToolUse bool, response *contracts.Response) contracts.StopReason {
	if hasToolUse {
		return contracts.StopToolUse
	}
	switch status {
	case "completed":
		return contracts.StopEndTurn
	case "incomplete":
		switch reason {
		case "max_output_tokens":
			return contracts.StopMaxTokens
		case "content_filter":
			return contracts.StopContentFilter
		case "":
			return contracts.StopUnknown
		default:
			if response != nil {
				response.Lossy = append(response.Lossy, lossyNote("response",
					contracts.ProtocolOpenAIResponses, "", "incomplete_details.reason="+reason, "coerced", "未知停止原因"))
			}
			return contracts.StopUnknown
		}
	case "failed":
		if response != nil {
			response.Lossy = append(response.Lossy, lossyNote("response",
				contracts.ProtocolOpenAIResponses, "", "status=failed", "coerced", "上游响应失败"))
		}
		return contracts.StopUnknown
	case "":
		return contracts.StopUnknown
	default:
		if response != nil {
			response.Lossy = append(response.Lossy, lossyNote("response",
				contracts.ProtocolOpenAIResponses, "", "status="+status, "coerced", "未知状态"))
		}
		return contracts.StopUnknown
	}
}

func responsesIncompleteReason(wire responsesWireResponse) string {
	if wire.IncompleteDetails != nil {
		return wire.IncompleteDetails.Reason
	}
	return ""
}

// responsesStatusFor 把 IR StopReason 渲染成 Responses status。
func responsesStatusFor(stop contracts.StopReason, response *contracts.Response) string {
	switch stop {
	case contracts.StopMaxTokens, contracts.StopContentFilter:
		return "incomplete"
	case contracts.StopSequence:
		if response != nil {
			response.Lossy = append(response.Lossy, lossyNote("response", "",
				contracts.ProtocolOpenAIResponses, "stop_sequence", "coerced", "Responses 无 stop_sequence"))
		}
		return "completed"
	case contracts.StopUnknown:
		if response != nil {
			response.Lossy = append(response.Lossy, lossyNote("response", "",
				contracts.ProtocolOpenAIResponses, "stop", "coerced", "未知停止原因按 completed"))
		}
		return "completed"
	default:
		return "completed"
	}
}

func responsesIncompleteReasonFor(stop contracts.StopReason) string {
	switch stop {
	case contracts.StopMaxTokens:
		return "max_output_tokens"
	case contracts.StopContentFilter:
		return "content_filter"
	default:
		return ""
	}
}

func responsesUsageFromWire(usage *responsesWireUsage) contracts.Usage {
	if usage == nil {
		return contracts.Usage{}
	}
	out := contracts.Usage{
		InputTokens:  usage.InputTokens,
		OutputTokens: usage.OutputTokens,
		Raw: map[string]int{
			"input_tokens":  usage.InputTokens,
			"output_tokens": usage.OutputTokens,
		},
	}
	if usage.InputTokensDetails != nil {
		out.CacheReadInputTokens = usage.InputTokensDetails.CachedTokens
	}
	if usage.OutputTokensDetails != nil {
		out.ReasoningTokens = usage.OutputTokensDetails.ReasoningTokens
	}
	return out
}

func responsesUsageToWire(usage contracts.Usage) *responsesWireUsage {
	wire := &responsesWireUsage{
		InputTokens:  usage.InputTokens,
		OutputTokens: usage.OutputTokens,
		TotalTokens:  usage.InputTokens + usage.OutputTokens,
	}
	if usage.CacheReadInputTokens != 0 {
		wire.InputTokensDetails = &struct {
			CachedTokens int `json:"cached_tokens"`
		}{CachedTokens: usage.CacheReadInputTokens}
	}
	if usage.ReasoningTokens != 0 {
		wire.OutputTokensDetails = &struct {
			ReasoningTokens int `json:"reasoning_tokens"`
		}{ReasoningTokens: usage.ReasoningTokens}
	}
	return wire
}

// ---------------------------------------------------------------------------
// 工具选择 / 结构化输出
// ---------------------------------------------------------------------------

func parseResponsesToolChoice(raw json.RawMessage) *contracts.ToolChoice {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	if trimmed[0] == '"' {
		var mode string
		if json.Unmarshal(trimmed, &mode) != nil {
			return nil
		}
		switch mode {
		case "none":
			return &contracts.ToolChoice{Mode: contracts.ToolChoiceNone}
		case "required":
			return &contracts.ToolChoice{Mode: contracts.ToolChoiceRequired}
		default:
			return &contracts.ToolChoice{Mode: contracts.ToolChoiceAuto}
		}
	}
	var object struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if json.Unmarshal(trimmed, &object) != nil {
		return nil
	}
	if object.Type == "function" {
		return &contracts.ToolChoice{Mode: contracts.ToolChoiceTool, Name: object.Name}
	}
	return nil
}

func renderResponsesToolChoice(choice *contracts.ToolChoice) any {
	switch choice.Mode {
	case contracts.ToolChoiceNone:
		return "none"
	case contracts.ToolChoiceRequired:
		return "required"
	case contracts.ToolChoiceTool:
		return map[string]any{"type": "function", "name": choice.Name}
	default:
		return "auto"
	}
}

// parseResponsesTextFormat 解析 text.format（结构化输出）→ IR ResponseFormat。
func parseResponsesTextFormat(raw json.RawMessage, request *contracts.Request) *contracts.ResponseFormat {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(trimmed, &envelope) != nil {
		return nil
	}
	for key := range envelope {
		if key != "format" && request != nil {
			request.Lossy = append(request.Lossy, lossyNote("request",
				contracts.ProtocolOpenAIResponses, "", "text."+key, "dropped", "IR 只建模 text.format"))
		}
	}
	formatRaw := bytes.TrimSpace(envelope["format"])
	if len(formatRaw) == 0 || string(formatRaw) == "null" {
		return nil
	}
	var format map[string]json.RawMessage
	if json.Unmarshal(formatRaw, &format) != nil {
		return nil
	}
	typeRaw := bytes.TrimSpace(format["type"])
	if len(typeRaw) == 0 {
		return nil
	}
	var formatType string
	if json.Unmarshal(typeRaw, &formatType) != nil || formatType == "" {
		return nil
	}
	delete(format, "type")
	var schema json.RawMessage
	if len(format) > 0 {
		schema = mustRaw(format)
	}
	return &contracts.ResponseFormat{Type: formatType, JSONSchema: schema}
}

// renderResponsesTextFormat 把 IR ResponseFormat 渲染成 text.format。
func renderResponsesTextFormat(format *contracts.ResponseFormat) map[string]any {
	inner := map[string]any{"type": format.Type}
	if len(format.JSONSchema) > 0 {
		var extra map[string]json.RawMessage
		if json.Unmarshal(format.JSONSchema, &extra) == nil {
			for key, value := range extra {
				inner[key] = value
			}
		}
	}
	return map[string]any{"format": inner}
}
