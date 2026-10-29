package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// newTestClient 造一个指向测试服务器的客户端。
func newTestClient(t *testing.T, server *httptest.Server, options ClientOptions) *Client {
	t.Helper()
	options.BaseURL = server.URL
	client, err := NewClient(options)
	if err != nil {
		t.Fatalf("构造客户端失败：%v", err)
	}
	return client
}

// TestBearerPath 断言 /v1/* 走 Authorization: Bearer，**不带**会话 cookie。
func TestBearerPath(t *testing.T) {
	var gotAuth string
	var gotCookie string
	var gotRequestedWith string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotCookie = r.Header.Get("Cookie")
		gotRequestedWith = r.Header.Get("X-Requested-With")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[]}`))
	}))
	defer server.Close()

	client := newTestClient(t, server, ClientOptions{APIKey: "sk-test-key"})
	if err := client.DoJSON(Request{Method: "GET", Path: "/v1/models"}, nil); err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if gotAuth != "Bearer sk-test-key" {
		t.Fatalf("Authorization 头不对：%q", gotAuth)
	}
	if gotCookie != "" {
		t.Fatalf("Bearer 路径不该带 cookie：%q", gotCookie)
	}
	if gotRequestedWith != "" {
		t.Fatalf("Bearer 路径不该带 X-Requested-With：%q", gotRequestedWith)
	}
}

// TestSessionPath 断言 /api/* 走 cookie + X-Requested-With，**不带** Bearer。
func TestSessionPath(t *testing.T) {
	var gotAuth string
	var gotCookie string
	var gotRequestedWith string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotCookie = r.Header.Get("Cookie")
		gotRequestedWith = r.Header.Get("X-Requested-With")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"state":"ok"}`))
	}))
	defer server.Close()

	client := newTestClient(t, server, ClientOptions{
		SessionToken:     "session-token",
		APIRequestHeader: true,
	})
	if err := client.DoJSON(Request{Method: "GET", Path: "/api/health"}, nil); err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if gotAuth != "" {
		t.Fatalf("会话路径不该带 Authorization：%q", gotAuth)
	}
	if !strings.Contains(gotCookie, sessionCookieName+"=session-token") {
		t.Fatalf("cookie 不对：%q", gotCookie)
	}
	if gotRequestedWith != apiRequestHeaderValue {
		t.Fatalf("X-Requested-With 必须是 %q，得到 %q", apiRequestHeaderValue, gotRequestedWith)
	}
}

// TestAPIRequestHeaderWithoutSession 断言**没有会话**时 /api/* 仍然带请求头。
//
// 这是登录、公开健康检查这类「还没有 cookie」的请求必须满足的条件：
// api 插件对**所有** /api/*（含 GET、含未登录）都校验它
// （packages/api/src/http.ts:279-288）。
func TestAPIRequestHeaderWithoutSession(t *testing.T) {
	var gotRequestedWith string
	var gotCookie string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRequestedWith = r.Header.Get("X-Requested-With")
		gotCookie = r.Header.Get("Cookie")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	client := newTestClient(t, server, ClientOptions{APIRequestHeader: true})
	if err := client.DoJSON(Request{Method: "POST", Path: "/api/auth/login"}, nil); err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if gotRequestedWith != apiRequestHeaderValue {
		t.Fatalf("没有会话时也必须带 X-Requested-With，得到 %q", gotRequestedWith)
	}
	if gotCookie != "" {
		t.Fatalf("没有会话时不该带 cookie：%q", gotCookie)
	}
}

// TestCaptureCookieFromSetCookie 断言登录能拿到 HttpOnly 会话 cookie。
//
// 会话 cookie **只在 Set-Cookie 头里**，不在 JSON 体里。
func TestCaptureCookieFromSetCookie(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{
			Name:     sessionCookieName,
			Value:    "captured-token",
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
		})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"user":{"id":1}}`))
	}))
	defer server.Close()

	client := newTestClient(t, server, ClientOptions{})
	response, err := client.Do(Request{
		Method:        "POST",
		Path:          "/api/auth/login",
		Body:          map[string]string{"email": "a@b.c", "password": "x"},
		CaptureCookie: sessionCookieName,
	})
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if response.Cookie != "captured-token" {
		t.Fatalf("没捕获到会话 cookie：%q", response.Cookie)
	}
}

// TestRequestIDHeaderCaptured 断言响应头 X-Request-Id 被捕获。
//
// 这个头由 Go 侧 `internal/httpapi` 产出（本批还没有，走独立分支）。CLI 只读：
// 有它就能把 chat 和 /api/usage 的那条记录精确对上。
func TestRequestIDHeaderCaptured(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Request-Id", "req-1793278671895159400-1")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl-1"}`))
	}))
	defer server.Close()

	client := newTestClient(t, server, ClientOptions{APIKey: "sk-test-key"})
	response, err := client.Do(Request{Method: "POST", Path: "/v1/chat/completions"})
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if response.RequestID != "req-1793278671895159400-1" {
		t.Fatalf("没捕获到 X-Request-Id：%q", response.RequestID)
	}
}

