package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/engine"
	"github.com/Acidmoon/DizzyAPI/modules/accountpriority"
	"github.com/Acidmoon/DizzyAPI/modules/keyauth"
	"github.com/Acidmoon/DizzyAPI/modules/protoconv"
	"github.com/Acidmoon/DizzyAPI/modules/transport"
)

// newGatewayWithAnthropic 在基础网关上挂 protoconv，并同时注册 Chat 与 Anthropic codec，
// 用于验证 Anthropic ↔ OpenAI Chat 双向转换的端到端行为。
func newGatewayWithAnthropic(t *testing.T, upstreamURL string, keyConfig keyauth.Config) gateway {
	t.Helper()
	cache := accounts.New()
	registry := contracts.NewRegistry()
	keyauth.Register(registry, keyConfig)
	if _, err := accountpriority.Register(registry, accountpriority.Config{}); err != nil {
		t.Fatalf("accountpriority.Register: %v", err)
	}
	codecs := contracts.NewCodecRegistry()
	if err := codecs.Register(protoconv.NewChatCodec()); err != nil {
		t.Fatalf("注册 Chat codec: %v", err)
	}
	if err := codecs.Register(protoconv.NewAnthropicCodec(protoconv.AnthropicConfig{})); err != nil {
		t.Fatalf("注册 Anthropic codec: %v", err)
	}
	converter, err := protoconv.Register(registry, protoconv.Config{}, codecs, cache, nil)
	if err != nil {
		t.Fatalf("protoconv.Register: %v", err)
	}
	if _, err := transport.Register(registry, transport.Config{RequestTimeoutMs: 5_000}, cache, converter.Transcoder()); err != nil {
		t.Fatalf("transport.Register: %v", err)
	}
	requestEngine, err := engine.New(registry.Stages(), nil)
	if err != nil {
		t.Fatalf("engine.New: %v", err)
	}
	server, err := New(requestEngine, cache, nil, Config{})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	return gateway{handler: server.Handler(), accounts: cache}
}

