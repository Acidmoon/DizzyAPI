package protoconv

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// chatCodec 是 OpenAI Chat Completions 的完整 codec。
//
// 同协议直通时它不会被调用（stage 走快路径），它主要服务跨协议场景。
type chatCodec struct{}

// NewChatCodec 返回 OpenAI Chat Completions codec。
func NewChatCodec() contracts.Codec { return chatCodec{} }

func (chatCodec) Protocol() contracts.Protocol { return contracts.ProtocolOpenAIChat }

// chatKnownKeys 是 IR 已建模的顶层请求字段；其余进 Request.Extras。
var chatKnownKeys = map[string]struct{}{
	"model": {}, "stream": {}, "messages": {}, "tools": {}, "tool_choice": {},
	"temperature": {}, "top_p": {}, "max_tokens": {}, "max_completion_tokens": {},
	"stop": {}, "presence_penalty": {}, "frequency_penalty": {}, "seed": {},
	"n": {}, "logprobs": {}, "top_logprobs": {}, "user": {}, "response_format": {},
}

// ---------------------------------------------------------------------------
// 请求：线格式
// ---------------------------------------------------------------------------

type chatWireRequest struct {
	Model               string            `json:"model"`
	Stream              bool              `json:"stream,omitempty"`
	Messages            []chatWireMessage `json:"messages"`
	Tools               []chatWireTool    `json:"tools,omitempty"`
	ToolChoice          json.RawMessage   `json:"tool_choice,omitempty"`
	Temperature         *float64          `json:"temperature,omitempty"`
	TopP                *float64          `json:"top_p,omitempty"`
	MaxTokens           *int              `json:"max_tokens,omitempty"`
	MaxCompletionTokens *int              `json:"max_completion_tokens,omitempty"`
	Stop                json.RawMessage   `json:"stop,omitempty"`
	PresencePenalty     *float64          `json:"presence_penalty,omitempty"`
	FrequencyPenalty    *float64          `json:"frequency_penalty,omitempty"`
	Seed                *int64            `json:"seed,omitempty"`
	N                   *int              `json:"n,omitempty"`
	Logprobs            *bool             `json:"logprobs,omitempty"`
	TopLogprobs         *int              `json:"top_logprobs,omitempty"`
	User                string            `json:"user,omitempty"`
	ResponseFormat      json.RawMessage   `json:"response_format,omitempty"`
}

type chatWireMessage struct {
	Role       string             `json:"role"`
	Content    json.RawMessage    `json:"content,omitempty"`
	Name       string             `json:"name,omitempty"`
	ToolCalls  []chatWireToolCall `json:"tool_calls,omitempty"`
	ToolCallID string             `json:"tool_call_id,omitempty"`
}

type chatWireToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type chatWireTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
		Strict      *bool           `json:"strict,omitempty"`
	} `json:"function"`
}

// ParseRequest 把 Chat Completions 请求体解析成 IR。
func (chatCodec) ParseRequest(body []byte) (*contracts.Request, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("chat: 请求体不是 JSON 对象: %w", err)
	}
	var wire chatWireRequest
	if err := json.Unmarshal(body, &wire); err != nil {
		return nil, fmt.Errorf("chat: 请求体字段不合法: %w", err)
	}

	request := &contracts.Request{
		Model:  wire.Model,
		Stream: wire.Stream,
		User:   wire.User,
	}
	request.Sampling.Temperature = wire.Temperature
	request.Sampling.TopP = wire.TopP
	request.Sampling.PresencePenalty = wire.PresencePenalty
	request.Sampling.FrequencyPenalty = wire.FrequencyPenalty
	request.Sampling.Seed = wire.Seed
	request.Sampling.N = wire.N
	request.Sampling.Logprobs = wire.Logprobs
	request.Sampling.TopLogprobs = wire.TopLogprobs
	request.Sampling.Stop = parseStop(wire.Stop)

	switch {
	case wire.MaxTokens != nil:
		request.MaxTokens = wire.MaxTokens
	case wire.MaxCompletionTokens != nil:
		request.MaxTokens = wire.MaxCompletionTokens
		request.Lossy = append(request.Lossy, lossyNote("request",
			contracts.ProtocolOpenAIChat, "", "max_completion_tokens", "coerced", "按 max_tokens 处理"))
	}

	request.ToolChoice = parseToolChoice(wire.ToolChoice)
	request.ResponseFormat = parseResponseFormat(wire.ResponseFormat)

	for _, message := range wire.Messages {
		appendChatMessage(request, message)
	}
	for _, tool := range wire.Tools {
		if tool.Type != "" && tool.Type != "function" {
			request.Lossy = append(request.Lossy, lossyNote("request",
				contracts.ProtocolOpenAIChat, "", "tools."+tool.Type, "dropped", "只支持 function 工具"))
			continue
		}
		strict := false
		if tool.Function.Strict != nil {
			strict = *tool.Function.Strict
		}
		request.Tools = append(request.Tools, contracts.Tool{
			Name:        tool.Function.Name,
			Description: tool.Function.Description,
			InputSchema: tool.Function.Parameters,
			Strict:      strict,
		})
	}
	request.Extras = extrasOf(raw, chatKnownKeys)
	return request, nil
}

