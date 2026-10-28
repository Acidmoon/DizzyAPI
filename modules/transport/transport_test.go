package transport

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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
	}, nil)
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
	stage, err := New(Config{}, staticSource{}, nil)
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

// ───────────────────────────── 限流 / 额度耗尽 → 冷却回报 ─────────────────────────────

type limitRecorder struct {
	mu       sync.Mutex
	accounts []string
}

func (r *limitRecorder) RecordLimit(accountID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.accounts = append(r.accounts, accountID)
}

func (r *limitRecorder) recorded() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.accounts...)
}

func upstreamStatus(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestRateLimitRecordsCooldownAndIsRetryable(t *testing.T) {
	recorder := &limitRecorder{}
	upstream := upstreamStatus(t, http.StatusTooManyRequests, `{"error":{"message":"rate limited"}}`)
	stage := newStage(t, upstream.URL, "sk-upstream", Config{LimitRecorder: recorder})

	_, err := stage.Run(requestContext(false))
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) || !stageErr.Retryable || stageErr.Code != "UPSTREAM_RATE_LIMITED" {
		t.Fatalf("429 必须可重试且带 UPSTREAM_RATE_LIMITED，得到 %v", err)
	}
	if got := recorder.recorded(); len(got) != 1 || got[0] != "acc-1" {
		t.Fatalf("429 必须给该账号记冷却：%v", got)
	}
}

func TestQuotaExhaustedRecordsCooldownAndIsRetryable(t *testing.T) {
	recorder := &limitRecorder{}
	upstream := upstreamStatus(t, http.StatusBadRequest,
		`{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}`)
	stage := newStage(t, upstream.URL, "sk-upstream", Config{LimitRecorder: recorder})

	_, err := stage.Run(requestContext(false))
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) || !stageErr.Retryable {
		t.Fatalf("额度耗尽必须可重试（换账号），得到 %v", err)
	}
	if stageErr.Code != "UPSTREAM_QUOTA_EXHAUSTED" {
		t.Fatalf("额度耗尽的错误码 = %q，期望 UPSTREAM_QUOTA_EXHAUSTED", stageErr.Code)
	}
	if got := recorder.recorded(); len(got) != 1 || got[0] != "acc-1" {
		t.Fatalf("额度耗尽必须给该账号记冷却：%v", got)
	}
}

func TestOrdinaryUpstreamErrorsDoNotRecordCooldown(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
	}{
		{"invalid request", http.StatusBadRequest, `{"error":{"message":"missing model"}}`},
		{"auth", http.StatusForbidden, `{"error":{"message":"forbidden"}}`},
		{"server error", http.StatusInternalServerError, `{"error":{"message":"boom"}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := &limitRecorder{}
			upstream := upstreamStatus(t, tc.status, tc.body)
			stage := newStage(t, upstream.URL, "sk-upstream", Config{LimitRecorder: recorder})
			if _, err := stage.Run(requestContext(false)); err == nil {
				t.Fatal("期望错误")
			}
			if got := recorder.recorded(); len(got) != 0 {
				t.Fatalf("%s 不该记冷却：%v", tc.name, got)
			}
		})
	}
}

func TestNilLimitRecorderIsSafe(t *testing.T) {
	upstream := upstreamStatus(t, http.StatusTooManyRequests, `{"error":{"message":"rate limited"}}`)
	stage := newStage(t, upstream.URL, "sk-upstream", Config{})
	if _, err := stage.Run(requestContext(false)); err == nil {
		t.Fatal("429 必须返回错误")
	}
}
