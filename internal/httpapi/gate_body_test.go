package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accountruntime"
	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/engine"
	"github.com/Acidmoon/DizzyAPI/modules/accountpriority"
)

// 这两个用例是本线的验收口径：闸门拒绝的稳定错误码必须能被**客户端从响应体里读到**，
// 而不只是断言 StageError。真实链路（httpapi → engine → accountpriority）跑一遍，
// 并证明请求没有进入 dispatch：不排队、不放行、不换号重试。

// llmErrorPayload 是 OpenAI 兼容错误体。
type llmErrorPayload struct {
	Error struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    string `json:"code"`
	} `json:"error"`
}

// priorityGateHandler 用真实 accountpriority 阶段组装 handler；dispatchCalls 记录
// dispatch 阶段被执行的次数（闸门拒绝时必须为 0）。
func priorityGateHandler(t *testing.T, tracker *accountruntime.Tracker, pool []accounts.Account) (http.Handler, *atomic.Int64) {
	t.Helper()
	cache := accounts.New()
	if _, err := cache.Replace(accounts.Snapshot{
		Version:  accounts.SnapshotVersion,
		Accounts: pool,
	}); err != nil {
		t.Fatalf("accounts.Replace: %v", err)
	}

	registry := contracts.NewRegistry()
	if _, err := accountpriority.Register(registry, accountpriority.Config{}); err != nil {
		t.Fatalf("accountpriority.Register: %v", err)
	}
	var dispatchCalls atomic.Int64
	registry.Stage(&stubStage{
		name:  "dispatch",
		phase: contracts.PhaseDispatch,
		run: func(*contracts.Ctx) (contracts.Decision, error) {
			dispatchCalls.Add(1)
			return contracts.Decision{Action: contracts.ActionRespond, Status: http.StatusOK}, nil
		},
	})

	instance, err := engine.New(registry.Stages(), nil, engine.WithAccountRuntime(tracker))
	if err != nil {
		t.Fatalf("engine.New: %v", err)
	}
	server, err := New(instance, cache, nil, Config{MaxBodyBytes: 1 << 20, TrustedProxyHops: 1})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	return server.Handler(), &dispatchCalls
}

func sendLLMRequest(t *testing.T, handler http.Handler) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, llmRequest(t, nil))
	return recorder
}

func decodeErrorBody(t *testing.T, recorder *httptest.ResponseRecorder) llmErrorPayload {
	t.Helper()
	var payload llmErrorPayload
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("错误体不是 JSON：%v（%s）", err, recorder.Body.String())
	}
	return payload
}

