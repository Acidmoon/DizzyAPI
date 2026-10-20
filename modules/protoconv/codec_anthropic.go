package protoconv

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// anthropicCodec 是 Anthropic Messages 协议的完整 codec。
//
// 线上格式依据 Anthropic 官方文档核实（2026-10 复核）：
//   - 请求 POST /v1/messages：https://platform.claude.com/docs/en/api/messages
//     body 必填 model / max_tokens / messages；system 是字符串或 TextBlockParam 数组；
//     messages[].content 是字符串或块数组（text / image / tool_use / tool_result /
//     thinking / redacted_thinking）；tools[] 是 {name, description, input_schema}；
//     tool_choice 是 {type:"auto"|"any"|"tool"|"none", name?}；另有 temperature / top_p /
//     top_k / stop_sequences / stream / thinking / metadata。
//   - 响应 {id, type:"message", role:"assistant", model, content:[...], stop_reason,
//     stop_sequence, usage:{input_tokens, output_tokens, cache_creation_input_tokens,
//     cache_read_input_tokens}}。
//   - 流式：https://platform.claude.com/docs/en/build-with-claude/streaming
//     event: <name>\ndata: {...}；序列 message_start → (content_block_start →
//     content_block_delta* → content_block_stop)* → message_delta → message_stop，
//     另有 ping / error。content_block_delta.delta.type ∈ {text_delta,
//     input_json_delta, thinking_delta, signature_delta}。
//
// 与官方文档核实的、和任务描述不同的点：
//   - stop_reason 实际有 7 个值（多出 model_context_window_exceeded）；
//   - tool_choice 还有 {type:"none"}；
//   - thinking 块（含 signature）在非 Anthropic 协议里无法表达，渲染过去时丢签名并记 note。
type anthropicCodec struct {
	defaultMaxTokens int
}

// anthropicDefaultMaxTokens 是 max_tokens 缺失时的默认值。
const anthropicDefaultMaxTokens = 4096

// AnthropicConfig 是 Anthropic codec 的运行参数。
type AnthropicConfig struct {
	// DefaultMaxTokens 在客户端未提供 max_tokens 时补齐；<=0 时用 4096。
	DefaultMaxTokens int
}

// NewAnthropicCodec 返回 Anthropic Messages codec。
func NewAnthropicCodec(cfg AnthropicConfig) contracts.Codec {
	if cfg.DefaultMaxTokens <= 0 {
		cfg.DefaultMaxTokens = anthropicDefaultMaxTokens
	}
	return anthropicCodec{defaultMaxTokens: cfg.DefaultMaxTokens}
}

func (anthropicCodec) Protocol() contracts.Protocol { return contracts.ProtocolAnthropic }

// anthropicKnownKeys 是 IR 已建模的顶层请求字段；其余进 Request.Extras。
var anthropicKnownKeys = map[string]struct{}{
	"model": {}, "max_tokens": {}, "system": {}, "messages": {}, "tools": {},
	"tool_choice": {}, "temperature": {}, "top_p": {}, "top_k": {},
	"stop_sequences": {}, "stream": {}, "metadata": {}, "thinking": {},
}

// ---------------------------------------------------------------------------
// 请求：线格式
// ---------------------------------------------------------------------------

type anthropicWireRequest struct {
	Model         string                 `json:"model"`
	MaxTokens     *int                   `json:"max_tokens"`
	System        json.RawMessage        `json:"system,omitempty"`
	Messages      []anthropicWireMessage `json:"messages"`
	Tools         []anthropicWireTool    `json:"tools,omitempty"`
	ToolChoice    json.RawMessage        `json:"tool_choice,omitempty"`
	Temperature   *float64               `json:"temperature,omitempty"`
	TopP          *float64               `json:"top_p,omitempty"`
	TopK          *int                   `json:"top_k,omitempty"`
	StopSequences []string               `json:"stop_sequences,omitempty"`
	Stream        bool                   `json:"stream,omitempty"`
	Metadata      json.RawMessage        `json:"metadata,omitempty"`
	Thinking      json.RawMessage        `json:"thinking,omitempty"`
}

type anthropicWireMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type anthropicWireTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"input_schema"`
	Strict      *bool           `json:"strict,omitempty"`
}

// anthropicWireBlock 覆盖请求 / 响应里出现的所有块形状。
type anthropicWireBlock struct {
	Type string `json:"type"`

	// text
	Text string `json:"text"`

	// image
	Source *anthropicWireImageSource `json:"source,omitempty"`

	// tool_use
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`

	// tool_result
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`

	// thinking / redacted_thinking
	Thinking  string `json:"thinking"`
	Signature string `json:"signature"`
	Data      string `json:"data"`

	// 透传字段（Anthropic 专有）：解析时保留，渲染回 Anthropic 时原样带回。
	CacheControl json.RawMessage `json:"cache_control"`
	Citations    json.RawMessage `json:"citations"`
}

type anthropicWireImageSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
	URL       string `json:"url"`
}

// ParseRequest 把 Anthropic Messages 请求体解析成 IR。
func (anthropicCodec) ParseRequest(body []byte) (*contracts.Request, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("anthropic: 请求体不是 JSON 对象: %w", err)
	}
	var wire anthropicWireRequest
	if err := json.Unmarshal(body, &wire); err != nil {
		return nil, fmt.Errorf("anthropic: 请求体字段不合法: %w", err)
	}

	request := &contracts.Request{
		Model:     wire.Model,
		Stream:    wire.Stream,
		MaxTokens: wire.MaxTokens,
	}
	request.Sampling.Temperature = wire.Temperature
	request.Sampling.TopP = wire.TopP
	request.Sampling.TopK = wire.TopK
	request.Sampling.Stop = wire.StopSequences

	request.System = parseAnthropicSystem(wire.System)
	request.User = parseAnthropicUser(wire.Metadata)

	for _, message := range wire.Messages {
		role := contracts.RoleUser
		switch message.Role {
		case "assistant":
			role = contracts.RoleAssistant
		case "user", "":
			role = contracts.RoleUser
		default:
			request.Lossy = append(request.Lossy, lossyNote("request",
				contracts.ProtocolAnthropic, "", "messages[].role", "coerced", "未知角色按 user 处理"))
		}
		request.Messages = append(request.Messages, contracts.Message{
			Role:  role,
			Parts: parseAnthropicContent(message.Content, request),
		})
	}

	for _, tool := range wire.Tools {
		strict := false
		if tool.Strict != nil {
			strict = *tool.Strict
		}
		request.Tools = append(request.Tools, contracts.Tool{
			Name:        tool.Name,
			Description: tool.Description,
			InputSchema: tool.InputSchema,
			Strict:      strict,
		})
	}
	request.ToolChoice = parseAnthropicToolChoice(wire.ToolChoice)
	request.Extras = extrasOf(raw, anthropicKnownKeys)
	// thinking 配置是 Anthropic 专有：收进 Extras，跨协议渲染时会被丢弃并记 note。
	if len(bytes.TrimSpace(wire.Thinking)) > 0 {
		if request.Extras == nil {
			request.Extras = make(map[string]json.RawMessage)
		}
		request.Extras["thinking"] = wire.Thinking
	}
	return request, nil
}

// parseAnthropicSystem 解析 system（字符串或 TextBlockParam 数组）。
func parseAnthropicSystem(raw json.RawMessage) []contracts.Part {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	if trimmed[0] == '"' {
		var text string
		if json.Unmarshal(trimmed, &text) != nil || text == "" {
			return nil
		}
		return []contracts.Part{{Kind: contracts.KindText, Text: text}}
	}
	var blocks []anthropicWireBlock
	if json.Unmarshal(trimmed, &blocks) != nil {
		return nil
	}
	parts := make([]contracts.Part, 0, len(blocks))
	for _, block := range blocks {
		if block.Type != "" && block.Type != "text" {
			parts = append(parts, contracts.Part{Kind: contracts.KindUnknown, Raw: mustRaw(block)})
			continue
		}
		parts = append(parts, contracts.Part{
			Kind: contracts.KindText,
			Text: block.Text,
			Raw:  keepAnthropicExtras(block),
		})
	}
	return parts
}

// parseAnthropicContent 解析 messages[].content（字符串或块数组）。
func parseAnthropicContent(raw json.RawMessage, request *contracts.Request) []contracts.Part {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	if trimmed[0] == '"' {
		var text string
		if json.Unmarshal(trimmed, &text) != nil || text == "" {
			return nil
		}
		return []contracts.Part{{Kind: contracts.KindText, Text: text}}
	}
	var blocks []anthropicWireBlock
	if json.Unmarshal(trimmed, &blocks) != nil {
		return nil
	}
	parts := make([]contracts.Part, 0, len(blocks))
	for _, block := range blocks {
		parts = append(parts, parseAnthropicBlock(block, request))
	}
	return parts
}

func parseAnthropicBlock(block anthropicWireBlock, request *contracts.Request) contracts.Part {
	switch block.Type {
	case "text":
		return contracts.Part{Kind: contracts.KindText, Text: block.Text, Raw: keepAnthropicExtras(block)}
	case "image":
		if block.Source == nil {
			return contracts.Part{Kind: contracts.KindUnknown, Raw: mustRaw(block)}
		}
		switch block.Source.Type {
		case "base64":
			return contracts.Part{
				Kind:      contracts.KindImage,
				MediaType: block.Source.MediaType,
				ImageURL:  "data:" + block.Source.MediaType + ";base64," + block.Source.Data,
				Raw:       keepAnthropicExtras(block),
			}
		case "url":
			return contracts.Part{Kind: contracts.KindImage, ImageURL: block.Source.URL, Raw: keepAnthropicExtras(block)}
		default:
			// file / 其他来源：原样保留，无法归入 IR 图片语义。
			return contracts.Part{Kind: contracts.KindUnknown, Raw: mustRaw(block)}
		}
	case "tool_use":
		// 解析时反查：把网关改写过的 id 还原成客户端原始 id（可逆，多轮不串号）。
		part := contracts.Part{
			Kind:       contracts.KindToolUse,
			ToolCallID: anthropicInID(block.ID),
			ToolName:   block.Name,
			Raw:        keepAnthropicExtras(block),
		}
		if len(bytes.TrimSpace(block.Input)) > 0 {
			part.ToolInput = block.Input
		}
		return part
	case "tool_result":
		text, dropped := toolResultText(block.Content)
		if dropped && request != nil {
			request.Lossy = append(request.Lossy, lossyNote("request",
				contracts.ProtocolAnthropic, "", "tool_result.content", "dropped", "只保留文本块"))
		}
		return contracts.Part{
			Kind:          contracts.KindToolResult,
			ToolResultFor: anthropicInID(block.ToolUseID),
			Text:          text,
			IsError:       block.IsError,
			Raw:           keepAnthropicExtras(block),
		}
	case "thinking":
		return contracts.Part{Kind: contracts.KindThinking, Text: block.Thinking, Signature: block.Signature}
	case "redacted_thinking":
		return contracts.Part{Kind: contracts.KindThinking, Redacted: true, Text: block.Data}
	default:
		// 无法归类的块原样保留（含 server_tool_use 等）。
		return contracts.Part{Kind: contracts.KindUnknown, Raw: mustRaw(block)}
	}
}

// toolResultText 把 tool_result 的 content（字符串或块数组）压成文本；
// 第二个返回值表示是否丢弃了非文本块。
func toolResultText(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return "", false
	}
	if trimmed[0] == '"' {
		var text string
		if json.Unmarshal(trimmed, &text) != nil {
			return "", false
		}
		return text, false
	}
	var blocks []anthropicWireBlock
	if json.Unmarshal(trimmed, &blocks) != nil {
		return "", false
	}
	var builder strings.Builder
	dropped := false
	for _, block := range blocks {
		if block.Type == "text" || block.Type == "" {
			builder.WriteString(block.Text)
			continue
		}
		dropped = true
	}
	return builder.String(), dropped
}

// parseAnthropicUser 从 metadata.user_id 提取用户标识。
func parseAnthropicUser(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return ""
	}
	var metadata struct {
		UserID string `json:"user_id"`
	}
	if json.Unmarshal(trimmed, &metadata) != nil {
		return ""
	}
	return metadata.UserID
}

// ---------------------------------------------------------------------------
// 请求：渲染
// ---------------------------------------------------------------------------

// RenderRequest 把 IR 渲染成 Anthropic Messages 请求体。
func (c anthropicCodec) RenderRequest(request *contracts.Request) ([]byte, error) {
	if request == nil {
		return nil, errors.New("anthropic: 请求为空")
	}
	// Anthropic 不支持多候选：明确失败（上层映射 400 PROTOCOL_CONVERT_FAILED），不静默取第一个。
	if request.Sampling.N != nil && *request.Sampling.N > 1 {
		return nil, fmt.Errorf("anthropic: 不支持 n>1 的多候选")
	}

	wire := anthropicWireRequest{
		Model:  request.Model,
		Stream: request.Stream,
	}

	// max_tokens 必填：缺失时补默认值并记 note。
	if request.MaxTokens != nil {
		wire.MaxTokens = request.MaxTokens
	} else {
		fallback := c.defaultMaxTokens
		wire.MaxTokens = &fallback
		request.Lossy = append(request.Lossy, lossyNote("request", "",
			contracts.ProtocolAnthropic, "max_tokens", "defaulted", "客户端未提供，按默认值补齐"))
	}

	wire.System = renderAnthropicSystem(request)
	wire.Messages = c.renderAnthropicMessages(request)

	for _, tool := range request.Tools {
		schema := tool.InputSchema
		if len(bytes.TrimSpace(schema)) == 0 {
			schema = json.RawMessage(`{"type":"object"}`)
		}
		wireTool := anthropicWireTool{Name: tool.Name, Description: tool.Description, InputSchema: schema}
		if tool.Strict {
			strict := true
			wireTool.Strict = &strict
		}
		wire.Tools = append(wire.Tools, wireTool)
	}

	wire.ToolChoice = renderAnthropicToolChoice(request.ToolChoice)
	wire.Temperature = request.Sampling.Temperature
	wire.TopP = request.Sampling.TopP
	wire.TopK = request.Sampling.TopK
	wire.StopSequences = request.Sampling.Stop
	if request.User != "" {
		wire.Metadata = mustRaw(map[string]any{"user_id": request.User})
	}

	dropOpenAIOnlyForAnthropic(request)

	for key := range request.Extras {
		request.Lossy = append(request.Lossy, lossyNote("request", "",
			contracts.ProtocolAnthropic, "extras."+key, "dropped", "Anthropic 无法表示"))
	}
	return json.Marshal(wire)
}

// dropOpenAIOnlyForAnthropic 记录 OpenAI 专有字段渲染到 Anthropic 时的丢弃。
func dropOpenAIOnlyForAnthropic(request *contracts.Request) {
	note := func(field string) {
		request.Lossy = append(request.Lossy, lossyNote("request", "",
			contracts.ProtocolAnthropic, field, "dropped", "Anthropic 不支持该 OpenAI 字段"))
	}
	if request.Sampling.Logprobs != nil {
		note("logprobs")
	}
	if request.Sampling.TopLogprobs != nil {
		note("top_logprobs")
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
	if request.ResponseFormat != nil {
		note("response_format")
	}
}

// renderAnthropicSystem 渲染 system（单条纯文本用字符串，其余用块数组）。
func renderAnthropicSystem(request *contracts.Request) json.RawMessage {
	if len(request.System) == 0 {
		return nil
	}
	if len(request.System) == 1 && request.System[0].Kind == contracts.KindText && len(request.System[0].Raw) == 0 {
		return mustRaw(request.System[0].Text)
	}
	var blocks []map[string]any
	for _, part := range request.System {
		if part.Kind != contracts.KindText {
			request.Lossy = append(request.Lossy, lossyNote("request", "",
				contracts.ProtocolAnthropic, "system", "dropped", "system 只保留文本块"))
			continue
		}
		block := map[string]any{"type": "text", "text": part.Text}
		overlayAnthropicExtras(block, part.Raw)
		blocks = append(blocks, block)
	}
	if len(blocks) == 0 {
		return nil
	}
	return mustRaw(blocks)
}

// renderAnthropicMessages 渲染 messages，并做 tool_use / tool_result 配对修补。
func (c anthropicCodec) renderAnthropicMessages(request *contracts.Request) []anthropicWireMessage {
	add := func(note contracts.LossyNote) { request.Lossy = append(request.Lossy, note) }

	var rendered []anthropicWireMessage
	var blocksList [][]map[string]any
	for _, message := range request.Messages {
		role := "user"
		switch message.Role {
		case contracts.RoleAssistant:
			role = "assistant"
		case contracts.RoleTool:
			role = "user" // tool_result 属于 user 回合
		case contracts.RoleUser, contracts.RoleSystem:
		default:
			add(lossyNote("request", "", contracts.ProtocolAnthropic, "messages[].role", "coerced", "未知角色按 user 处理"))
		}
		blocks := renderAnthropicBlocks(message.Parts, add)
		if len(blocks) == 0 {
			continue
		}
		// 合并相邻的 user 回合（tool_result 需要与上一个 assistant 回合紧邻）。
		if role == "user" && len(rendered) > 0 && rendered[len(rendered)-1].Role == "user" && allToolResults(blocks) {
			blocksList[len(blocksList)-1] = append(blocksList[len(blocksList)-1], blocks...)
			continue
		}
		rendered = append(rendered, anthropicWireMessage{Role: role})
		blocksList = append(blocksList, blocks)
	}

	rendered, blocksList = repairToolPairing(rendered, blocksList, add)

	messages := make([]anthropicWireMessage, 0, len(rendered))
	for index, message := range rendered {
		if len(blocksList[index]) == 0 {
			continue
		}
		messages = append(messages, anthropicWireMessage{Role: message.Role, Content: mustRaw(blocksList[index])})
	}
	return messages
}

// renderAnthropicBlocks 把一个 IR 消息的片段渲染成 Anthropic 内容块。
func renderAnthropicBlocks(parts []contracts.Part, add func(contracts.LossyNote)) []map[string]any {
	var blocks []map[string]any
	for _, part := range parts {
		switch part.Kind {
		case contracts.KindText:
			block := map[string]any{"type": "text", "text": part.Text}
			overlayAnthropicExtras(block, part.Raw)
			blocks = append(blocks, block)
		case contracts.KindImage:
			if block, ok := renderAnthropicImage(part); ok {
				blocks = append(blocks, block)
			} else {
				add(lossyNote("request", "", contracts.ProtocolAnthropic, "image", "dropped", "无法解析的图片来源"))
			}
		case contracts.KindToolUse:
			block := map[string]any{
				"type":  "tool_use",
				"id":    anthropicOutID(part.ToolCallID),
				"name":  part.ToolName,
				"input": toolInputOrDefault(part.ToolInput),
			}
			overlayAnthropicExtras(block, part.Raw)
			blocks = append(blocks, block)
		case contracts.KindToolResult:
			block := map[string]any{
				"type":        "tool_result",
				"tool_use_id": anthropicOutID(part.ToolResultFor),
				"content":     part.Text,
			}
			if part.IsError {
				block["is_error"] = true
			}
			overlayAnthropicExtras(block, part.Raw)
			blocks = append(blocks, block)
		case contracts.KindThinking:
			if part.Redacted {
				blocks = append(blocks, map[string]any{"type": "redacted_thinking", "data": part.Text})
			} else {
				blocks = append(blocks, map[string]any{
					"type": "thinking", "thinking": part.Text, "signature": part.Signature,
				})
			}
		default:
			var passthrough map[string]any
			if len(bytes.TrimSpace(part.Raw)) > 0 && json.Unmarshal(part.Raw, &passthrough) == nil {
				blocks = append(blocks, passthrough)
			} else {
				add(lossyNote("request", "", contracts.ProtocolAnthropic, string(part.Kind), "dropped", "Anthropic 无法表示"))
			}
		}
	}
	return blocks
}

// renderAnthropicImage 把 IR 图片渲染成 Anthropic 图片块。
func renderAnthropicImage(part contracts.Part) (map[string]any, bool) {
	url := part.ImageURL
	switch {
	case strings.HasPrefix(url, "data:"):
		rest := strings.TrimPrefix(url, "data:")
		mediaType, data, ok := strings.Cut(rest, ";base64,")
		if !ok {
			return nil, false
		}
		block := map[string]any{
			"type":   "image",
			"source": map[string]any{"type": "base64", "media_type": mediaType, "data": data},
		}
		overlayAnthropicExtras(block, part.Raw)
		return block, true
	case strings.HasPrefix(url, "http://"), strings.HasPrefix(url, "https://"):
		block := map[string]any{
			"type":   "image",
			"source": map[string]any{"type": "url", "url": url},
		}
		overlayAnthropicExtras(block, part.Raw)
		return block, true
	default:
		return nil, false
	}
}

// toolInputOrDefault 渲染 tool_use.input；空则给空对象（Anthropic 要求 input 是对象）。
func toolInputOrDefault(input json.RawMessage) json.RawMessage {
	if len(bytes.TrimSpace(input)) == 0 {
		return json.RawMessage(`{}`)
	}
	return input
}

// ---------------------------------------------------------------------------
// tool_use / tool_result 配对修补
// ---------------------------------------------------------------------------

// repairToolPairing 保证每个 assistant tool_use 都有紧邻的 user tool_result，
// 并把 tool_result 块排到所属 user 回合的最前；孤儿 tool_result 会被丢弃。
// 每一次修补都记一条 LossyNote{Action:"coerced"}。
func repairToolPairing(messages []anthropicWireMessage, blocksList [][]map[string]any, add func(contracts.LossyNote)) ([]anthropicWireMessage, [][]map[string]any) {
	// 第一遍：丢弃孤儿 tool_result（其 tool_use_id 不在上一个 assistant 回合里）。
	for index := range messages {
		if messages[index].Role != "user" {
			continue
		}
		allowed := map[string]struct{}{}
		if index > 0 && messages[index-1].Role == "assistant" {
			for _, id := range toolUseIDs(blocksList[index-1]) {
				allowed[id] = struct{}{}
			}
		}
		kept := make([]map[string]any, 0, len(blocksList[index]))
		for _, block := range blocksList[index] {
			if blockType(block) == "tool_result" {
				if _, ok := allowed[blockToolUseID(block)]; !ok {
					add(lossyNote("request", "", contracts.ProtocolAnthropic, "tool_result", "coerced", "丢弃没有对应 tool_use 的结果块"))
					continue
				}
			}
			kept = append(kept, block)
		}
		blocksList[index] = toolResultsFirst(kept)
	}

	// 第二遍：为缺失结果的 tool_use 补占位结果。
	for index := 0; index < len(messages); index++ {
		if messages[index].Role != "assistant" {
			continue
		}
		ids := toolUseIDs(blocksList[index])
		if len(ids) == 0 {
			continue
		}
		have := map[string]struct{}{}
		nextIsUser := index+1 < len(messages) && messages[index+1].Role == "user"
		if nextIsUser {
			for _, id := range toolResultIDs(blocksList[index+1]) {
				have[id] = struct{}{}
			}
		}
		var missing []string
		for _, id := range ids {
			if _, ok := have[id]; !ok {
				missing = append(missing, id)
			}
		}
		if len(missing) == 0 {
			continue
		}
		var synthetic []map[string]any
		for _, id := range missing {
			synthetic = append(synthetic, map[string]any{
				"type":        "tool_result",
				"tool_use_id": id,
				"content":     "工具结果缺失（网关补齐占位）",
				"is_error":    true,
			})
			add(lossyNote("request", "", contracts.ProtocolAnthropic, "tool_result", "coerced", "为 tool_use 补齐占位结果"))
		}
		if nextIsUser {
			blocksList[index+1] = toolResultsFirst(append(synthetic, blocksList[index+1]...))
			continue
		}
		// 插入一个新的 user 回合承载占位结果。
		messages = insertAnthropicMessage(messages, index+1, anthropicWireMessage{Role: "user"})
		blocksList = insertAnthropicBlocks(blocksList, index+1, synthetic)
	}
	return messages, blocksList
}

func insertAnthropicMessage(list []anthropicWireMessage, at int, value anthropicWireMessage) []anthropicWireMessage {
	list = append(list, anthropicWireMessage{})
	copy(list[at+1:], list[at:])
	list[at] = value
	return list
}

func insertAnthropicBlocks(list [][]map[string]any, at int, value []map[string]any) [][]map[string]any {
	list = append(list, nil)
	copy(list[at+1:], list[at:])
	list[at] = value
	return list
}

func toolUseIDs(blocks []map[string]any) []string {
	var ids []string
	for _, block := range blocks {
		if blockType(block) == "tool_use" {
			if id := stringOf(block["id"]); id != "" {
				ids = append(ids, id)
			}
		}
	}
	return ids
}

func toolResultIDs(blocks []map[string]any) []string {
	var ids []string
	for _, block := range blocks {
		if blockType(block) == "tool_result" {
			if id := blockToolUseID(block); id != "" {
				ids = append(ids, id)
			}
		}
	}
	return ids
}

func allToolResults(blocks []map[string]any) bool {
	if len(blocks) == 0 {
		return false
	}
	for _, block := range blocks {
		if blockType(block) != "tool_result" {
			return false
		}
	}
	return true
}

// toolResultsFirst 稳定地把 tool_result 块排到最前（Anthropic 要求结果块在 user 回合首位）。
func toolResultsFirst(blocks []map[string]any) []map[string]any {
	results := make([]map[string]any, 0, len(blocks))
	others := make([]map[string]any, 0, len(blocks))
	for _, block := range blocks {
		if blockType(block) == "tool_result" {
			results = append(results, block)
		} else {
			others = append(others, block)
		}
	}
	return append(results, others...)
}

func blockType(block map[string]any) string      { return stringOf(block["type"]) }
func blockToolUseID(block map[string]any) string { return stringOf(block["tool_use_id"]) }

func stringOf(value any) string {
	text, _ := value.(string)
	return text
}

// ---------------------------------------------------------------------------
// 响应：线格式
// ---------------------------------------------------------------------------

type anthropicWireUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens,omitempty"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens,omitempty"`
	OutputTokensDetails      *struct {
		ThinkingTokens int `json:"thinking_tokens"`
	} `json:"output_tokens_details,omitempty"`
}

