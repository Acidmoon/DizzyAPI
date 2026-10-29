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

// 本文件验证「两个非 Chat 协议之间」的转换 —— 也就是中间件存在的理由：
// 客户端说 Responses（Codex），号池里却是 Anthropic 账号。
//
// Chat ↔ Anthropic 与 Chat ↔ Responses 分别由 protocol_anthropic_test.go /
// protocol_responses_test.go 覆盖；这里补的是 Responses ↔ Anthropic 这一对，
// 它是三个 codec 里唯一必须三个都注册才能跑的路径。

// newGatewayWithAllCodecs 挂上全部四个 codec 的网关。
func newGatewayWithAllCodecs(t *testing.T, upstreamURL string, keyConfig keyauth.Config) gateway {
	t.Helper()
	cache := accounts.New()
	registry := contracts.NewRegistry()
	keyauth.Register(registry, keyConfig)
	if _, err := accountpriority.Register(registry, accountpriority.Config{}); err != nil {
		t.Fatalf("accountpriority.Register: %v", err)
	}
	codecs := contracts.NewCodecRegistry()
	for _, codec := range []contracts.Codec{
		protoconv.NewChatCodec(),
		protoconv.NewResponsesCodec(),
		protoconv.NewAnthropicCodec(protoconv.AnthropicConfig{}),
		protoconv.NewGeminiCodec(),
	} {
		if err := codecs.Register(codec); err != nil {
			t.Fatalf("注册 %s codec: %v", codec.Protocol(), err)
		}
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

const anthropicMessageBody = `{
  "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-3",
  "content": [{"type": "text", "text": "hi from claude"}],
  "stop_reason": "end_turn",
  "usage": {"input_tokens": 3, "output_tokens": 2}
}`

// Codex 场景：客户端说 OpenAI Responses，账号声明 anthropic。
func TestResponsesClientAnthropicUpstream(t *testing.T) {
	var (
		upstreamPath  string
		upstreamBody  map[string]any
		apiKey        string
		version       string
		authorization string
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamPath = r.URL.Path
		apiKey = r.Header.Get("x-api-key")
		version = r.Header.Get("anthropic-version")
		authorization = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &upstreamBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, anthropicMessageBody)
	}))
	defer upstream.Close()

	world := newGatewayWithAllCodecs(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "anthropic", Kind: "api_key",
		Token: "sk-ant-secret", Protocol: "anthropic",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	// Responses 形状的请求：instructions + input item 数组 + 扁平 tools。
	body := `{"model":"claude-3","instructions":"be nice","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"tools":[{"type":"function","name":"f","description":"d","parameters":{"type":"object","properties":{}}}]}`
	recorder := postPath(t, world.handler, "/v1/responses", body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}

	// 上游收到 Anthropic 方言与形状。
	if upstreamPath != "/v1/messages" {
		t.Fatalf("上游路径不对：%s", upstreamPath)
	}
	if apiKey != "sk-ant-secret" || version == "" {
		t.Fatalf("Anthropic 鉴权头不对：x-api-key=%q version=%q", apiKey, version)
	}
	if authorization != "" {
		t.Fatalf("Anthropic 不应带 Authorization：%q", authorization)
	}
	if _, ok := upstreamBody["max_tokens"]; !ok {
		t.Fatalf("Anthropic 必填的 max_tokens 没补上：%v", upstreamBody)
	}
	if _, ok := upstreamBody["system"]; !ok {
		t.Fatalf("instructions 没映射到 system：%v", upstreamBody)
	}
	messages, _ := upstreamBody["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("messages 形状不对：%v", upstreamBody["messages"])
	}
	tools, _ := upstreamBody["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools 没转过去：%v", upstreamBody["tools"])
	}
	firstTool, _ := tools[0].(map[string]any)
	if _, ok := firstTool["input_schema"]; !ok {
		t.Fatalf("tools 应是 Anthropic 的 input_schema 形状：%v", firstTool)
	}

	// 响应被转回 Responses 形状。
	var converted map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &converted); err != nil {
		t.Fatalf("响应不是合法 JSON：%v", err)
	}
	if converted["object"] != "response" {
		t.Fatalf("响应应是 Responses 形状（object=response）：%v", converted)
	}
	if _, ok := converted["output"].([]any); !ok {
		t.Fatalf("响应缺 output 数组：%v", converted)
	}
	if strings.Contains(recorder.Body.String(), "sk-ant-secret") {
		t.Fatal("响应泄漏了上游令牌")
	}
}

// 同一场景的流式版本：上游 Anthropic SSE → 客户端 Responses SSE。
func TestResponsesClientAnthropicUpstreamStream(t *testing.T) {
	const anthropicStream = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-3","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}

`

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		_, _ = io.WriteString(w, anthropicStream)
		if flusher != nil {
			flusher.Flush()
		}
	}))
	defer upstream.Close()

	world := newGatewayWithAllCodecs(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "anthropic", Kind: "api_key",
		Token: "sk-ant-secret", Protocol: "anthropic",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	body := `{"model":"claude-3","stream":true,"input":"hi"}`
	recorder := postPath(t, world.handler, "/v1/responses", body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}

	text := recorder.Body.String()
	// 内容增量转成了 Responses 的事件名。
	if !strings.Contains(text, "response.output_text.delta") {
		t.Fatalf("流里没有 Responses 的文本增量事件：\n%s", text)
	}
	if !strings.Contains(text, "hello") {
		t.Fatalf("流里丢了正文：\n%s", text)
	}
	// Responses 的终止符是 response.completed，不是 [DONE]。
	if !strings.Contains(text, "response.completed") {
		t.Fatalf("流里没有 response.completed：\n%s", text)
	}
	if strings.Contains(text, "message_stop") {
		t.Fatalf("上游的 Anthropic 事件名漏给了客户端：\n%s", text)
	}
	if strings.Contains(text, "sk-ant-secret") {
		t.Fatal("流里泄漏了上游令牌")
	}
}

// 反向：客户端说 Anthropic Messages，账号声明 openai-responses。
func TestAnthropicClientResponsesUpstream(t *testing.T) {
	var (
		upstreamPath  string
		upstreamBody  map[string]any
		authorization string
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamPath = r.URL.Path
		authorization = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &upstreamBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"resp_1","object":"response","status":"completed","model":"gpt-5",
			"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi from gpt"}]}],
			"output_text":"hi from gpt","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}`)
	}))
	defer upstream.Close()

	world := newGatewayWithAllCodecs(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key",
		Token: "sk-resp-secret", Protocol: "openai-responses",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	body := `{"model":"gpt-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`
	recorder := postPath(t, world.handler, "/v1/messages", body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}

	if upstreamPath != "/v1/responses" {
		t.Fatalf("上游路径不对：%s", upstreamPath)
	}
	if authorization != "Bearer sk-resp-secret" {
		t.Fatalf("Responses 上游应走 Bearer：%q", authorization)
	}
	if _, ok := upstreamBody["max_output_tokens"]; !ok {
		t.Fatalf("max_tokens 没映射到 max_output_tokens：%v", upstreamBody)
	}
	if _, ok := upstreamBody["input"]; !ok {
		t.Fatalf("messages 没映射到 input：%v", upstreamBody)
	}

	var converted map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &converted); err != nil {
		t.Fatalf("响应不是合法 JSON：%v", err)
	}
	if converted["type"] != "message" {
		t.Fatalf("响应应是 Anthropic 形状（type=message）：%v", converted)
	}
	if strings.Contains(recorder.Body.String(), "sk-resp-secret") {
		t.Fatal("响应泄漏了上游令牌")
	}
}
