package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// chatCommand 是 `dizzy chat`：打一条真实的 LLM 请求。
//
// 走 **/v1/chat/completions**（Bearer key），不是控制面。
func chatCommand() *command {
	return &command{
		Name:    "chat",
		Summary: "发一条消息给模型（/v1/chat/completions）",
		Usage:   "dizzy chat -m <模型> [消息...] [--stream] [--json] [--system <文本>]",
		Example: "dizzy chat -m deepseek-flash \"你好\"\ndizzy chat -m gpt-4o-mini --stream \"写一首诗\"\necho \"总结这段\" | dizzy chat -m gpt-4o-mini -",
		Run:     runChat,
	}
}

// chatMessage 是一条对话消息（OpenAI Chat 形状）。
type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// chatRequest 是 /v1/chat/completions 的请求体。
type chatRequest struct {
	Model    string        `json:"model"`
	Messages []chatMessage `json:"messages"`
	Stream   bool          `json:"stream,omitempty"`
	// Temperature / MaxTokens 可选；-1 表示不传（让服务端用默认值）。
	Temperature *float64 `json:"temperature,omitempty"`
	MaxTokens   *int     `json:"max_tokens,omitempty"`
}

func runChat(args []string, globals globalFlags) error {
	set := newFlagSet("chat")
	model := set.String("m", "", "模型名")
	modelLong := set.String("model", "", "模型名（--m 的长写法）")
	stream := set.Bool("stream", false, "流式输出")
	system := set.String("system", "", "系统提示词")
	temperature := set.Float64("temperature", -1, "采样温度（不给则不传）")
	maxTokens := set.Int("max-tokens", -1, "最大输出 token（不给则不传）")
	showKey := set.Bool("show", false, "打印完整的一次性 secret（create / rotate 用）")
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}
	_ = showKey // chat 不用这个参数；留着是为了统一 flag 解析的容错。

	name := *model
	if name == "" {
		name = *modelLong
	}

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}
	if name == "" {
		name = config.DefaultModel
	}
	if name == "" {
		return fmt.Errorf("%w：必须用 -m 指定模型（或在配置里设 defaultModel）", errUsage)
	}

	content, err := collectPrompt(set.Args())
	if err != nil {
		return err
	}

	messages := []chatMessage{}
	if *system != "" {
		messages = append(messages, chatMessage{Role: "system", Content: *system})
	}
	messages = append(messages, chatMessage{Role: "user", Content: content})

	request := chatRequest{
		Model:    name,
		Messages: messages,
		Stream:   *stream,
	}
	if *temperature >= 0 {
		value := *temperature
		request.Temperature = &value
	}
	if *maxTokens > 0 {
		value := *maxTokens
		request.MaxTokens = &value
	}

	client, err := newLLMClient(config, globals)
	if err != nil {
		return err
	}

	// 费用只在**有会话**时回查：价格表与用量都在控制面（/api/usage），
	// 而 Bearer key 只能打 LLM 入口。没有会话时 chat 照常跑，只是不打印费用。
	// 注意回查发生在**请求之后**：要先拿到响应头 X-Request-Id 才能精确对账。
	if *stream {
		return runChatStream(client, request, config, globals)
	}
	return runChatOnce(client, request, config, globals)
}

// collectPrompt 收集用户输入。
//
// 规则：位置参数里没有 `-` 时用位置参数（多个用空格拼）；有 `-` 时从 stdin 读全文。
func collectPrompt(args []string) (string, error) {
	fromStdin := false
	parts := []string{}
	for _, argument := range args {
		if argument == "-" {
			fromStdin = true
			continue
		}
		parts = append(parts, argument)
	}
	if fromStdin {
		raw, err := io.ReadAll(os.Stdin)
		if err != nil {
			return "", fmt.Errorf("从 stdin 读输入失败：%w", err)
		}
		text := strings.TrimSpace(string(raw))
		if text == "" {
			return "", errors.New("stdin 里没有内容")
		}
		return text, nil
	}
	text := strings.TrimSpace(strings.Join(parts, " "))
	if text == "" {
		return "", fmt.Errorf("%w：没有消息内容（给位置参数，或用 - 从 stdin 读）", errUsage)
	}
	return text, nil
}

// chatResponse 是非流式 /v1/chat/completions 的响应。
type chatResponse struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		Index   int `json:"index"`
		Message struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *chatUsage `json:"usage"`
}

// chatUsage 是 OpenAI 形状的用量。
//
// **口径警告**：`prompt_tokens` **含**缓存命中（prompt_tokens_details.cached_tokens），
// 而网关记账用的 `input` **不含**缓存（internal/usageprobe.Normalize）。
// 所以 CLI 自己按这套字段算出来的费用，在有缓存命中时与 /api/usage 对不上。
// 权威费用永远是 /api/usage 的 costMicros。
type chatUsage struct {
	PromptTokens        int `json:"prompt_tokens"`
	CompletionTokens    int `json:"completion_tokens"`
	TotalTokens         int `json:"total_tokens"`
	PromptTokensDetails *struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	CompletionTokensDetails *struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}

// cacheRead 返回缓存命中的 token 数。
func (u *chatUsage) cacheRead() int {
	if u == nil || u.PromptTokensDetails == nil {
		return 0
	}
	return u.PromptTokensDetails.CachedTokens
}

// netInput 返回**不含缓存**的输入 token（与网关记账同口径）。
func (u *chatUsage) netInput() int {
	if u == nil {
		return 0
	}
	net := u.PromptTokens - u.cacheRead()
	if net < 0 {
		return 0
	}
	return net
}