type anthropicWireResponse struct {
	ID           string              `json:"id"`
	Type         string              `json:"type"`
	Role         string              `json:"role"`
	Model        string              `json:"model"`
	Content      json.RawMessage     `json:"content"`
	StopReason   string              `json:"stop_reason"`
	StopSequence *string             `json:"stop_sequence"`
	Usage        *anthropicWireUsage `json:"usage"`
}

// ParseResponse 把 Anthropic Messages 响应体解析成 IR。
func (anthropicCodec) ParseResponse(body []byte) (*contracts.Response, error) {
	var wire anthropicWireResponse
	if err := json.Unmarshal(body, &wire); err != nil {
		return nil, fmt.Errorf("anthropic: 响应体不是 JSON: %w", err)
	}
	response := &contracts.Response{ID: wire.ID, Model: wire.Model}
	var holder contracts.Request // 仅用于承载解析期的 LossyNote
	response.Parts = parseAnthropicContent(wire.Content, &holder)
	response.Lossy = append(response.Lossy, holder.Lossy...)
	response.Stop = anthropicStopToIR(wire.StopReason, func(note contracts.LossyNote) {
		response.Lossy = append(response.Lossy, note)
	})
	response.Usage = anthropicUsageFromWire(wire.Usage)
	return response, nil
}

