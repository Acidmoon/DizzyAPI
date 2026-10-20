package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/apikeys"
	"github.com/Acidmoon/DizzyAPI/internal/engine"
	"github.com/Acidmoon/DizzyAPI/modules/accountpriority"
	"github.com/Acidmoon/DizzyAPI/modules/keyauth"
	"github.com/Acidmoon/DizzyAPI/modules/transport"
)

func getModels(t *testing.T, handler http.Handler, key string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	if key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func modelsWith(id string, models ...string) accounts.Account {
	return accounts.Account{
		AccountID: id,
		Provider:  "openai",
		Kind:      "api_key",
		Token:     "token-" + id,
		Models:    models,
	}
}

func TestModelsEndpointReturnsUnion(t *testing.T) {
	world := newGateway(t, "http://127.0.0.1:1", keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot("http://127.0.0.1:1",
		modelsWith("acc-1", "gpt-4o", "claude-sonnet-4-5"),
		modelsWith("acc-2", "claude-sonnet-4-5", "gpt-4o-mini"),
	)); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := getModels(t, world.handler, "gateway-key")
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}

	var payload struct {
		Object string `json:"object"`
		Data   []struct {
			ID      string `json:"id"`
			Object  string `json:"object"`
			Created int64  `json:"created"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是 JSON：%v", err)
	}
	if payload.Object != "list" {
		t.Fatalf("object 应为 list：%s", payload.Object)
	}
	ids := make([]string, 0, len(payload.Data))
	for _, entry := range payload.Data {
		ids = append(ids, entry.ID)
		if entry.Object != "model" || entry.OwnedBy != "dizzyapi" || entry.Created == 0 {
			t.Fatalf("条目形状不对：%+v", entry)
		}
	}
	if strings.Join(ids, ",") != "claude-sonnet-4-5,gpt-4o,gpt-4o-mini" {
		t.Fatalf("模型列表不对：%v", ids)
	}

	// 不得泄漏账号 id / baseUrl / 令牌。
	for _, secret := range []string{"acc-1", "acc-2", "token-acc-1", "token-acc-2", "127.0.0.1"} {
		if strings.Contains(recorder.Body.String(), secret) {
			t.Fatalf("响应泄漏了 %q：%s", secret, recorder.Body.String())
		}
	}
}

func TestModelsEmptySnapshotReturnsEmptyList(t *testing.T) {
	world := newGateway(t, "http://127.0.0.1:1", keyauth.Config{})
	recorder := getModels(t, world.handler, "gateway-key")
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), `"data":[]`) {
		t.Fatalf("空列表应序列化为 []：%s", recorder.Body.String())
	}
}

func TestModelsRequiresAPIKey(t *testing.T) {
	world := newGateway(t, "http://127.0.0.1:1", keyauth.Config{Keys: []string{"valid-key"}})

	if recorder := getModels(t, world.handler, ""); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("缺 key 应 401，得到 %d", recorder.Code)
	}
	if recorder := getModels(t, world.handler, "wrong-key"); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("错误 key 应 401，得到 %d", recorder.Code)
	}
	if recorder := getModels(t, world.handler, "valid-key"); recorder.Code != http.StatusOK {
		t.Fatalf("正确 key 应 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
}

func TestModelsAuthMatchesLLMEntry(t *testing.T) {
	secret := "dz-models-dynamic"
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

	world := newGateway(t, "http://127.0.0.1:1", keyauth.Config{
		Keys:     []string{"gateway-key"},
		Verifier: keyCache,
	})

	if recorder := getModels(t, world.handler, secret); recorder.Code != http.StatusOK {
		t.Fatalf("动态 key 应通过，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if recorder := getModels(t, world.handler, "gateway-key"); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("快照非空时静态 key 必须 401，得到 %d", recorder.Code)
	}

	// 空快照 fail-closed：全部拒绝，绝不回退。
	if _, err := keyCache.Replace(apikeys.Snapshot{
		Version:    apikeys.SnapshotVersion,
		Generation: 2,
		Keys:       []apikeys.Key{},
	}); err != nil {
		t.Fatalf("Replace empty: %v", err)
	}
	for _, key := range []string{secret, "gateway-key"} {
		if recorder := getModels(t, world.handler, key); recorder.Code != http.StatusUnauthorized {
			t.Fatalf("空快照后 %q 必须 401，得到 %d", key, recorder.Code)
		}
	}
}

func TestModelsWithoutAuthorizerIsServiceUnavailable(t *testing.T) {
	cache := accounts.New()
	registry := contracts.NewRegistry()
	if _, err := accountpriority.Register(registry, accountpriority.Config{}); err != nil {
		t.Fatalf("accountpriority.Register: %v", err)
	}
	if _, err := transport.Register(registry, transport.Config{}, cache, nil); err != nil {
		t.Fatalf("transport.Register: %v", err)
	}
	requestEngine, err := engine.New(registry.Stages(), nil)
	if err != nil {
		t.Fatalf("engine.New: %v", err)
	}
	server, err := New(requestEngine, cache, nil, Config{}) // 没有 Authorizer
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}

	recorder := getModels(t, server.Handler(), "gateway-key")
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("没有鉴权器应 fail-closed 503，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
}

func TestModelsRejectsNonGET(t *testing.T) {
	world := newGateway(t, "http://127.0.0.1:1", keyauth.Config{})
	request := httptest.NewRequest(http.MethodPost, "/v1/models", strings.NewReader("{}"))
	recorder := httptest.NewRecorder()
	world.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /v1/models 应 405，得到 %d", recorder.Code)
	}
}
