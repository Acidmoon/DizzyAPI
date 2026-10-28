package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accountruntime"
	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/engine"
)

// 并发槽位的「释放」发生在 HTTP 入口的 defer 里，而不是 engine 返回时：
// 流式请求必须等整个流写完 / 客户端断开才减 in-flight。这里用真 handler 验证。

type stubStage struct {
	name  string
	phase contracts.Phase
	run   func(*contracts.Ctx) (contracts.Decision, error)
}

func (s *stubStage) Name() string           { return s.name }
func (s *stubStage) Phase() contracts.Phase { return s.phase }
func (s *stubStage) Required() bool         { return true }
func (s *stubStage) NeedBody() bool         { return false }
func (s *stubStage) Run(ctx *contracts.Ctx) (contracts.Decision, error) {
	return s.run(ctx)
}

func gateHandler(t *testing.T, tracker *accountruntime.Tracker, dispatch func(*contracts.Ctx) (contracts.Decision, error)) http.Handler {
	t.Helper()
	cache := accounts.New()
	if _, err := cache.Replace(accounts.Snapshot{
		Version: accounts.SnapshotVersion,
		Accounts: []accounts.Account{{
			AccountID:   "acc-1",
			Provider:    "openai",
			Kind:        "api_key",
			BaseURL:     "https://upstream.example/v1",
			Token:       "sk-upstream",
			Concurrency: 1,
		}},
	}); err != nil {
		t.Fatalf("accounts.Replace: %v", err)
	}
	pre := &stubStage{name: "pre", phase: contracts.PhasePre, run: func(ctx *contracts.Ctx) (contracts.Decision, error) {
		ctx.AccountRoute = &contracts.AccountRoute{
			Strategy: "default",
			Ranked:   []contracts.ScoredAccount{{AccountID: "acc-1"}},
		}
		return contracts.Decision{Action: contracts.ActionContinue}, nil
	}}
	dispatchStage := &stubStage{name: "dispatch", phase: contracts.PhaseDispatch, run: dispatch}
	instance, err := engine.New([]contracts.Stage{pre, dispatchStage}, nil, engine.WithAccountRuntime(tracker))
	if err != nil {
		t.Fatalf("engine.New: %v", err)
	}
	server, err := New(instance, cache, nil, Config{MaxBodyBytes: 1 << 20, TrustedProxyHops: 1})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	return server.Handler()
}

func llmRequest(t *testing.T, ctx context.Context) *http.Request {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"m","messages":[]}`))
	request.Header.Set("Content-Type", "application/json")
	if ctx != nil {
		request = request.WithContext(ctx)
	}
	return request
}

func TestNonStreamRequestReleasesInFlight(t *testing.T) {
	tracker := accountruntime.New(0)
	handler := gateHandler(t, tracker, func(*contracts.Ctx) (contracts.Decision, error) {
		return contracts.Decision{Action: contracts.ActionRespond, Status: 200, Body: []byte(`{"ok":true}`)}, nil
	})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, llmRequest(t, nil))

	if recorder.Code != 200 {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if got := tracker.Active(); got != 0 {
		t.Fatalf("请求结束后活跃数应归零，得到 %d", got)
	}
}

func TestStreamRequestReleasesInFlightAfterStreamEnds(t *testing.T) {
	tracker := accountruntime.New(0)
	handler := gateHandler(t, tracker, func(*contracts.Ctx) (contracts.Decision, error) {
		return contracts.Decision{
			Action:  contracts.ActionRespond,
			Status:  200,
			Headers: map[string]string{"Content-Type": "text/event-stream"},
			Stream:  io.NopCloser(strings.NewReader("data: {\"x\":1}\n\ndata: [DONE]\n\n")),
		}, nil
	})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, llmRequest(t, nil))

	if recorder.Code != 200 {
		t.Fatalf("期望 200，得到 %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "data: [DONE]") {
		t.Fatalf("流没有透传完：%q", recorder.Body.String())
	}
	if got := tracker.Active(); got != 0 {
		t.Fatalf("流结束后活跃数应归零，得到 %d", got)
	}
}

func TestStreamAbortReleasesInFlight(t *testing.T) {
	tracker := accountruntime.New(0)
	handler := gateHandler(t, tracker, func(*contracts.Ctx) (contracts.Decision, error) {
		return contracts.Decision{
			Action:  contracts.ActionRespond,
			Status:  200,
			Headers: map[string]string{"Content-Type": "text/event-stream"},
			Stream:  &brokenStream{},
		}, nil
	})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, llmRequest(t, nil))

	if got := tracker.Active(); got != 0 {
		t.Fatalf("流中断后活跃数应归零，得到 %d", got)
	}
}

func TestClientCanceledReleasesInFlight(t *testing.T) {
	tracker := accountruntime.New(0)
	handler := gateHandler(t, tracker, func(*contracts.Ctx) (contracts.Decision, error) {
		return contracts.Decision{
			Action:  contracts.ActionRespond,
			Status:  200,
			Headers: map[string]string{"Content-Type": "text/event-stream"},
			Stream:  io.NopCloser(strings.NewReader("data: {}\n\n")),
		}, nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, llmRequest(t, ctx))

	if got := tracker.Active(); got != 0 {
		t.Fatalf("客户端断开后活跃数应归零，得到 %d", got)
	}
}

// brokenStream 先给一块数据，再返回错误，模拟上游流中断。
type brokenStream struct {
	sent bool
}

func (s *brokenStream) Read(buffer []byte) (int, error) {
	if !s.sent {
		s.sent = true
		copy(buffer, "data: {\"x\":1}\n\n")
		return len("data: {\"x\":1}\n\n"), nil
	}
	return 0, io.ErrUnexpectedEOF
}

func (s *brokenStream) Close() error { return nil }
