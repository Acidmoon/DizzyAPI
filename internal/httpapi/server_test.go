package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/apikeys"
	"github.com/Acidmoon/DizzyAPI/internal/engine"
	"github.com/Acidmoon/DizzyAPI/modules/accountpriority"
	"github.com/Acidmoon/DizzyAPI/modules/keyauth"
	"github.com/Acidmoon/DizzyAPI/modules/transport"
)

type gateway struct {
	handler  http.Handler
	accounts *accounts.Cache
}

func newGateway(t *testing.T, upstreamURL string, keyConfig keyauth.Config) gateway {
	t.Helper()
	cache := accounts.New()
	registry := contracts.NewRegistry()
	keyStage := keyauth.Register(registry, keyConfig)
	if _, err := accountpriority.Register(registry, accountpriority.Config{}); err != nil {
		t.Fatalf("accountpriority.Register: %v", err)
	}
	if _, err := transport.Register(registry, transport.Config{RequestTimeoutMs: 5_000}, cache, nil); err != nil {
		t.Fatalf("transport.Register: %v", err)
	}
	requestEngine, err := engine.New(registry.Stages(), nil)
	if err != nil {
		t.Fatalf("engine.New: %v", err)
	}
	server, err := New(requestEngine, cache, nil, Config{Authorizer: keyStage})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	return gateway{handler: server.Handler(), accounts: cache}
}

func snapshot(upstreamURL string, entries ...accounts.Account) accounts.Snapshot {
	for index := range entries {
		if entries[index].BaseURL == "" {
			entries[index].BaseURL = upstreamURL
		}
	}
	return accounts.Snapshot{Version: accounts.SnapshotVersion, Generation: "test", Accounts: entries}
}

func postChat(t *testing.T, handler http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	return postChatWithKey(t, handler, body, "gateway-key")
}

func postChatWithKey(
	t *testing.T,
	handler http.Handler,
	body string,
	key string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+key)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestChatCompletionsSelectsHighestPriorityAccount(t *testing.T) {
	var seen []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chatcmpl-1","choices":[{"message":{"content":"hi"}}]}`)
	}))
	defer upstream.Close()

	world := newGateway(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL,
		accounts.Account{AccountID: "acc-low", Provider: "openai", Kind: "api_key", Token: "token-low", Priority: 1},
		accounts.Account{AccountID: "acc-high", Provider: "openai", Kind: "api_key", Token: "token-high", Priority: 10},
	)); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postChat(t, world.handler, `{"model":"gpt-test","messages":[{"role":"user","content":"hi"}]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if len(seen) != 1 || seen[0] != "Bearer token-high" {
		t.Fatalf("没有选中高优先级账号：%v", seen)
	}
	if strings.Contains(recorder.Body.String(), "token-high") {
		t.Fatal("响应泄漏了上游令牌")
	}
}

func TestChatCompletionsFailsOverToNextAccount(t *testing.T) {
	var seen []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("Authorization")
		seen = append(seen, token)
		if token == "Bearer token-high" {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, `{"error":{"message":"bad"}}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chatcmpl-fallback"}`)
	}))
	defer upstream.Close()

	world := newGateway(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL,
		accounts.Account{AccountID: "acc-high", Provider: "openai", Kind: "api_key", Token: "token-high", Priority: 10},
		accounts.Account{AccountID: "acc-low", Provider: "openai", Kind: "api_key", Token: "token-low", Priority: 1},
	)); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postChat(t, world.handler, `{"model":"gpt-test","messages":[]}`)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "chatcmpl-fallback") {
		t.Fatalf("失败转移没有成功：%d %s", recorder.Code, recorder.Body.String())
	}
	if strings.Join(seen, ",") != "Bearer token-high,Bearer token-low" {
		t.Fatalf("尝试顺序不对：%v", seen)
	}
}

func TestChatCompletionsRequiresAPIKey(t *testing.T) {
	world := newGateway(t, "http://127.0.0.1:1", keyauth.Config{Keys: []string{"valid-key"}})
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"m"}`))
	recorder := httptest.NewRecorder()
	world.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("期望 401，得到 %d", recorder.Code)
	}
}

func TestNoAccountsReturns503(t *testing.T) {
	world := newGateway(t, "http://127.0.0.1:1", keyauth.Config{})
	recorder := postChat(t, world.handler, `{"model":"gpt-test"}`)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("期望 503，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "NO_ELIGIBLE_ACCOUNT") {
		t.Fatalf("错误码不对：%s", recorder.Body.String())
	}
}

func TestStreamPassThrough(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		_, _ = io.WriteString(w, "data: {\"delta\":\"你\"}\n\n")
		flusher.Flush()
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
		flusher.Flush()
	}))
	defer upstream.Close()

	world := newGateway(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "token-1",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postChat(t, world.handler, `{"model":"gpt-test","stream":true,"messages":[]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Content-Type") != "text/event-stream" {
		t.Fatalf("Content-Type 不对：%s", recorder.Header().Get("Content-Type"))
	}
	if !strings.Contains(recorder.Body.String(), "data: [DONE]") {
		t.Fatalf("流内容不对：%q", recorder.Body.String())
	}
}

func TestUpstreamErrorIsSanitized(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `{"error":{"message":"token-1 is invalid"}}`)
	}))
	defer upstream.Close()

	world := newGateway(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "token-1",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postChat(t, world.handler, `{"model":"gpt-test"}`)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("期望 502，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "token-1") {
		t.Fatalf("错误响应泄漏了令牌：%s", recorder.Body.String())
	}
}