func appendChatMessage(request *contracts.Request, message chatWireMessage) {
	switch message.Role {
	case "system", "developer":
		if message.Role == "developer" {
			request.Lossy = append(request.Lossy, lossyNote("request",
				contracts.ProtocolOpenAIChat, "", "messages[].role=developer", "mapped", "按 system 处理"))
		}
		for _, part := range parseChatContent(message.Content) {
			if part.Kind == contracts.KindText {
				request.System = append(request.System, part)
				continue
			}
			request.Lossy = append(request.Lossy, lossyNote("request",
				contracts.ProtocolOpenAIChat, "", "messages[].content", "dropped", "system 只保留文本"))
		}
		return
	case "tool":
		request.Messages = append(request.Messages, contracts.Message{
			Role:       contracts.RoleTool,
			ToolCallID: message.ToolCallID,
			Parts: []contracts.Part{{
				Kind:          contracts.KindToolResult,
				ToolResultFor: message.ToolCallID,
				Text:          chatContentText(message.Content),
			}},
		})
		return
	}

	role := contracts.RoleUser
	switch message.Role {
	case "assistant":
		role = contracts.RoleAssistant
	case "user", "":
		role = contracts.RoleUser
	default:
		request.Lossy = append(request.Lossy, lossyNote("request",
			contracts.ProtocolOpenAIChat, "", "messages[].role", "coerced", "未知角色按 user 处理"))
	}
	out := contracts.Message{Role: role, Name: message.Name, Parts: parseChatContent(message.Content)}
	for _, call := range message.ToolCalls {
		part := contracts.Part{
			Kind:       contracts.KindToolUse,
			ToolCallID: call.ID,
			ToolName:   call.Function.Name,
		}
		if strings.TrimSpace(call.Function.Arguments) != "" {
			part.ToolInput = json.RawMessage(call.Function.Arguments)
		}
		out.Parts = append(out.Parts, part)
	}
	request.Messages = append(request.Messages, out)
}

func parseChatContent(raw json.RawMessage) []contracts.Part {
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
			parts = append(parts, parseChatPart(item))
		}
		return parts
	default:
		return nil
	}
}

