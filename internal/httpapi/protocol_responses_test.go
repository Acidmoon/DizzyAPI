package httpapi

import (
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

// newGatewayWithResponsesConversion 在基础网关上再挂 protoconv（Chat + Responses 两个 codec），
// 用于验证 Responses 方向的跨协议转换。
func newGatewayWithResponsesConversion(t *testing.T, upstreamURL string, keyConfig keyauth.Config) gateway {
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
	if err := codecs.Register(protoconv.NewResponsesCodec()); err != nil {
		t.Fatalf("注册 Responses codec: %v", err)
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

const responsesUpstreamBody = `{
  "id": "resp_1", "object": "response", "status": "completed", "model": "gpt-5",
  "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "hello"}]}],
  "output_text": "hello",
  "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
}`

const chatUpstreamBody = `{
  "id": "chatcmpl-1", "object": "chat.completion", "model": "gpt-4",
  "choices": [{"index": 0, "message": {"role": "assistant", "content": "hey"}, "finish_reason": "stop"}],
  "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
}`

func TestChatClientToResponsesAccount(t *testing.T) {
	var upstreamBody, upstreamPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		upstreamBody = string(raw)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, responsesUpstreamBody)
	}))
	defer upstream.Close()

	world := newGatewayWithResponsesConversion(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "sk-up", Protocol: "openai-responses",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postPath(t, world.handler, "/v1/chat/completions",
		`{"model":"gpt-4","messages":[{"role":"system","content":"be nice"},{"role":"user","content":"hi"}]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	// 上游必须收到 Responses 形状的请求。
	if upstreamPath != "/v1/responses" {
		t.Fatalf("上游路径不对：%s", upstreamPath)
	}
	if !strings.Contains(upstreamBody, `"instructions":"be nice"`) {
		t.Fatalf("system 应转成 instructions：%s", upstreamBody)
	}
	if !strings.Contains(upstreamBody, `"input":[`) || !strings.Contains(upstreamBody, `"type":"input_text"`) ||
		!strings.Contains(upstreamBody, `"text":"hi"`) {
		t.Fatalf("上游请求体不是 Responses 形状：%s", upstreamBody)
	}
	if strings.Contains(upstreamBody, `"messages"`) {
		t.Fatalf("上游不应收到 Chat 形状：%s", upstreamBody)
	}

	// 客户端必须收到 Chat 形状的响应。
	body := recorder.Body.String()
	if !strings.Contains(body, `"object":"chat.completion"`) {
		t.Fatalf("客户端响应不是 Chat 形状：%s", body)
	}
	if !strings.Contains(body, `"content":"hello"`) || !strings.Contains(body, `"finish_reason":"stop"`) {
		t.Fatalf("客户端响应内容不对：%s", body)
	}
	if strings.Contains(body, "sk-up") {
		t.Fatal("响应泄漏了上游令牌")
	}
}

func TestResponsesClientToChatAccount(t *testing.T) {
	var upstreamBody, upstreamPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		upstreamBody = string(raw)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, chatUpstreamBody)
	}))
	defer upstream.Close()

	world := newGatewayWithResponsesConversion(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "sk-chat", Protocol: "openai-chat",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postPath(t, world.handler, "/v1/responses", `{"model":"gpt-5","input":"hi"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if upstreamPath != "/v1/chat/completions" {
		t.Fatalf("上游路径不对：%s", upstreamPath)
	}
	if !strings.Contains(upstreamBody, `"messages":[`) || !strings.Contains(upstreamBody, `"content":"hi"`) {
		t.Fatalf("上游请求体不是 Chat 形状：%s", upstreamBody)
	}

	body := recorder.Body.String()
	if !strings.Contains(body, `"object":"response"`) || !strings.Contains(body, `"output":[`) {
		t.Fatalf("客户端响应不是 Responses 形状：%s", body)
	}
	if !strings.Contains(body, `"type":"output_text"`) || !strings.Contains(body, `"text":"hey"`) {
		t.Fatalf("客户端响应内容不对：%s", body)
	}
	if strings.Contains(body, "sk-chat") {
		t.Fatal("响应泄漏了上游令牌")
	}
}

func TestChatClientStreamsFromResponsesAccount(t *testing.T) {
	stream := strings.Join([]string{
		`event: response.created`,
		`data: {"type":"response.created","response":{"id":"resp_1","object":"response","status":"in_progress","model":"gpt-5","output":[]}}`,
		``,
		`event: response.output_item.added`,
		`data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}`,
		``,
		`event: response.output_text.delta`,
		`data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","delta":"Hel"}`,
		``,
		`event: response.output_text.delta`,
		`data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","delta":"lo"}`,
		``,
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5","output":[],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}`,
		``,
	}, "\n")

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, stream)
	}))
	defer upstream.Close()

	world := newGatewayWithResponsesConversion(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "sk-up", Protocol: "openai-responses",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postPath(t, world.handler, "/v1/chat/completions", `{"model":"gpt-4","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"content":"Hel"`) || !strings.Contains(body, `"content":"lo"`) {
		t.Fatalf("Chat 侧缺少内容增量：%s", body)
	}
	if !strings.Contains(body, `"finish_reason":"stop"`) {
		t.Fatalf("Chat 侧缺少 finish_reason：%s", body)
	}
	if !strings.Contains(body, "data: [DONE]") {
		t.Fatalf("Chat 侧缺少 [DONE]：%s", body)
	}
}

func TestResponsesClientStreamsFromChatAccount(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"id":"chatcmpl-1","model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
		``,
		`data: {"id":"chatcmpl-1","model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}`,
		``,
		`data: {"id":"chatcmpl-1","model":"gpt-4","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}`,
		``,
		`data: {"id":"chatcmpl-1","model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, stream)
	}))
	defer upstream.Close()

	world := newGatewayWithResponsesConversion(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "sk-chat", Protocol: "openai-chat",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postPath(t, world.handler, "/v1/responses", `{"model":"gpt-5","stream":true,"input":"hi"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, want := range []string{"response.created", "response.output_text.delta", "response.completed"} {
		if !strings.Contains(body, want) {
			t.Fatalf("Responses 侧缺少 %s：%s", want, body)
		}
	}
	if !strings.Contains(body, `"delta":"Hel"`) || !strings.Contains(body, `"delta":"lo"`) {
		t.Fatalf("Responses 侧缺少内容增量：%s", body)
	}
	if strings.Contains(body, "data: [DONE]") {
		t.Fatalf("Responses 流不应发 [DONE]：%s", body)
	}
	if strings.Contains(body, "sk-chat") {
		t.Fatal("流响应泄漏了上游令牌")
	}
}

func TestResponsesAccountUsesResponsesDialect(t *testing.T) {
	var path, authorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		authorization = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, responsesUpstreamBody)
	}))
	defer upstream.Close()

	world := newGatewayWithResponsesConversion(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "sk-resp", Protocol: "openai-responses",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postPath(t, world.handler, "/v1/responses", `{"model":"gpt-5","input":"hi"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if path != "/v1/responses" || authorization != "Bearer sk-resp" {
		t.Fatalf("Responses 方言不对：path=%s auth=%q", path, authorization)
	}
}
