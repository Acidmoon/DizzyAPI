package transport

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// embeddings 与 chat 同属 OpenAI 兼容族，但路径不同：按请求级操作类型选
// 方言的 EmbeddingsPath，而不是新造一个 Protocol。

func embeddingsStage(t *testing.T, upstream *httptest.Server, protocol contracts.Protocol) *Stage {
	t.Helper()
	stage, err := New(Config{}, staticSource{
		"acc-1": {
			AccountID:   "acc-1",
			Provider:    "openai",
			Kind:        "api_key",
			BaseURL:     upstream.URL + "/v1",
			AccessToken: "sk-emb",
			Protocol:    string(protocol),
		},
	}, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return stage
}

func embeddingsRequest() *contracts.Ctx {
	return &contracts.Ctx{
		Context:   context.Background(),
		ReqID:     "req-embeddings",
		Meta:      contracts.RequestMeta{Model: "text-embedding-3-small"},
		Body:      contracts.BytesBody([]byte(`{"model":"text-embedding-3-small","input":"hi"}`)),
		Operation: contracts.OperationEmbeddings,
		AccountRoute: &contracts.AccountRoute{
			Picked: &contracts.ScoredAccount{AccountID: "acc-1"},
		},
	}
}

func TestEmbeddingsUsesEmbeddingsPath(t *testing.T) {
	for _, protocol := range []contracts.Protocol{contracts.ProtocolOpenAIChat, contracts.ProtocolOpenAIResponses} {
		var seenPath, seenAuth, seenBody string
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			seenPath = r.URL.Path
			seenAuth = r.Header.Get("Authorization")
			raw := make([]byte, r.ContentLength)
			_, _ = r.Body.Read(raw)
			seenBody = string(raw)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"object":"list","data":[]}`))
		}))

		stage := embeddingsStage(t, upstream, protocol)
		ctx := embeddingsRequest()
		decision, err := stage.Run(ctx)
		if err != nil {
			t.Fatalf("%s：Run: %v", protocol, err)
		}
		if seenPath != "/v1/embeddings" {
			t.Fatalf("%s：上游路径 %q，期望 /v1/embeddings", protocol, seenPath)
		}
		if seenAuth != "Bearer sk-emb" {
			t.Fatalf("%s：鉴权头不对：%q", protocol, seenAuth)
		}
		// 同协议直通：body 一个字节都不改。
		if seenBody != `{"model":"text-embedding-3-small","input":"hi"}` {
			t.Fatalf("%s：body 被改了：%q", protocol, seenBody)
		}
		if decision.Action != contracts.ActionRespond || decision.Status != http.StatusOK {
			t.Fatalf("%s：decision 不符：%+v", protocol, decision)
		}
		upstream.Close()
	}
}

// 未声明协议（旧快照）= OpenAI 兼容：embeddings 也必须可用。
func TestEmbeddingsAllowsUndeclaredProtocol(t *testing.T) {
	var seenPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[]}`))
	}))
	defer upstream.Close()

	stage := embeddingsStage(t, upstream, contracts.Protocol(""))
	if _, err := stage.Run(embeddingsRequest()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if seenPath != "/v1/embeddings" {
		t.Fatalf("上游路径 %q，期望 /v1/embeddings", seenPath)
	}
}

// anthropic / gemini 没有 embeddings 端点：明确拒绝（不可重试），不请求上游。
func TestEmbeddingsRejectsNonOpenAIUpstream(t *testing.T) {
	for _, protocol := range []contracts.Protocol{contracts.ProtocolAnthropic, contracts.ProtocolGemini} {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Errorf("%s 账号不该收到 embeddings 请求：%s", protocol, r.URL.Path)
		}))

		stage := embeddingsStage(t, upstream, protocol)
		_, err := stage.Run(embeddingsRequest())
		var stageErr *contracts.StageError
		if !errors.As(err, &stageErr) {
			t.Fatalf("%s：期望明确失败，得到 %v", protocol, err)
		}
		if stageErr.Code != "MODEL_NOT_SUPPORTED" {
			t.Fatalf("%s：错误码 %q，期望 MODEL_NOT_SUPPORTED", protocol, stageErr.Code)
		}
		if stageErr.Status != http.StatusBadRequest || stageErr.Retryable {
			t.Fatalf("%s：期望 400 且不可重试：%+v", protocol, stageErr)
		}
		upstream.Close()
	}
}

// 回归：零值操作类型（chat）仍然走 chat 路径。
func TestChatOperationUnchanged(t *testing.T) {
	var seenPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"c1","choices":[]}`))
	}))
	defer upstream.Close()

	stage := embeddingsStage(t, upstream, contracts.ProtocolOpenAIChat)
	ctx := requestContext(false)
	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if seenPath != "/v1/chat/completions" {
		t.Fatalf("零值操作类型必须等于 chat：%q", seenPath)
	}
}