func parseChatPart(raw json.RawMessage) contracts.Part {
	var envelope struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		ImageURL struct {
			URL string `json:"url"`
		} `json:"image_url"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		return contracts.Part{Kind: contracts.KindUnknown, Raw: raw}
	}
	switch envelope.Type {
	case "text", "input_text", "output_text":
		return contracts.Part{Kind: contracts.KindText, Text: envelope.Text}
	case "image_url":
		return contracts.Part{Kind: contracts.KindImage, ImageURL: envelope.ImageURL.URL}
	default:
		return contracts.Part{Kind: contracts.KindUnknown, Raw: raw}
	}
}

func chatContentText(raw json.RawMessage) string {
	parts := parseChatContent(raw)
	var builder strings.Builder
	for _, part := range parts {
		if part.Kind == contracts.KindText {
			builder.WriteString(part.Text)
		}
	}
	return builder.String()
}

// RenderRequest 把 IR 渲染成 Chat Completions 请求体。
func (chatCodec) RenderRequest(request *contracts.Request) ([]byte, error) {
	if request == nil {
		return nil, errors.New("chat: 请求为空")
	}
	wire := chatWireRequest{
		Model:            request.Model,
		Stream:           request.Stream,
		Temperature:      request.Sampling.Temperature,
		TopP:             request.Sampling.TopP,
		MaxTokens:        request.MaxTokens,
		PresencePenalty:  request.Sampling.PresencePenalty,
		FrequencyPenalty: request.Sampling.FrequencyPenalty,
		Seed:             request.Sampling.Seed,
		N:                request.Sampling.N,
		Logprobs:         request.Sampling.Logprobs,
		TopLogprobs:      request.Sampling.TopLogprobs,
		User:             request.User,
	}
	if len(request.Sampling.Stop) > 0 {
		wire.Stop = mustRaw(request.Sampling.Stop)
	}
	if request.Sampling.TopK != nil {
		request.Lossy = append(request.Lossy, lossyNote("request", "",
			contracts.ProtocolOpenAIChat, "top_k", "dropped", "OpenAI Chat 不支持 top_k"))
	}
	if text := partsText(request.System); text != "" {
		wire.Messages = append(wire.Messages, chatWireMessage{Role: "system", Content: mustRaw(text)})
	}
	for _, message := range request.Messages {
		wire.Messages = append(wire.Messages, renderChatMessage(message, request)...)
	}
	for _, tool := range request.Tools {
		var wireTool chatWireTool
		wireTool.Type = "function"
		wireTool.Function.Name = tool.Name
		wireTool.Function.Description = tool.Description
		wireTool.Function.Parameters = tool.InputSchema
		if tool.Strict {
			strict := true
			wireTool.Function.Strict = &strict
		}
		wire.Tools = append(wire.Tools, wireTool)
	}
	if request.ToolChoice != nil {
		wire.ToolChoice = renderToolChoice(request.ToolChoice)
	}
	if request.ResponseFormat != nil {
		wire.ResponseFormat = renderResponseFormat(request.ResponseFormat)
	}
	for key := range request.Extras {
		request.Lossy = append(request.Lossy, lossyNote("request", "",
			contracts.ProtocolOpenAIChat, "extras."+key, "dropped", "OpenAI Chat 无法表示"))
	}
	return json.Marshal(wire)
}

func renderChatMessage(message contracts.Message, request *contracts.Request) []chatWireMessage {
	if message.Role == contracts.RoleTool {
		var out []chatWireMessage
		for _, part := range message.Parts {
			if part.Kind != contracts.KindToolResult {
				continue
			}
			out = append(out, chatWireMessage{
				Role:       "tool",
				ToolCallID: part.ToolResultFor,
				Content:    mustRaw(part.Text),
			})
		}
		return out
	}

	role := "user"
	if message.Role == contracts.RoleAssistant {
		role = "assistant"
	} else if message.Role != contracts.RoleUser {
		request.Lossy = append(request.Lossy, lossyNote("request", "",
			contracts.ProtocolOpenAIChat, "messages[].role", "coerced", "OpenAI Chat 按 user 处理"))
	}
	out := chatWireMessage{Role: role, Name: message.Name}

	var text strings.Builder
	var contentParts []json.RawMessage
	textOnly := true
	for _, part := range message.Parts {
		if hasCacheControl(part.Raw) {
			request.Lossy = append(request.Lossy, lossyNote("request", "",
				contracts.ProtocolOpenAIChat, "cache_control", "dropped", "OpenAI Chat 不支持 cache_control"))
		}
		switch part.Kind {
		case contracts.KindText:
			text.WriteString(part.Text)
			contentParts = append(contentParts, mustRaw(map[string]any{"type": "text", "text": part.Text}))
		case contracts.KindImage:
			textOnly = false
			contentParts = append(contentParts, mustRaw(map[string]any{
				"type":      "image_url",
				"image_url": map[string]string{"url": part.ImageURL},
			}))
		case contracts.KindToolUse:
			call := chatWireToolCall{ID: part.ToolCallID, Type: "function"}
			call.Function.Name = part.ToolName
			if len(part.ToolInput) > 0 {
				call.Function.Arguments = string(part.ToolInput)
			} else {
				call.Function.Arguments = "{}"
			}
			out.ToolCalls = append(out.ToolCalls, call)
		case contracts.KindThinking:
			request.Lossy = append(request.Lossy, lossyNote("request", "",
				contracts.ProtocolOpenAIChat, thinkingLossyField(part), "dropped", "OpenAI Chat 不支持 thinking"))
		default:
			request.Lossy = append(request.Lossy, lossyNote("request", "",
				contracts.ProtocolOpenAIChat, string(part.Kind), "dropped", "OpenAI Chat 无法表示"))
		}
	}
	switch {
	case len(contentParts) == 0:
		// 只有 tool_calls 的 assistant 消息：content 省略。
	case textOnly:
		// 纯文本用字符串形式（OpenAI 的常见形态）。
		out.Content = mustRaw(text.String())
	default:
		out.Content = mustRaw(contentParts)
	}
	return []chatWireMessage{out}
}

// ---------------------------------------------------------------------------
// 响应：线格式
// ---------------------------------------------------------------------------

type chatWireUsage struct {
	PromptTokens            int `json:"prompt_tokens"`
	CompletionTokens        int `json:"completion_tokens"`
	TotalTokens             int `json:"total_tokens,omitempty"`
	CompletionTokensDetails *struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"completion_tokens_details,omitempty"`
	PromptTokensDetails *struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"prompt_tokens_details,omitempty"`
}

type chatWireResponse struct {
	ID      string `json:"id"`
	Object  string `json:"object,omitempty"`
	Model   string `json:"model"`
	Choices []struct {
		Index        int             `json:"index"`
		Message      chatWireMessage `json:"message"`
		FinishReason string          `json:"finish_reason"`
	} `json:"choices"`
	Usage *chatWireUsage `json:"usage,omitempty"`
}

// ParseResponse 把 Chat Completions 响应体解析成 IR。
func (chatCodec) ParseResponse(body []byte) (*contracts.Response, error) {
	var wire chatWireResponse
	if err := json.Unmarshal(body, &wire); err != nil {
		return nil, fmt.Errorf("chat: 响应体不是 JSON: %w", err)
	}
	response := &contracts.Response{ID: wire.ID, Model: wire.Model}
	if len(wire.Choices) > 0 {
		choice := wire.Choices[0]
		response.Parts = append(response.Parts, parseChatContent(choice.Message.Content)...)
		for _, call := range choice.Message.ToolCalls {
			part := contracts.Part{
				Kind:       contracts.KindToolUse,
				ToolCallID: call.ID,
				ToolName:   call.Function.Name,
			}
			if strings.TrimSpace(call.Function.Arguments) != "" {
				part.ToolInput = json.RawMessage(call.Function.Arguments)
			}
			response.Parts = append(response.Parts, part)
		}
		response.Stop = chatFinishToStop(choice.FinishReason)
	}
	response.Usage = usageFromWire(wire.Usage)
	return response, nil
}

// RenderResponse 把 IR 渲染成 Chat Completions 响应体。
func (chatCodec) RenderResponse(response *contracts.Response) ([]byte, error) {
	if response == nil {
		return nil, errors.New("chat: 响应为空")
	}
	wire := chatWireResponse{ID: response.ID, Object: "chat.completion", Model: response.Model}
	message := chatWireMessage{Role: "assistant"}
	var text strings.Builder
	for _, part := range response.Parts {
		switch part.Kind {
		case contracts.KindText:
			text.WriteString(part.Text)
		case contracts.KindToolUse:
			call := chatWireToolCall{ID: part.ToolCallID, Type: "function"}
			call.Function.Name = part.ToolName
			if len(part.ToolInput) > 0 {
				call.Function.Arguments = string(part.ToolInput)
			} else {
				call.Function.Arguments = "{}"
			}
			message.ToolCalls = append(message.ToolCalls, call)
		case contracts.KindThinking:
			response.Lossy = append(response.Lossy, lossyNote("response", "",
				contracts.ProtocolOpenAIChat, thinkingLossyField(part), "dropped", "OpenAI Chat 不支持 thinking"))
		default:
			response.Lossy = append(response.Lossy, lossyNote("response", "",
				contracts.ProtocolOpenAIChat, string(part.Kind), "dropped", "OpenAI Chat 无法表示"))
		}
	}
	if text.Len() > 0 {
		message.Content = mustRaw(text.String())
	}
	wire.Choices = append(wire.Choices, struct {
		Index        int             `json:"index"`
		Message      chatWireMessage `json:"message"`
		FinishReason string          `json:"finish_reason"`
	}{Index: 0, Message: message, FinishReason: stopToChatFinish(response.Stop)})
	wire.Usage = usageToWire(response.Usage)
	return json.Marshal(wire)
}

func usageFromWire(usage *chatWireUsage) contracts.Usage {
	if usage == nil {
		return contracts.Usage{}
	}
	out := contracts.Usage{
		InputTokens:  usage.PromptTokens,
		OutputTokens: usage.CompletionTokens,
		Raw: map[string]int{
			"prompt_tokens":     usage.PromptTokens,
			"completion_tokens": usage.CompletionTokens,
		},
	}
	if usage.CompletionTokensDetails != nil {
		out.ReasoningTokens = usage.CompletionTokensDetails.ReasoningTokens
	}
	if usage.PromptTokensDetails != nil {
		out.CacheReadInputTokens = usage.PromptTokensDetails.CachedTokens
	}
	return out
}

func usageToWire(usage contracts.Usage) *chatWireUsage {
	wire := &chatWireUsage{
		PromptTokens:     usage.InputTokens,
		CompletionTokens: usage.OutputTokens,
		TotalTokens:      usage.InputTokens + usage.OutputTokens,
	}
	if usage.ReasoningTokens != 0 {
		wire.CompletionTokensDetails = &struct {
			ReasoningTokens int `json:"reasoning_tokens"`
		}{ReasoningTokens: usage.ReasoningTokens}
	}
	if usage.CacheReadInputTokens != 0 {
		wire.PromptTokensDetails = &struct {
			CachedTokens int `json:"cached_tokens"`
		}{CachedTokens: usage.CacheReadInputTokens}
	}
	return wire
}

// ---------------------------------------------------------------------------
// 枚举互译
// ---------------------------------------------------------------------------

func chatFinishToStop(finish string) contracts.StopReason {
	switch finish {
	case "stop":
		return contracts.StopEndTurn
	case "length":
		return contracts.StopMaxTokens
	case "tool_calls", "function_call":
		return contracts.StopToolUse
	case "content_filter":
		return contracts.StopContentFilter
	case "":
		return contracts.StopUnknown
	default:
		return contracts.StopUnknown
	}
}

func stopToChatFinish(stop contracts.StopReason) string {
	switch stop {
	case contracts.StopEndTurn, contracts.StopSequence:
		return "stop"
	case contracts.StopMaxTokens:
		return "length"
	case contracts.StopToolUse:
		return "tool_calls"
	case contracts.StopContentFilter:
		return "content_filter"
	default:
		return "stop"
	}
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

func parseStop(raw json.RawMessage) []string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	if trimmed[0] == '"' {
		var single string
		if json.Unmarshal(trimmed, &single) == nil && single != "" {
			return []string{single}
		}
		return nil
	}
	var list []string
	if json.Unmarshal(trimmed, &list) == nil {
		return list
	}
	return nil
}

func parseToolChoice(raw json.RawMessage) *contracts.ToolChoice {
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
		Type     string `json:"type"`
		Function struct {
			Name string `json:"name"`
		} `json:"function"`
	}
	if json.Unmarshal(trimmed, &object) != nil {
		return nil
	}
	if object.Type == "function" {
		return &contracts.ToolChoice{Mode: contracts.ToolChoiceTool, Name: object.Function.Name}
	}
	return nil
}

func renderToolChoice(choice *contracts.ToolChoice) json.RawMessage {
	switch choice.Mode {
	case contracts.ToolChoiceNone:
		return mustRaw("none")
	case contracts.ToolChoiceRequired:
		return mustRaw("required")
	case contracts.ToolChoiceTool:
		return mustRaw(map[string]any{
			"type":     "function",
			"function": map[string]string{"name": choice.Name},
		})
	default:
		return mustRaw("auto")
	}
}

func parseResponseFormat(raw json.RawMessage) *contracts.ResponseFormat {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	var object struct {
		Type       string          `json:"type"`
		JSONSchema json.RawMessage `json:"json_schema"`
	}
	if json.Unmarshal(trimmed, &object) != nil || object.Type == "" {
		return nil
	}
	return &contracts.ResponseFormat{Type: object.Type, JSONSchema: object.JSONSchema}
}

func renderResponseFormat(format *contracts.ResponseFormat) json.RawMessage {
	object := map[string]any{"type": format.Type}
	if len(format.JSONSchema) > 0 {
		object["json_schema"] = format.JSONSchema
	}
	return mustRaw(object)
}

func partsText(parts []contracts.Part) string {
	var builder strings.Builder
	for _, part := range parts {
		if part.Kind == contracts.KindText {
			builder.WriteString(part.Text)
		}
	}
	return builder.String()
}

func extrasOf(raw map[string]json.RawMessage, known map[string]struct{}) map[string]json.RawMessage {
	var out map[string]json.RawMessage
	for key, value := range raw {
		if _, ok := known[key]; ok {
			continue
		}
		if out == nil {
			out = make(map[string]json.RawMessage)
		}
		out[key] = value
	}
	return out
}

func lossyNote(direction string, from, to contracts.Protocol, field, action, detail string) contracts.LossyNote {
	return contracts.LossyNote{
		Direction: direction,
		From:      from,
		To:        to,
		Field:     field,
		Action:    action,
		Detail:    detail,
	}
}

// mustRaw 把任意值序列化成 json.RawMessage。失败时返回 null（不会发生）。
func mustRaw(value any) json.RawMessage {
	payload, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return payload
}