// TestSaturatedGateCodeIsVisibleInResponseBody：
// 两个账号都达到并发上限时，客户端收到的 body 里必须有 ALL_ACCOUNTS_SATURATED，
// 且请求从未进入 dispatch（不排队、不放行）。
func TestSaturatedGateCodeIsVisibleInResponseBody(t *testing.T) {
	tracker := accountruntime.New(0)
	handler, dispatchCalls := priorityGateHandler(t, tracker, []accounts.Account{
		{AccountID: "acc-1", Provider: "openai", Kind: "api_key", BaseURL: "https://upstream.example/v1", Token: "sk-1", Concurrency: 1},
		{AccountID: "acc-2", Provider: "openai", Kind: "api_key", BaseURL: "https://upstream.example/v1", Token: "sk-2", Concurrency: 1},
	})

	// 模拟两个正在进行中的请求各自占满一个槽位。
	release1, ok := tracker.Acquire("acc-1", 1)
	if !ok {
		t.Fatal("acc-1 应当能预留槽位")
	}
	defer release1()
	release2, ok := tracker.Acquire("acc-2", 1)
	if !ok {
		t.Fatal("acc-2 应当能预留槽位")
	}
	defer release2()

	recorder := sendLLMRequest(t, handler)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("期望 503，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	payload := decodeErrorBody(t, recorder)
	if payload.Error.Code != contracts.CodeAllAccountsSaturated {
		t.Fatalf("响应体错误码应为 %s，得到 %q：%s",
			contracts.CodeAllAccountsSaturated, payload.Error.Code, recorder.Body.String())
	}
	if payload.Error.Type != "server_error" {
		t.Fatalf("期望 type=server_error，得到 %q", payload.Error.Type)
	}
	if got := dispatchCalls.Load(); got != 0 {
		t.Fatalf("闸门拒绝的请求不许进入 dispatch，实际执行了 %d 次", got)
	}
	if got := tracker.Active(); got != 2 {
		t.Fatalf("被拒绝的请求不许多占槽位，活跃数应仍为 2，得到 %d", got)
	}

	// 再发一次：仍然是同一个稳定码（不是偶发的 502 / 500），也不排队。
	again := sendLLMRequest(t, handler)
	if again.Code != http.StatusServiceUnavailable {
		t.Fatalf("重复请求期望 503，得到 %d", again.Code)
	}
	if payload := decodeErrorBody(t, again); payload.Error.Code != contracts.CodeAllAccountsSaturated {
		t.Fatalf("重复请求的错误码应稳定为 %s，得到 %q",
			contracts.CodeAllAccountsSaturated, payload.Error.Code)
	}
	if got := dispatchCalls.Load(); got != 0 {
		t.Fatalf("重复请求也不许进入 dispatch，累计执行了 %d 次", got)
	}
}

// TestAnthropicGateCodeIsVisibleInResponseBody：走 /v1/messages 的客户端也必须能在
// 响应体里读到稳定码（owner 2026-10-29 拍板的 B 方案：anthropic 的 error 对象里加 code）。
func TestAnthropicGateCodeIsVisibleInResponseBody(t *testing.T) {
	tracker := accountruntime.New(0)
	handler, dispatchCalls := priorityGateHandler(t, tracker, []accounts.Account{
		{AccountID: "acc-1", Provider: "anthropic", Kind: "api_key", BaseURL: "https://upstream.example/v1", Token: "sk-1", Concurrency: 1},
		{AccountID: "acc-2", Provider: "anthropic", Kind: "api_key", BaseURL: "https://upstream.example/v1", Token: "sk-2", Concurrency: 1},
	})
	release1, ok := tracker.Acquire("acc-1", 1)
	if !ok {
		t.Fatal("acc-1 应当能预留槽位")
	}
	defer release1()
	release2, ok := tracker.Acquire("acc-2", 1)
	if !ok {
		t.Fatal("acc-2 应当能预留槽位")
	}
	defer release2()

	request := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"m","max_tokens":16,"messages":[]}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("期望 503，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Type  string `json:"type"`
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("错误体不是 JSON：%v（%s）", err, recorder.Body.String())
	}
	if payload.Type != "error" || payload.Error.Type != "api_error" {
		t.Fatalf("anthropic 顶层形状被改了：%s", recorder.Body.String())
	}
	if payload.Error.Code != contracts.CodeAllAccountsSaturated {
		t.Fatalf("anthropic 响应体的 error.code 应为 %s，得到 %q：%s",
			contracts.CodeAllAccountsSaturated, payload.Error.Code, recorder.Body.String())
	}
	if got := dispatchCalls.Load(); got != 0 {
		t.Fatalf("闸门拒绝的请求不许进入 dispatch，实际执行了 %d 次", got)
	}
}

// TestCoolingGateCodeIsVisibleInResponseBody：
// 所有账号都在 429 冷却中时，客户端收到的 body 里必须有 ALL_ACCOUNTS_COOLING。
func TestCoolingGateCodeIsVisibleInResponseBody(t *testing.T) {
	tracker := accountruntime.New(30 * time.Second)
	handler, dispatchCalls := priorityGateHandler(t, tracker, []accounts.Account{
		{AccountID: "acc-1", Provider: "openai", Kind: "api_key", BaseURL: "https://upstream.example/v1", Token: "sk-1", Concurrency: 4},
		{AccountID: "acc-2", Provider: "openai", Kind: "api_key", BaseURL: "https://upstream.example/v1", Token: "sk-2", Concurrency: 4},
	})
	tracker.RecordLimit("acc-1")
	tracker.RecordLimit("acc-2")

	recorder := sendLLMRequest(t, handler)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("期望 503，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	payload := decodeErrorBody(t, recorder)
	if payload.Error.Code != contracts.CodeAllAccountsCooling {
		t.Fatalf("响应体错误码应为 %s，得到 %q：%s",
			contracts.CodeAllAccountsCooling, payload.Error.Code, recorder.Body.String())
	}
	if payload.Error.Type != "server_error" {
		t.Fatalf("期望 type=server_error，得到 %q", payload.Error.Type)
	}
	if got := dispatchCalls.Load(); got != 0 {
		t.Fatalf("冷却中的账号不许进入 dispatch，实际执行了 %d 次", got)
	}
}