func TestHealthz(t *testing.T) {
	world := newGateway(t, "http://127.0.0.1:1", keyauth.Config{})
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	recorder := httptest.NewRecorder()
	world.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d", recorder.Code)
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("healthz 不是 JSON：%v", err)
	}
	if payload["status"] != "ok" {
		t.Fatalf("healthz 内容不对：%s", recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "token") {
		t.Fatalf("healthz 不应包含任何令牌字段：%s", recorder.Body.String())
	}
}

func TestConcurrentRequestsWithSnapshotReplace(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"ok"}`)
	}))
	defer upstream.Close()

	world := newGateway(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "token-1",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	var wg sync.WaitGroup
	for writer := 0; writer < 2; writer++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := 0; index < 50; index++ {
				_, _ = world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
					AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: fmt.Sprintf("token-%d", index),
				}))
			}
		}()
	}
	for reader := 0; reader < 8; reader++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := 0; index < 20; index++ {
				request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{"model":"gpt-test"}`))
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Authorization", "Bearer gateway-key")
				recorder := httptest.NewRecorder()
				world.handler.ServeHTTP(recorder, request)
				if recorder.Code != http.StatusOK {
					t.Errorf("并发请求失败：%d %s", recorder.Code, recorder.Body.String())
					return
				}
			}
		}()
	}
	wg.Wait()
}

func TestChatCompletionsAcceptsDynamicAPIKeyAndRejectsStaticFallback(t *testing.T) {
	var seen []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chatcmpl-dynamic"}`)
	}))
	defer upstream.Close()

	secret := "dz-dynamic-key-value"
	sum := sha256.Sum256([]byte(secret))
	keyCache := apikeys.New()
	if _, err := keyCache.Replace(apikeys.Snapshot{
		Version: apikeys.SnapshotVersion,
		Keys: []apikeys.Key{{
			KeyID:   "key-dynamic-1",
			UserID:  42,
			KeyHash: hex.EncodeToString(sum[:]),
			Profile: "billed",
			Name:    "default",
		}},
	}); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	world := newGateway(t, upstream.URL, keyauth.Config{
		Keys:     []string{"gateway-key"},
		Verifier: keyCache,
	})
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "token-1",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	ok := postChatWithKey(t, world.handler, `{"model":"gpt-test","messages":[]}`, secret)
	if ok.Code != http.StatusOK {
		t.Fatalf("动态 key 应通过鉴权，得到 %d：%s", ok.Code, ok.Body.String())
	}
	if len(seen) != 1 || seen[0] != "Bearer token-1" {
		t.Fatalf("上游应收到账号令牌而不是网关 key：%v", seen)
	}

	// 快照非空时，环境变量静态 key 不能作为回退路径。
	rejected := postChatWithKey(t, world.handler, `{"model":"gpt-test","messages":[]}`, "gateway-key")
	if rejected.Code != http.StatusUnauthorized {
		t.Fatalf("快照非空时静态 key 必须 401，得到 %d：%s", rejected.Code, rejected.Body.String())
	}
	if strings.Contains(rejected.Body.String(), secret) {
		t.Fatal("错误响应泄漏了 API key")
	}
}

func TestEmptyKeySnapshotRevokesPreviouslyAcceptedKeys(t *testing.T) {
	var seen []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chatcmpl-revoked"}`)
	}))
	defer upstream.Close()

	secret := "dz-revocable-key"
	sum := sha256.Sum256([]byte(secret))
	keyCache := apikeys.New()
	if _, err := keyCache.Replace(apikeys.Snapshot{
		Version: apikeys.SnapshotVersion,
		Keys: []apikeys.Key{{
			KeyID:   "key-revocable",
			UserID:  42,
			KeyHash: hex.EncodeToString(sum[:]),
			Profile: "billed",
			Name:    "revocable",
		}},
	}); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	world := newGateway(t, upstream.URL, keyauth.Config{
		Keys:     []string{"gateway-key"},
		Verifier: keyCache,
	})
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "token-1",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	accepted := postChatWithKey(t, world.handler, `{"model":"gpt-test","messages":[]}`, secret)
	if accepted.Code != http.StatusOK {
		t.Fatalf("撤销前 key 应通过，得到 %d：%s", accepted.Code, accepted.Body.String())
	}
	if len(seen) != 1 {
		t.Fatalf("撤销前请求应到达上游：%v", seen)
	}

	// api-key 服务被禁用/卸载后，account-priority 推空快照；Go 必须进入
	// Ready=true / Count=0 的 fail-closed 状态，而不是回退 env 或占位。
	if _, err := keyCache.Replace(apikeys.Snapshot{
		Version:    apikeys.SnapshotVersion,
		Generation: 2,
		Keys:       []apikeys.Key{},
	}); err != nil {
		t.Fatalf("Replace empty: %v", err)
	}
	if !keyCache.Ready() || keyCache.Count() != 0 {
		t.Fatalf("空快照后应为 Ready=true / Count=0：ready=%v count=%d",
			keyCache.Ready(), keyCache.Count())
	}

	for _, key := range []string{secret, "gateway-key"} {
		rejected := postChatWithKey(t, world.handler, `{"model":"gpt-test","messages":[]}`, key)
		if rejected.Code != http.StatusUnauthorized {
			t.Fatalf("空快照后 %q 必须 401，得到 %d：%s",
				key, rejected.Code, rejected.Body.String())
		}
	}
	if len(seen) != 1 {
		t.Fatalf("被撤销的 key 不应到达上游：%v", seen)
	}
}