// TestRequestIDHeaderMissingDegrades 断言没有这个头时是空串，不是错误。
func TestRequestIDHeaderMissingDegrades(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl-1"}`))
	}))
	defer server.Close()

	client := newTestClient(t, server, ClientOptions{APIKey: "sk-test-key"})
	response, err := client.Do(Request{Method: "POST", Path: "/v1/chat/completions"})
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if response.RequestID != "" {
		t.Fatalf("没有该头时应为空串，得到 %q", response.RequestID)
	}
}

// TestUsageCostLookupUsesRequestID 断言费用回查打的是 `/api/usage/<reqId>`。
//
// 这是 A3 的核心：只认响应头给的请求 id，不再靠「模型 + 时间窗 + 最大 id」猜。
func TestUsageCostLookupUsesRequestID(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"record":{"reqId":"req-1-1","costMicros":"570"}}`))
	}))
	defer server.Close()

	client := newTestClient(t, server, ClientOptions{SessionToken: "s", APIRequestHeader: true})
	cost, ok := (&usageCostLookup{client: client, reqID: "req-1-1"}).once()
	if !ok || cost != "570" {
		t.Fatalf("应取到 570，得到 %q（ok=%v）", cost, ok)
	}
	if gotPath != "/api/usage/req-1-1" {
		t.Fatalf("回查路径不对：%q", gotPath)
	}
}

// TestUsageCostLookupRejectsOtherRecord 断言服务端回的不是这条时不采信。
func TestUsageCostLookupRejectsOtherRecord(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"record":{"reqId":"req-2-2","costMicros":"999"}}`))
	}))
	defer server.Close()

	client := newTestClient(t, server, ClientOptions{SessionToken: "s", APIRequestHeader: true})
	if cost, ok := (&usageCostLookup{client: client, reqID: "req-1-1"}).once(); ok {
		t.Fatalf("reqId 不匹配时不该采信，得到 %q", cost)
	}
}

// TestUsageCostLookupWithoutRequestIDIsImmediate 断言没有 reqId 时不发请求、不等待。
func TestUsageCostLookupWithoutRequestIDIsImmediate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("没有 reqId 时不该发请求")
	}))
	defer server.Close()

	client := newTestClient(t, server, ClientOptions{SessionToken: "s", APIRequestHeader: true})
	started := time.Now()
	if _, ok := (&usageCostLookup{client: client, reqID: ""}).cost(); ok {
		t.Fatal("没有 reqId 时应返回 false")
	}
	if elapsed := time.Since(started); elapsed > 200*time.Millisecond {
		t.Fatalf("没有 reqId 时不该轮询，耗时 %s", elapsed)
	}
}

// TestAPIErrorProductShape 断言 /api/* 的错误信封能被解析。
func TestAPIErrorProductShape(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"code":"API_UNAUTHORIZED","message":"需要登录","requestId":"req-1"}}`))
	}))
	defer server.Close()

	client := newTestClient(t, server, ClientOptions{})
	err := client.DoJSON(Request{Method: "GET", Path: "/api/session"}, nil)
	var apiError *APIError
	if !errors.As(err, &apiError) {
		t.Fatalf("应返回 APIError，得到 %v", err)
	}
	if apiError.Code != "API_UNAUTHORIZED" {
		t.Fatalf("code 不对：%q", apiError.Code)
	}
	if apiError.Message != "需要登录" {
		t.Fatalf("message 不对：%q", apiError.Message)
	}
	if apiError.RequestID != "req-1" {
		t.Fatalf("requestId 不对：%q", apiError.RequestID)
	}
	if apiError.ExitCode() != exitUnauthorized {
		t.Fatalf("401 的退出码应为 %d，得到 %d", exitUnauthorized, apiError.ExitCode())
	}
}

// TestAPIErrorGatewayShape 断言 /v1/* 的错误信封（OpenAI 形状）也能被解析。
func TestAPIErrorGatewayShape(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"message":"命中内容审核规则","type":"invalid_request_error","code":"CONTENT_BLOCKED"}}`))
	}))
	defer server.Close()

	client := newTestClient(t, server, ClientOptions{APIKey: "k"})
	err := client.DoJSON(Request{Method: "POST", Path: "/v1/chat/completions"}, nil)
	var apiError *APIError
	if !errors.As(err, &apiError) {
		t.Fatalf("应返回 APIError，得到 %v", err)
	}
	if apiError.Code != "CONTENT_BLOCKED" {
		t.Fatalf("code 不对：%q", apiError.Code)
	}
	if apiError.Message != "命中内容审核规则" {
		t.Fatalf("message 不对：%q", apiError.Message)
	}
	if apiError.ExitCode() != exitForbidden {
		t.Fatalf("403 的退出码应为 %d，得到 %d", exitForbidden, apiError.ExitCode())
	}
}