// RenderResponse 把 IR 渲染成 Anthropic Messages 响应体。
func (anthropicCodec) RenderResponse(response *contracts.Response) ([]byte, error) {
	if response == nil {
		return nil, errors.New("anthropic: 响应为空")
	}
	add := func(note contracts.LossyNote) { response.Lossy = append(response.Lossy, note) }
	blocks := renderAnthropicBlocks(response.Parts, add)
	if blocks == nil {
		blocks = []map[string]any{}
	}
	wire := map[string]any{
		"id":            response.ID,
		"type":          "message",
		"role":          "assistant",
		"model":         response.Model,
		"content":       blocks,
		"stop_reason":   irStopToAnthropic(response.Stop),
		"stop_sequence": nil,
	}
	if usage := anthropicUsageToWire(response.Usage); usage != nil {
		wire["usage"] = usage
	}
	return json.Marshal(wire)
}

func anthropicUsageFromWire(usage *anthropicWireUsage) contracts.Usage {
	if usage == nil {
		return contracts.Usage{}
	}
	out := contracts.Usage{
		InputTokens:              usage.InputTokens,
		OutputTokens:             usage.OutputTokens,
		CacheCreationInputTokens: usage.CacheCreationInputTokens,
		CacheReadInputTokens:     usage.CacheReadInputTokens,
		Raw: map[string]int{
			"input_tokens":                usage.InputTokens,
			"output_tokens":               usage.OutputTokens,
			"cache_creation_input_tokens": usage.CacheCreationInputTokens,
			"cache_read_input_tokens":     usage.CacheReadInputTokens,
		},
	}
	if usage.OutputTokensDetails != nil {
		out.ReasoningTokens = usage.OutputTokensDetails.ThinkingTokens
	}
	return out
}

