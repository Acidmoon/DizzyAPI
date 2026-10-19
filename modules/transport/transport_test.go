package transport

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

type staticSource map[string]contracts.AccountCredential

func (s staticSource) Credential(id string) (contracts.AccountCredential, bool) {
	credential, ok := s[id]
	return credential, ok
}

func requestContext(stream bool) *contracts.Ctx {
	return &contracts.Ctx{
		Context: context.Background(),
		ReqID:   "req-test",
		Meta:    contracts.RequestMeta{Model: "gpt-test", Stream: stream},
		Headers: http.Header{"Authorization": []string{"Bearer gateway-secret"}},
		Body:    contracts.BytesBody([]byte(`{"model":"gpt-test","messages":[]}`)),
		AccountRoute: &contracts.AccountRoute{
			Picked: &contracts.ScoredAccount{AccountID: "acc-1"},
		},
	}
}

func newStage(t *testing.T, baseURL, token string, cfg Config) *Stage {
	t.Helper()
	stage, err := New(cfg, staticSource{
		"acc-1": {
			AccountID:   "acc-1",
			Provider:    "openai",
			Kind:        "api_key",
			BaseURL:     baseURL,
			AccessToken: token,
		},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return stage
}

func TestNonStreamSuccess(t *testing.T) {
	var seenAuthorization string
	var seenAccept string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("路径不对：%s", r.URL.Path)
		}
		seenAuthorization = r.Header.Get("Authorization")
		seenAccept = r.Header.Get("Accept")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl-1","choices":[]}`))
	}))
	defer upstream.Close()

	stage := newStage(t, upstream.URL+"/v1", "sk-upstream", Config{})
	decision, err := stage.Run(requestContext(false))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if decision.Status != 200 || !strings.Contains(string(decision.Body), "chatcmpl-1") {
		t.Fatalf("响应不对：%+v", decision)
	}
	if decision.Headers["Content-Type"] != "application/json" {
		t.Fatalf("Content-Type 没有透传：%+v", decision.Headers)
	}
	if seenAuthorization != "Bearer sk-upstream" {
		t.Fatalf("上游 Authorization 不对：%q", seenAuthorization)
	}
	if strings.Contains(seenAuthorization, "gateway-secret") {
		t.Fatal("网关密钥被转发到了上游")
	}
	if seenAccept != "application/json" {
		t.Fatalf("Accept 不对：%q", seenAccept)
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

	stage := newStage(t, upstream.URL, "sk-upstream", Config{})
	decision, err := stage.Run(requestContext(true))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if decision.Stream == nil {
		t.Fatal("流式响应必须返回 Stream")
	}
	defer decision.Stream.Close()
	payload, err := io.ReadAll(decision.Stream)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if !strings.Contains(string(payload), "data: [DONE]") {
		t.Fatalf("流内容不对：%q", payload)
	}
	if decision.Headers["Content-Type"] != "text/event-stream" {
		t.Fatalf("流式 Content-Type 不对：%+v", decision.Headers)
	}
}

func TestUpstreamErrorIsRetryableAndRedacted(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"upstream rejected token sk-upstream"}}`))
	}))
	defer upstream.Close()

	stage := newStage(t, upstream.URL, "sk-upstream", Config{})
	_, err := stage.Run(requestContext(false))
	if err == nil {
		t.Fatal("期望错误")
	}
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) {
		t.Fatalf("错误类型不对：%T", err)
	}
	if stageErr.Code != "UPSTREAM_ERROR" || !stageErr.Retryable || stageErr.Status != http.StatusBadGateway {
		t.Fatalf("错误映射不对：%+v", stageErr)
	}
	if strings.Contains(stageErr.Message, "sk-upstream") {
		t.Fatalf("错误消息泄漏了令牌：%s", stageErr.Message)
	}
}

func TestUpstreamAuthErrorDoesNotLeakBody(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"bad key sk-upstream for user alice@example.com"}}`))
	}))
	defer upstream.Close()

	stage := newStage(t, upstream.URL, "sk-upstream", Config{})
	_, err := stage.Run(requestContext(false))
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) {
		t.Fatalf("错误类型不对：%T", err)
	}
	if stageErr.Status != http.StatusBadGateway || stageErr.Code != "UPSTREAM_AUTH_FAILED" {
		t.Fatalf("认证错误映射不对：%+v", stageErr)
	}
	if strings.Contains(stageErr.Message, "sk-upstream") || strings.Contains(stageErr.Message, "alice") {
		t.Fatalf("认证错误正文被透传：%s", stageErr.Message)
	}
}

func TestMissingCredentialIsRetryable(t *testing.T) {
	stage, err := New(Config{}, staticSource{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = stage.Run(requestContext(false))
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) || !stageErr.Retryable || stageErr.Code != "ACCOUNT_UNAVAILABLE" {
		t.Fatalf("期望可重试的账号不可用错误，得到 %v", err)
	}
}

func TestClientCancellation(t *testing.T) {
	blocked := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-blocked
	}))
	defer func() {
		close(blocked)
		upstream.Close()
	}()

	stage := newStage(t, upstream.URL, "sk-upstream", Config{})
	ctx, cancel := context.WithCancel(context.Background())
	request := requestContext(false)
	request.Context = ctx
	cancel()

	_, err := stage.Run(request)
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) || stageErr.Code != "CLIENT_CANCELED" {
		t.Fatalf("期望 CLIENT_CANCELED，得到 %v", err)
	}
}

func TestHeaderTimeoutIsRetryable(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
	}))
	defer upstream.Close()

	stage := newStage(t, upstream.URL, "sk-upstream", Config{HeaderTimeoutMs: 50})
	_, err := stage.Run(requestContext(false))
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) || !stageErr.Retryable || stageErr.Code != "UPSTREAM_TIMEOUT" {
		t.Fatalf("期望 UPSTREAM_TIMEOUT，得到 %v", err)
	}
}

func TestJoinURL(t *testing.T) {
	cases := []struct {
		base string
		want string
	}{
		{"https://api.example.com", "https://api.example.com/chat/completions"},
		{"https://api.example.com/v1/", "https://api.example.com/v1/chat/completions"},
		{"https://api.example.com/v1/chat/completions", "https://api.example.com/v1/chat/completions"},
	}
	for _, tc := range cases {
		got, err := joinURL(tc.base, "/chat/completions")
		if err != nil {
			t.Fatalf("joinURL(%q): %v", tc.base, err)
		}
		if got != tc.want {
			t.Fatalf("joinURL(%q) = %q，期望 %q", tc.base, got, tc.want)
		}
	}
}