// TestAPIErrorNonJSON 断言非 JSON 错误体（HTML 错误页）不会 panic。
func TestAPIErrorNonJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`<html>502 Bad Gateway</html>`))
	}))
	defer server.Close()

	client := newTestClient(t, server, ClientOptions{APIKey: "k"})
	err := client.DoJSON(Request{Method: "GET", Path: "/v1/models"}, nil)
	var apiError *APIError
	if !errors.As(err, &apiError) {
		t.Fatalf("应返回 APIError，得到 %v", err)
	}
	if apiError.Status != http.StatusBadGateway {
		t.Fatalf("状态码不对：%d", apiError.Status)
	}
	if !strings.Contains(apiError.Message, "502") {
		t.Fatalf("消息应包含原始响应片段，得到 %q", apiError.Message)
	}
	if apiError.ExitCode() != exitUpstream {
		t.Fatalf("502 的退出码应为 %d，得到 %d", exitUpstream, apiError.ExitCode())
	}
}

// TestExitCodeMapping 断言状态码 → 退出码的映射。
func TestExitCodeMapping(t *testing.T) {
	cases := []struct {
		status int
		want   int
	}{
		{http.StatusUnauthorized, exitUnauthorized},
		{http.StatusForbidden, exitForbidden},
		{http.StatusNotFound, exitNotFound},
		{http.StatusPaymentRequired, exitPaymentRequired},
		{http.StatusTooManyRequests, exitRateLimited},
		{http.StatusBadRequest, exitUsage},
		{http.StatusConflict, exitUsage},
		{http.StatusInternalServerError, exitUpstream},
		{http.StatusBadGateway, exitUpstream},
		{http.StatusServiceUnavailable, exitUpstream},
	}
	for _, testCase := range cases {
		err := &APIError{Status: testCase.status}
		if got := err.ExitCode(); got != testCase.want {
			t.Fatalf("%d 的退出码应为 %d，得到 %d", testCase.status, testCase.want, got)
		}
	}
}

// TestExitCodeOfCredentialsMissing 断言没登录给专用退出码。
func TestExitCodeOfCredentialsMissing(t *testing.T) {
	if got := exitCodeOf(ErrCredentialsMissing); got != exitNotLoggedIn {
		t.Fatalf("没登录的退出码应为 %d，得到 %d", exitNotLoggedIn, got)
	}
	if got := exitCodeOf(nil); got != exitSuccess {
		t.Fatalf("nil 的退出码应为 0，得到 %d", got)
	}
	if got := exitCodeOf(errors.New("普通错误")); got != exitFailure {
		t.Fatalf("普通错误的退出码应为 %d，得到 %d", exitFailure, got)
	}
}

// TestRequestSendsJSONBody 断言请求体是 JSON 且带 Content-Type。
func TestRequestSendsJSONBody(t *testing.T) {
	var gotContentType string
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotContentType = r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	client := newTestClient(t, server, ClientOptions{APIKey: "k"})
	err := client.DoJSON(Request{
		Method: "POST",
		Path:   "/v1/chat/completions",
		Body:   map[string]any{"model": "m", "messages": []any{}},
	}, nil)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if gotContentType != "application/json" {
		t.Fatalf("Content-Type 不对：%q", gotContentType)
	}
	if gotBody["model"] != "m" {
		t.Fatalf("请求体不对：%v", gotBody)
	}
}

// TestRequestSendsQuery 断言查询串被正确编码。
func TestRequestSendsQuery(t *testing.T) {
	var gotQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	client := newTestClient(t, server, ClientOptions{SessionToken: "t"})
	values := url.Values{}
	values.Set("range", "7d")
	values.Set("limit", "20")
	if err := client.DoJSON(Request{Method: "GET", Path: "/api/usage", Query: values}, nil); err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if !strings.Contains(gotQuery, "range=7d") || !strings.Contains(gotQuery, "limit=20") {
		t.Fatalf("查询串不对：%q", gotQuery)
	}
}

// TestURLJoinsBasePath 断言带路径前缀的 base 也能拼对。
func TestURLJoinsBasePath(t *testing.T) {
	client, err := NewClient(ClientOptions{BaseURL: "https://example.com/gw"})
	if err != nil {
		t.Fatalf("构造失败：%v", err)
	}
	got := client.URL("/api/health", nil)
	if got != "https://example.com/gw/api/health" {
		t.Fatalf("拼接结果不对：%q", got)
	}
}

// TestNewClientRejectsBadBase 断言非法 base 明确失败，不静默降级。
func TestNewClientRejectsBadBase(t *testing.T) {
	for _, base := range []string{"", "example.com", "ftp://x", "https://"} {
		if _, err := NewClient(ClientOptions{BaseURL: base}); err == nil {
			t.Fatalf("base %q 应被拒绝", base)
		}
	}
}