func anthropicUsageToWire(usage contracts.Usage) map[string]any {
	wire := map[string]any{
		"input_tokens":  usage.InputTokens,
		"output_tokens": usage.OutputTokens,
	}
	if usage.CacheCreationInputTokens != 0 {
		wire["cache_creation_input_tokens"] = usage.CacheCreationInputTokens
	}
	if usage.CacheReadInputTokens != 0 {
		wire["cache_read_input_tokens"] = usage.CacheReadInputTokens
	}
	return wire
}

// ---------------------------------------------------------------------------
// 枚举互译
// ---------------------------------------------------------------------------

// anthropicStopToIR 把 Anthropic stop_reason 翻成 IR；无法一一对应的值记 note。
func anthropicStopToIR(reason string, add func(contracts.LossyNote)) contracts.StopReason {
	switch reason {
	case "end_turn":
		return contracts.StopEndTurn
	case "max_tokens":
		return contracts.StopMaxTokens
	case "stop_sequence":
		return contracts.StopSequence
	case "tool_use":
		return contracts.StopToolUse
	case "model_context_window_exceeded":
		// 文档新增值：语义上属于长度耗尽，按 max_tokens 处理。
		if add != nil {
			add(lossyNote("response", contracts.ProtocolAnthropic, "", "stop_reason", "mapped", "model_context_window_exceeded 按 max_tokens 处理"))
		}
		return contracts.StopMaxTokens
	case "refusal", "pause_turn":
		if add != nil {
			add(lossyNote("response", contracts.ProtocolAnthropic, "", "stop_reason", "mapped", reason+" 归为 unknown"))
		}
		return contracts.StopUnknown
	case "":
		return contracts.StopUnknown
	default:
		if add != nil {
			add(lossyNote("response", contracts.ProtocolAnthropic, "", "stop_reason", "mapped", "未知 stop_reason 归为 unknown"))
		}
		return contracts.StopUnknown
	}
}