// TestChatClientAnthropicUpstream: 客户端说 openai-chat，账号声明 anthropic。
// 上游应收到 Anthropic 形状的 body，响应应被转回 OpenAI Chat 形状。
func TestChatClientAnthropicUpstream(t *testing.T) {
	var upstreamBody map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &upstreamBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"msg_1","type":"message","role":"assistant","model":"claude-3","content":[{"type":"text","text":"hi from claude"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}`)
	}))
	defer upstream.Close()

	world := newGatewayWithAnthropic(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "anthropic", Kind: "api_key", Token: "sk-ant-secret", Protocol: "anthropic",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	body := `{"model":"claude-3","messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"f","description":"d","parameters":{"type":"object"}}}]}`
	recorder := postPath(t, world.handler, "/v1/chat/completions", body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}

	// 上游收到 Anthropic 形状。
	if _, ok := upstreamBody["max_tokens"]; !ok {
		t.Fatalf("Anthropic 请求必须带 max_tokens：%+v", upstreamBody)
	}
	tools, _ := upstreamBody["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("上游 tools 不对：%+v", upstreamBody["tools"])
	}
	tool, _ := tools[0].(map[string]any)
	if _, ok := tool["input_schema"]; !ok {
		t.Fatalf("工具应为 Anthropic input_schema 形状：%+v", tool)
	}
	if _, ok := tool["function"]; ok {
		t.Fatalf("工具不应是 OpenAI function 形状：%+v", tool)
	}

	// 响应被转回 OpenAI Chat 形状。
	var chatResp struct {
		Object  string `json:"object"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &chatResp); err != nil {
		t.Fatalf("响应不是 JSON：%v：%s", err, recorder.Body.String())
	}
	if len(chatResp.Choices) != 1 || chatResp.Choices[0].Message.Content != "hi from claude" {
		t.Fatalf("未转回 OpenAI Chat 形状：%s", recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "sk-ant-secret") {
		t.Fatal("响应泄漏了上游令牌")
	}
}

// TestMessagesClientChatUpstream: 客户端说 anthropic，账号声明 openai-chat。
// 上游应收到 OpenAI 形状的 body，响应应被转回 Anthropic 形状。
func TestMessagesClientChatUpstream(t *testing.T) {
	var upstreamBody map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &upstreamBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chatcmpl-1","object":"chat.completion","model":"gpt-4","choices":[{"index":0,"message":{"role":"assistant","content":"hi from gpt"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}`)
	}))
	defer upstream.Close()

	world := newGatewayWithAnthropic(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "sk-chat-secret", Protocol: "openai-chat",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	body := `{"model":"gpt-4","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}`
	recorder := postPath(t, world.handler, "/v1/messages", body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}

	// 上游收到 OpenAI 形状。
	if _, ok := upstreamBody["messages"]; !ok {
		t.Fatalf("上游应收到 OpenAI messages：%+v", upstreamBody)
	}
	if _, ok := upstreamBody["system"]; ok {
		t.Fatalf("OpenAI 请求不应带 Anthropic system 字段：%+v", upstreamBody)
	}

	// 响应被转回 Anthropic 形状。
	var anthropicResp struct {
		Type    string `json:"type"`
		Role    string `json:"role"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &anthropicResp); err != nil {
		t.Fatalf("响应不是 JSON：%v：%s", err, recorder.Body.String())
	}
	if anthropicResp.Type != "message" || anthropicResp.Role != "assistant" {
		t.Fatalf("未转回 Anthropic 形状：%s", recorder.Body.String())
	}
	if len(anthropicResp.Content) == 0 || anthropicResp.Content[0].Text != "hi from gpt" {
		t.Fatalf("Anthropic 内容不对：%s", recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "sk-chat-secret") {
		t.Fatal("响应泄漏了上游令牌")
	}
}

// TestChatClientAnthropicUpstreamStream: 流式方向一：上游 Anthropic SSE → 客户端 Chat SSE。
func TestChatClientAnthropicUpstreamStream(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		_, _ = io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-3\",\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n")
		_, _ = io.WriteString(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
		_, _ = io.WriteString(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n")
		_, _ = io.WriteString(w, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
		_, _ = io.WriteString(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n")
		_, _ = io.WriteString(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	}))
	defer upstream.Close()

	world := newGatewayWithAnthropic(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "anthropic", Kind: "api_key", Token: "sk-ant-secret", Protocol: "anthropic",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postPath(t, world.handler, "/v1/chat/completions", `{"model":"claude-3","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	payload := recorder.Body.String()
	if !strings.Contains(payload, "data: [DONE]") {
		t.Fatalf("Chat 流应以 [DONE] 结束：%s", payload)
	}
	if !strings.Contains(payload, `"content":"hi"`) {
		t.Fatalf("Chat 流缺少内容增量：%s", payload)
	}
	if strings.Contains(payload, "sk-ant-secret") {
		t.Fatal("流响应泄漏了上游令牌")
	}
}

// TestMessagesClientChatUpstreamStream: 流式方向二：上游 OpenAI SSE → 客户端 Anthropic SSE。
func TestMessagesClientChatUpstreamStream(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		_, _ = io.WriteString(w, "data: {\"id\":\"c1\",\"model\":\"gpt-4\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hi\"},\"finish_reason\":null}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"id\":\"c1\",\"model\":\"gpt-4\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	}))
	defer upstream.Close()

	world := newGatewayWithAnthropic(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "sk-chat-secret", Protocol: "openai-chat",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postPath(t, world.handler, "/v1/messages", `{"model":"gpt-4","max_tokens":50,"stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	payload := recorder.Body.String()
	if !strings.Contains(payload, "event: message_stop") {
		t.Fatalf("Anthropic 流应以 message_stop 结束：%s", payload)
	}
	if !strings.Contains(payload, "event: message_start") || !strings.Contains(payload, "event: content_block_delta") {
		t.Fatalf("Anthropic 流事件不完整：%s", payload)
	}
	if strings.Contains(payload, "sk-chat-secret") {
		t.Fatal("流响应泄漏了上游令牌")
	}
}
