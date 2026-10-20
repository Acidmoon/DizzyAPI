package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/engine"
	"github.com/Acidmoon/DizzyAPI/modules/accountpriority"
	"github.com/Acidmoon/DizzyAPI/modules/keyauth"
	"github.com/Acidmoon/DizzyAPI/modules/modelroute"
	"github.com/Acidmoon/DizzyAPI/modules/protoconv"
	"github.com/Acidmoon/DizzyAPI/modules/transport"
)

// 本文件验证模型路由 / 映射在完整链路里的行为（与 main.go 相同的装配顺序）：
//
//	keyauth → modelroute.RegisterRouter → accountpriority
//	        → modelroute.RegisterMapper → protoconv → transport
func newRoutedGateway(t *testing.T, keyConfig keyauth.Config) gateway {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	cache := accounts.New()
	registry := contracts.NewRegistry()
	keyStage := keyauth.Register(registry, keyConfig)

	if _, err := modelroute.RegisterRouter(registry, modelroute.Config{}, logger); err != nil {
		t.Fatalf("modelroute.RegisterRouter: %v", err)
	}
	if _, err := accountpriority.Register(registry, accountpriority.Config{}); err != nil {
		t.Fatalf("accountpriority.Register: %v", err)
	}
	if err := modelroute.RegisterMapper(registry, modelroute.Config{}, cache, logger); err != nil {
		t.Fatalf("modelroute.RegisterMapper: %v", err)
	}
	codecs := contracts.NewCodecRegistry()
	for _, codec := range []contracts.Codec{
		protoconv.NewChatCodec(),
		protoconv.NewResponsesCodec(),
		protoconv.NewAnthropicCodec(protoconv.AnthropicConfig{DefaultMaxTokens: 4096}),
	} {
		if err := codecs.Register(codec); err != nil {
			t.Fatalf("注册 %s codec: %v", codec.Protocol(), err)
		}
	}
	converter, err := protoconv.Register(registry, protoconv.Config{}, codecs, cache, logger)
	if err != nil {
		t.Fatalf("protoconv.Register: %v", err)
	}
	if _, err := transport.Register(registry, transport.Config{RequestTimeoutMs: 5_000}, cache, converter.Transcoder()); err != nil {
		t.Fatalf("transport.Register: %v", err)
	}
	requestEngine, err := engine.New(registry.Stages(), logger)
	if err != nil {
		t.Fatalf("engine.New: %v", err)
	}
	server, err := New(requestEngine, cache, logger, Config{Authorizer: keyStage})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	return gateway{handler: server.Handler(), accounts: cache}
}

func TestModelMapRewritesUpstreamBody(t *testing.T) {
	var (
		upstreamModel string
		authorization string
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		upstreamModel, _ = body["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chatcmpl-1","choices":[{"message":{"content":"hi"}}]}`)
	}))
	defer upstream.Close()

	world := newRoutedGateway(t, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "token-1",
		Models:   []string{"gpt-4o"},
		ModelMap: map[string]string{"gpt-4o": "gpt-4o-2024-11-20"},
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postChat(t, world.handler, `{"model":"gpt-4o","messages":[]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if upstreamModel != "gpt-4o-2024-11-20" {
		t.Fatalf("上游模型名未替换：%q", upstreamModel)
	}
	if authorization != "Bearer token-1" {
		t.Fatalf("鉴权头不对：%q", authorization)
	}
}

func TestModelRouteFiltersAccounts(t *testing.T) {
	var seen []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"ok"}`)
	}))
	defer upstream.Close()

	world := newRoutedGateway(t, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL,
		accounts.Account{AccountID: "acc-claude", Provider: "openai", Kind: "api_key",
			Token: "token-claude", Priority: 10, Models: []string{"claude-sonnet-4-5"}},
		accounts.Account{AccountID: "acc-gpt", Provider: "openai", Kind: "api_key",
			Token: "token-gpt", Priority: 1, Models: []string{"gpt-4o"}},
	)); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postChat(t, world.handler, `{"model":"gpt-4o","messages":[]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if len(seen) != 1 || seen[0] != "Bearer token-gpt" {
		t.Fatalf("应只选服务 gpt-4o 的账号：%v", seen)
	}
}

func TestModelNotServedReturns503(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("模型未服务时不应到达上游")
	}))
	defer upstream.Close()

	world := newRoutedGateway(t, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "token-1",
		Models: []string{"claude-sonnet-4-5"},
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postChat(t, world.handler, `{"model":"gpt-4o","messages":[]}`)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("期望 503，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "MODEL_NOT_SERVED") {
		t.Fatalf("错误码不对：%s", recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "gpt-4o") {
		t.Fatalf("消息应带模型名：%s", recorder.Body.String())
	}
}

// 失败转移到第二个账号时，映射必须按新账号重算，不能残留上一个账号的改写。
func TestModelMapResetsAcrossFailover(t *testing.T) {
	var secondBody map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer token-high" {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, `{"error":{"message":"bad"}}`)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &secondBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chatcmpl-fallback"}`)
	}))
	defer upstream.Close()

	world := newRoutedGateway(t, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL,
		accounts.Account{AccountID: "acc-high", Provider: "openai", Kind: "api_key",
			Token: "token-high", Priority: 10,
			Models: []string{"gpt-4o"}, ModelMap: map[string]string{"gpt-4o": "upstream-high"}},
		accounts.Account{AccountID: "acc-low", Provider: "openai", Kind: "api_key",
			Token: "token-low", Priority: 1,
			Models: []string{"gpt-4o"}, ModelMap: map[string]string{"gpt-4o": "upstream-low"}},
	)); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postChat(t, world.handler, `{"model":"gpt-4o","messages":[]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if secondBody["model"] != "upstream-low" {
		t.Fatalf("failover 后应发第二个账号的映射，得到 %v", secondBody["model"])
	}
}

// 跨协议时 protoconv 基于改名后的 body 解析 IR：IR.Model 自然已是上游名。
func TestCrossProtocolUsesMappedModel(t *testing.T) {
	var (
		upstreamPath  string
		upstreamModel string
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		upstreamModel, _ = body["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"msg_1","type":"message","role":"assistant","model":"x",
			"content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn",
			"usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer upstream.Close()

	world := newRoutedGateway(t, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "anthropic", Kind: "api_key", Token: "sk-ant-secret",
		Protocol: "anthropic",
		Models:   []string{"claude-sonnet-4-5"},
		ModelMap: map[string]string{"claude-sonnet-4-5": "claude-sonnet-4-5-20250929"},
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postChat(t, world.handler, `{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if upstreamPath != "/v1/messages" {
		t.Fatalf("上游路径不对：%s", upstreamPath)
	}
	if upstreamModel != "claude-sonnet-4-5-20250929" {
		t.Fatalf("跨协议应基于映射后的 body 解析 IR：%q", upstreamModel)
	}
	if strings.Contains(recorder.Body.String(), "sk-ant-secret") {
		t.Fatal("响应泄漏了上游令牌")
	}
}