// irStopToAnthropic 把 IR StopReason 翻成 Anthropic stop_reason。
func irStopToAnthropic(stop contracts.StopReason) string {
	switch stop {
	case contracts.StopEndTurn:
		return "end_turn"
	case contracts.StopMaxTokens:
		return "max_tokens"
	case contracts.StopToolUse:
		return "tool_use"
	case contracts.StopSequence:
		return "stop_sequence"
	default:
		return "end_turn"
	}
}

// ---------------------------------------------------------------------------
// tool_choice 互译
// ---------------------------------------------------------------------------

func parseAnthropicToolChoice(raw json.RawMessage) *contracts.ToolChoice {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	var object struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if json.Unmarshal(trimmed, &object) != nil {
		return nil
	}
	switch object.Type {
	case "auto":
		return &contracts.ToolChoice{Mode: contracts.ToolChoiceAuto}
	case "any":
		return &contracts.ToolChoice{Mode: contracts.ToolChoiceRequired}
	case "none":
		return &contracts.ToolChoice{Mode: contracts.ToolChoiceNone}
	case "tool":
		return &contracts.ToolChoice{Mode: contracts.ToolChoiceTool, Name: object.Name}
	default:
		return nil
	}
}

func renderAnthropicToolChoice(choice *contracts.ToolChoice) json.RawMessage {
	if choice == nil {
		return nil
	}
	switch choice.Mode {
	case contracts.ToolChoiceRequired:
		return mustRaw(map[string]any{"type": "any"})
	case contracts.ToolChoiceNone:
		return mustRaw(map[string]any{"type": "none"})
	case contracts.ToolChoiceTool:
		return mustRaw(map[string]any{"type": "tool", "name": choice.Name})
	default:
		return mustRaw(map[string]any{"type": "auto"})
	}
}

