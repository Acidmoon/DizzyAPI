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

// newGatewayWithConversion 在基础网关上再挂 protoconv（含 Chat codec），
// 用于验证「协议 → 方言」的端到端行为。
func newGatewayWithConversion(t *testing.T, upstreamURL string, keyConfig keyauth.Config) gateway {
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

func postPath(t *testing.T, handler http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer gateway-key")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestChatErrorBytesUnchanged(t *testing.T) {
	world := newGateway(t, "http://127.0.0.1:1", keyauth.Config{})
	recorder := postChat(t, world.handler, `{not json`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("期望 400，得到 %d", recorder.Code)
	}
	want := `{"error":{"code":"INVALID_REQUEST","message":"请求体必须是合法 JSON","type":"invalid_request_error"}}`
	if recorder.Body.String() != want {
		t.Fatalf("chat 错误体字节变了：\n得到 %s\n期望 %s", recorder.Body.String(), want)
	}
}

func TestMessagesRouteUsesAnthropicDialect(t *testing.T) {
	var path, apiKey, version, authorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		apiKey = r.Header.Get("x-api-key")
		version = r.Header.Get("anthropic-version")
		authorization = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"msg_1","type":"message","content":[]}`)
	}))
	defer upstream.Close()

	world := newGatewayWithConversion(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "anthropic", Kind: "api_key", Token: "sk-ant", Protocol: "anthropic",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postPath(t, world.handler, "/v1/messages", `{"model":"claude","max_tokens":10,"messages":[]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if path != "/v1/messages" {
		t.Fatalf("路径不对：%s", path)
	}
	if apiKey != "sk-ant" || version != "2023-06-01" {
		t.Fatalf("Anthropic 鉴权头不对：x-api-key=%q version=%q", apiKey, version)
	}
	if authorization != "" {
		t.Fatalf("Anthropic 不应带 Authorization：%q", authorization)
	}
	if strings.Contains(recorder.Body.String(), "sk-ant") {
		t.Fatal("响应泄漏了上游令牌")
	}
}

func TestResponsesRouteUsesResponsesDialect(t *testing.T) {
	var path, authorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		authorization = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"resp_1"}`)
	}))
	defer upstream.Close()

	world := newGatewayWithConversion(t, upstream.URL, keyauth.Config{})
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

func TestChatRouteWithChatAccountIsUnchanged(t *testing.T) {
	var path, authorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		authorization = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chatcmpl-1"}`)
	}))
	defer upstream.Close()

	world := newGatewayWithConversion(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "sk-chat", Protocol: "openai-chat",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postPath(t, world.handler, "/v1/chat/completions", `{"model":"gpt-4","messages":[]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if path != "/v1/chat/completions" || authorization != "Bearer sk-chat" {
		t.Fatalf("chat 直通行为变了：path=%s auth=%q", path, authorization)
	}
}

func TestCrossProtocolWithoutCodecFailsClosed(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("不应到达上游")
	}))
	defer upstream.Close()

	world := newGatewayWithConversion(t, upstream.URL, keyauth.Config{})
	// 客户端是 openai-chat，账号声明 anthropic：需要 anthropic codec（未注册）。
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "anthropic", Kind: "api_key", Token: "sk-ant", Protocol: "anthropic",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postPath(t, world.handler, "/v1/chat/completions", `{"model":"gpt-4","messages":[]}`)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("期望 502，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "PROTOCOL_CODEC_UNAVAILABLE") {
		t.Fatalf("错误码不对：%s", recorder.Body.String())
	}
}

func TestMessagesRouteRendersAnthropicErrorShape(t *testing.T) {
	world := newGatewayWithConversion(t, "http://127.0.0.1:1", keyauth.Config{})
	recorder := postPath(t, world.handler, "/v1/messages", `{"model":"claude","max_tokens":10,"messages":[]}`)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("期望 503，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"type":"error"`) || !strings.Contains(body, `"type":"api_error"`) {
		t.Fatalf("Anthropic 错误体形状不对：%s", body)
	}
}