func runChatOnce(client *Client, request chatRequest, config Config, globals globalFlags) error {
	response, err := client.Do(Request{
		Method: "POST",
		Path:   "/v1/chat/completions",
		Body:   request,
	})
	if err != nil {
		return err
	}

	var parsed chatResponse
	if err := decodeJSON(response.Body, &parsed); err != nil {
		return err
	}

	text := ""
	finish := ""
	if len(parsed.Choices) > 0 {
		text = parsed.Choices[0].Message.Content
		finish = parsed.Choices[0].FinishReason
	}

	// 费用来自 /api/usage 的权威值，不在 CLI 里自己算（口径不同，见 usage_cost.go）。
	// 请求 id 优先用响应头（权威、零成本），拿不到就没有费用可查 —— **不猜**。
	reqID := response.RequestID
	cost, costOK := lookupCostByRequestID(config, globals, reqID)

	if config.JSON {
		payload := map[string]any{
			"id":           parsed.ID,
			"model":        parsed.Model,
			"content":      text,
			"finishReason": finish,
			"usage":        parsed.Usage,
		}
		if reqID != "" {
			payload["reqId"] = reqID
		}
		if costOK {
			payload["costMicros"] = cost
		}
		return printJSON(payload)
	}

	fmt.Fprint(os.Stdout, text)
	if text != "" && !strings.HasSuffix(text, "\n") {
		fmt.Fprintln(os.Stdout)
	}
	printChatUsage(parsed.Usage, parsed.Model, finish, cost, costOK, reqID)
	return nil
}

// printChatUsage 打 token 与费用摘要。
//
// 费用只有在**查到了权威值**时才打印：CLI 手上没有价格表，而按响应里的
// prompt_tokens（含缓存）硬算与 /api/usage 的 costMicros（不含缓存）口径不同，
// 跨协议时更是对不上。宁可显示「未知」，也不显示一个错的数。
func printChatUsage(usage *chatUsage, model, finish, cost string, costOK bool, reqID string) {
	if usage == nil {
		fmt.Fprintln(os.Stderr, "（响应里没有 usage：这一条不会被网关记账）")
		return
	}
	parts := []string{
		"输入 " + formatCount(usage.netInput()) + "（不含缓存）",
		"输出 " + formatCount(usage.CompletionTokens),
		"缓存读 " + formatCount(usage.cacheRead()),
		"合计 " + formatCount(usage.TotalTokens),
	}
	line := strings.Join(parts, " · ")
	if model != "" {
		line = model + " · " + line
	}
	if finish != "" {
		line += " · " + finish
	}
	fmt.Fprintln(os.Stderr, line)

	switch {
	case costOK:
		fmt.Fprintf(os.Stderr, "费用：%s\n", formatCostMicros(cost))
	case reqID == "":
		fmt.Fprintln(os.Stderr, "费用：未取到（响应里没有 X-Request-Id 头，无法精确定位这条记录）")
	case !hasSession():
		fmt.Fprintln(os.Stderr, "费用：未查（没有会话；`dizzy login` 后 chat 会按 reqId 回查 /api/usage）")
	default:
		fmt.Fprintf(os.Stderr, "费用：未取到这条记录（用量异步落库；稍后 `dizzy usage show %s` 可查）\n", reqID)
	}
	// 请求 id 一定给：拿不到就明说，不留空、不编。
	if reqID != "" {
		fmt.Fprintf(os.Stderr, "请求 id：%s\n", reqID)
	} else {
		fmt.Fprintln(os.Stderr, "请求 id：未取到（网关没回 X-Request-Id 头）")
	}
}

// hasSession 报告本机是否有会话凭据。
func hasSession() bool {
	_, err := SessionToken()
	return err == nil
}

// runChatStream 跑流式请求，逐块打印增量内容。
func runChatStream(client *Client, request chatRequest, config Config, globals globalFlags) error {
	response, err := client.Do(Request{
		Method: "POST",
		Path:   "/v1/chat/completions",
		Body:   request,
		Stream: true,
		Accept: "text/event-stream",
	})
	if err != nil {
		return err
	}
	defer response.Stream.Close()

	var (
		content strings.Builder
		usage   *chatUsage
		model   string
	)
	scanner := scanLines(response.Stream)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var chunk chatChunk
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			// 单帧解析失败不该毁掉整条流：跳过这一帧。
			continue
		}
		if chunk.Model != "" {
			model = chunk.Model
		}
		if len(chunk.Choices) > 0 {
			delta := chunk.Choices[0].Delta.Content
			if delta != "" {
				content.WriteString(delta)
				if !config.JSON {
					fmt.Fprint(os.Stdout, delta)
				}
			}
		}
		if chunk.Usage != nil {
			usage = chunk.Usage
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("读流失败：%w", err)
	}

	// 与 runChatOnce 同口径：reqId 只认响应头，费用只按 reqId 精确回查。
	reqID := response.RequestID
	cost, costOK := lookupCostByRequestID(config, globals, reqID)

	if config.JSON {
		payload := map[string]any{
			"model":   model,
			"content": content.String(),
			"usage":   usage,
		}
		if reqID != "" {
			payload["reqId"] = reqID
		}
		if costOK {
			payload["costMicros"] = cost
		}
		return printJSON(payload)
	}
	if content.Len() > 0 {
		fmt.Fprintln(os.Stdout)
	}
	printChatUsage(usage, model, "", cost, costOK, reqID)
	return nil
}

// chatChunk 是流式响应的一帧。
type chatChunk struct {
	Model   string `json:"model"`
	Choices []struct {
		Index int `json:"index"`
		Delta struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *chatUsage `json:"usage"`
}