// ---------------------------------------------------------------------------
// 工具调用 id 双向映射（可逆、无状态，参考 magpie 的 safeCallID / rawCallID）
// ---------------------------------------------------------------------------

// anthropicToolIDMark 是网关改写 id 的标记前缀。
//
// Anthropic 的 tool_use.id / tool_result.tool_use_id 必须匹配 ^[a-zA-Z0-9_-]+$
// （官方文档：tool_use.id pattern）。跨协议时用一个不会被 Anthropic 原生 id
// 占用的前缀（原生 id 以 toolu_ 开头）做标记，保证可逆且不串号。
const anthropicToolIDMark = "dz_"

var anthropicSafeID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// anthropicOutID 把 IR 里的工具调用 id 渲染到 Anthropic 线格式。
func anthropicOutID(id string) string { return safeCallID(anthropicToolIDMark, id) }

// anthropicInID 把 Anthropic 线格式的工具调用 id 还原成 IR 里的原始 id。
func anthropicInID(id string) string { return rawCallID(anthropicToolIDMark, id) }

// safeCallID 把 id 变成只含 [A-Za-z0-9_-] 的字符串：已经安全的原样返回；
// 否则用「标记前缀 + base64url(id)」。它不保存任何状态，重启后同一 id 仍还原一致。
func safeCallID(mark, id string) string {
	if id == "" {
		return id
	}
	if anthropicSafeID.MatchString(id) && !strings.HasPrefix(id, mark) {
		return id
	}
	return mark + base64.RawURLEncoding.EncodeToString([]byte(id))
}

