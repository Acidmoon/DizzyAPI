package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/modules/keyauth"
)

// requestIDHeader 读响应头 X-Request-Id，并要求它非空。
func requestIDHeader(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	value := recorder.Header().Get(requestIDHeaderName)
	if value == "" {
		t.Fatalf("响应缺少 %s 头（状态 %d）：%s", requestIDHeaderName, recorder.Code, recorder.Body.String())
	}
	if !strings.HasPrefix(value, "req-") {
		t.Fatalf("%s 形状不对：%q", requestIDHeaderName, value)
	}
	return value
}

// TestRequestIDHeaderMatchesUsageRecord 断言成功响应的头与那次用量记录的 reqId 一致。
//
// 这是 CLI 精确对账（`dizzy chat` 的花费 → `/api/usage/:reqId`）的唯一依据：
// 头与记录必须是同一个 id，否则客户端会查到别人那条。
func TestRequestIDHeaderMatchesUsageRecord(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chatcmpl-1","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}`)
	}))
	defer upstream.Close()

	world, sink := newUsageGateway(t, keyauth.Config{}, nil)
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "t", Priority: 1,
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postChat(t, world.handler, `{"model":"gpt-test","messages":[{"role":"user","content":"hi"}]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	header := requestIDHeader(t, recorder)
	record := sink.single(t)
	if header != record.RequestID {
		t.Fatalf("响应头 %q 与用量记录的 RequestID %q 不一致", header, record.RequestID)
	}
}

// TestRequestIDHeaderOnStream 断言流式响应也带同一个头。
func TestRequestIDHeaderOnStream(t *testing.T) {
	const sse = "data: {\"id\":\"c1\",\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\n" +
		"data: {\"id\":\"c1\",\"model\":\"gpt-test\",\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n" +
		"data: [DONE]\n\n"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, sse)
	}))
	defer upstream.Close()

	world, sink := newUsageGateway(t, keyauth.Config{}, nil)
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "t", Priority: 1,
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postChat(t, world.handler,
		`{"model":"gpt-test","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	header := requestIDHeader(t, recorder)
	if record := sink.single(t); header != record.RequestID {
		t.Fatalf("流式响应头 %q 与用量记录 %q 不一致", header, record.RequestID)
	}
	if recorder.Body.String() != sse {
		t.Fatal("流式响应体必须逐字节原样透传（加头不能改体）")
	}
}

// TestRequestIDHeaderDoesNotChangeErrorBody 断言错误体逐字节不变、且照样带头。
//
// 早期拒绝（JSON 非法）在拿到真实 requestID 之前就返回了，所以头里是 aux id；
// 关键约束是「响应体一个字节都不变」。
func TestRequestIDHeaderDoesNotChangeErrorBody(t *testing.T) {
	world, sink := newUsageGateway(t, keyauth.Config{}, nil)
	recorder := postChat(t, world.handler, `{not json`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("期望 400，得到 %d", recorder.Code)
	}
	want := `{"error":{"code":"INVALID_REQUEST","message":"请求体必须是合法 JSON","type":"invalid_request_error"}}`
	if recorder.Body.String() != want {
		t.Fatalf("错误体变了：\n得到 %s\n期望 %s", recorder.Body.String(), want)
	}
	requestIDHeader(t, recorder)
	if records := sink.all(t); len(records) != 0 {
		t.Fatalf("被拒请求不该产生用量记录，得到 %d 条", len(records))
	}
}

// TestRequestIDHeaderOnEngineError 断言引擎侧错误（RenderError）也带真实请求 id。
//
// 401 来自 keyauth 阶段：它没有 Ctx.Key，所以**不产生用量记录**，但请求 id
// 已经分配好了，头里必须是那个（不是 aux id）。
func TestRequestIDHeaderOnEngineError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("未鉴权的请求不应到达上游")
	}))
	defer upstream.Close()

	world, _ := newUsageGateway(t, keyauth.Config{Keys: []string{"right-key"}}, nil)
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "t", Priority: 1,
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	recorder := postWithHeaders(t, world.handler, "/v1/chat/completions",
		`{"model":"gpt-test","messages":[]}`,
		map[string]string{"Authorization": "Bearer wrong-key"})
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("期望 401，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	requestIDHeader(t, recorder)
}

// TestRequestIDHeaderOnModelsAndHealth 断言 /v1/models 与 /healthz 也带头，
// 并且健康检查不会把 /healthz 里的 LLM 请求计数弄脏。
func TestRequestIDHeaderOnModelsAndHealth(t *testing.T) {
	world, _ := newUsageGateway(t, keyauth.Config{}, nil)

	models := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	request.Header.Set("Authorization", "Bearer gateway-key")
	world.handler.ServeHTTP(models, request)
	if models.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", models.Code, models.Body.String())
	}
	requestIDHeader(t, models)

	healthBody := func() map[string]any {
		recorder := httptest.NewRecorder()
		world.handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/healthz", nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("期望 200，得到 %d", recorder.Code)
		}
		requestIDHeader(t, recorder)
		var payload map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("解析 /healthz 响应失败：%v", err)
		}
		return payload
	}

	before := healthBody()
	healthBody()
	healthBody()
	after := healthBody()
	if before["requests"] != after["requests"] {
		t.Fatalf("健康检查把自己的请求算进了 LLM 请求数：%v → %v", before["requests"], after["requests"])
	}
}