// rawCallID 是 safeCallID 的逆运算：只有确实由 safeCallID 产生的 id 才会被还原。
func rawCallID(mark, id string) string {
	if !strings.HasPrefix(id, mark) || !anthropicSafeID.MatchString(id) {
		return id
	}
	raw, err := base64.RawURLEncoding.DecodeString(id[len(mark):])
	if err != nil || len(raw) == 0 || !utf8.Valid(raw) || safeCallID(mark, string(raw)) != id {
		return id
	}
	return string(raw)
}

// ---------------------------------------------------------------------------
// 透传字段小工具（cache_control / citations）
// ---------------------------------------------------------------------------

// keepAnthropicExtras 抽取块里需要原样带回 Anthropic 的透传字段。
func keepAnthropicExtras(block anthropicWireBlock) json.RawMessage {
	kept := map[string]json.RawMessage{}
	if len(bytes.TrimSpace(block.CacheControl)) > 0 {
		kept["cache_control"] = block.CacheControl
	}
	if len(bytes.TrimSpace(block.Citations)) > 0 {
		kept["citations"] = block.Citations
	}
	if len(kept) == 0 {
		return nil
	}
	return mustRaw(kept)
}

// overlayAnthropicExtras 把保留的透传字段合回渲染出的块。
func overlayAnthropicExtras(block map[string]any, raw json.RawMessage) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return
	}
	var extras map[string]any
	if json.Unmarshal(raw, &extras) != nil {
		return
	}
	for _, key := range []string{"cache_control", "citations"} {
		if value, ok := extras[key]; ok {
			block[key] = value
		}
	}
}

// hasCacheControl 报告 IR 片段是否保留了 Anthropic 的 cache_control。
//
// 渲染到非 Anthropic 协议时由目标 codec 调用，用于记录一次有损映射
// （Anthropic 专有字段无法在 OpenAI 侧表达）。
func hasCacheControl(raw json.RawMessage) bool {
	if len(bytes.TrimSpace(raw)) == 0 {
		return false
	}
	var extras struct {
		CacheControl json.RawMessage `json:"cache_control"`
	}
	if json.Unmarshal(raw, &extras) != nil {
		return false
	}
	return len(bytes.TrimSpace(extras.CacheControl)) > 0
}

// thinkingLossyField 给 thinking 片段选一个有损映射字段名：
// 带签名的是 thinking.signature，脱敏的是 redacted_thinking，其余是 thinking。
func thinkingLossyField(part contracts.Part) string {
	if part.Redacted {
		return "redacted_thinking"
	}
	if part.Signature != "" {
		return "thinking.signature"
	}
	return "thinking"
}
