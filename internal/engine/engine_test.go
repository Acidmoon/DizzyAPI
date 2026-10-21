package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

type fakeStage struct {
	name      string
	phase     contracts.Phase
	needBody  bool
	run       func(*contracts.Ctx) (contracts.Decision, error)
	callCount int
	mu        sync.Mutex
}

func (s *fakeStage) Name() string           { return s.name }
func (s *fakeStage) Phase() contracts.Phase { return s.phase }
func (s *fakeStage) Required() bool         { return true }
func (s *fakeStage) NeedBody() bool         { return s.needBody }
func (s *fakeStage) Run(ctx *contracts.Ctx) (contracts.Decision, error) {
	s.mu.Lock()
	s.callCount++
	s.mu.Unlock()
	if s.run == nil {
		return contracts.Decision{Action: contracts.ActionContinue}, nil
	}
	return s.run(ctx)
}

func newCtx() *contracts.Ctx {
	return &contracts.Ctx{
		Context: context.Background(),
		ReqID:   "req-test",
		Meta:    contracts.RequestMeta{Model: "test-model"},
		AccountRoute: &contracts.AccountRoute{
			Strategy: "default",
			Ranked: []contracts.ScoredAccount{
				{AccountID: "a"}, {AccountID: "b"}, {AccountID: "c"},
			},
		},
	}
}

func mustEngine(t *testing.T, stages ...contracts.Stage) *Engine {
	t.Helper()
	engine, err := New(stages, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return engine
}

func TestRunOrderAndPostOnce(t *testing.T) {
	var order []string
	record := func(name string) {
		order = append(order, name)
	}
	preA := &fakeStage{name: "pre-a", phase: contracts.PhasePre, run: func(*contracts.Ctx) (contracts.Decision, error) {
		record("pre-a")
		return contracts.Decision{Action: contracts.ActionContinue}, nil
	}}
	preB := &fakeStage{name: "pre-b", phase: contracts.PhasePre, run: func(*contracts.Ctx) (contracts.Decision, error) {
		record("pre-b")
		return contracts.Decision{Action: contracts.ActionContinue}, nil
	}}
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch, run: func(*contracts.Ctx) (contracts.Decision, error) {
		record("dispatch")
		return contracts.Decision{Action: contracts.ActionRespond, Status: 200, Body: []byte("ok")}, nil
	}}
	postA := &fakeStage{name: "post-a", phase: contracts.PhasePost, run: func(*contracts.Ctx) (contracts.Decision, error) {
		record("post-a")
		return contracts.Decision{Action: contracts.ActionContinue}, nil
	}}
	postB := &fakeStage{name: "post-b", phase: contracts.PhasePost, run: func(*contracts.Ctx) (contracts.Decision, error) {
		record("post-b")
		return contracts.Decision{Action: contracts.ActionContinue}, nil
	}}

	decision := mustEngine(t, preA, preB, dispatch, postA, postB).Run(newCtx())
	if decision.Status != 200 || string(decision.Body) != "ok" {
		t.Fatalf("响应不对：%+v", decision)
	}
	want := []string{"pre-a", "pre-b", "dispatch", "post-a", "post-b"}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Fatalf("执行顺序不对：%v，期望 %v", order, want)
	}
	if postA.callCount != 1 || postB.callCount != 1 {
		t.Fatalf("post 必须恰好执行一次：%d / %d", postA.callCount, postB.callCount)
	}
}

func TestPreRespondSkipsDispatchAndStillRunsPost(t *testing.T) {
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch}
	post := &fakeStage{name: "post", phase: contracts.PhasePost}
	pre := &fakeStage{name: "auth", phase: contracts.PhasePre, run: func(*contracts.Ctx) (contracts.Decision, error) {
		return contracts.Decision{Action: contracts.ActionRespond, Status: 401}, nil
	}}

	decision := mustEngine(t, pre, dispatch, post).Run(newCtx())
	if decision.Status != 401 {
		t.Fatalf("期望 401，得到 %d", decision.Status)
	}
	if dispatch.callCount != 0 {
		t.Fatalf("pre 已响应，dispatch 不应执行（%d 次）", dispatch.callCount)
	}
	if post.callCount != 1 {
		t.Fatalf("post 应执行一次，得到 %d", post.callCount)
	}
}

func TestDispatchFailsOverOnRetryableError(t *testing.T) {
	var seen []string
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch, run: func(ctx *contracts.Ctx) (contracts.Decision, error) {
		account := ctx.AccountRoute.Picked.AccountID
		seen = append(seen, account)
		if account == "a" {
			return contracts.Decision{}, &contracts.StageError{Status: 502, Code: "UPSTREAM_ERROR", Message: "boom", Retryable: true}
		}
		return contracts.Decision{Action: contracts.ActionRespond, Status: 200, Body: []byte(account)}, nil
	}}
	post := &fakeStage{name: "post", phase: contracts.PhasePost}

	decision := mustEngine(t, dispatch, post).Run(newCtx())
	if decision.Status != 200 || string(decision.Body) != "b" {
		t.Fatalf("没有转移到 b：%+v", decision)
	}
	if strings.Join(seen, ",") != "a,b" {
		t.Fatalf("尝试顺序不对：%v", seen)
	}
	if post.callCount != 1 {
		t.Fatalf("post 应执行一次，得到 %d", post.callCount)
	}
}

func TestDispatchStopsOnNonRetryableError(t *testing.T) {
	var seen []string
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch, run: func(ctx *contracts.Ctx) (contracts.Decision, error) {
		seen = append(seen, ctx.AccountRoute.Picked.AccountID)
		return contracts.Decision{}, &contracts.StageError{Status: 400, Code: "UPSTREAM_INVALID_REQUEST", Message: "bad model", Retryable: false}
	}}

	decision := mustEngine(t, dispatch).Run(newCtx())
	if decision.Status != 400 {
		t.Fatalf("期望 400，得到 %d", decision.Status)
	}
	if strings.Join(seen, ",") != "a" {
		t.Fatalf("不可重试错误不应换账号：%v", seen)
	}
}

func TestUnknownErrorIsNotLeaked(t *testing.T) {
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch, run: func(*contracts.Ctx) (contracts.Decision, error) {
		return contracts.Decision{}, errors.New("secret token sk-super-secret")
	}}

	decision := mustEngine(t, dispatch).Run(newCtx())
	if strings.Contains(string(decision.Body), "sk-super-secret") {
		t.Fatalf("未知错误的消息泄漏了：%s", decision.Body)
	}
	var payload map[string]any
	if err := json.Unmarshal(decision.Body, &payload); err != nil {
		t.Fatalf("错误响应不是 JSON：%v", err)
	}
	if payload["error"].(map[string]any)["code"] != "GATEWAY_INTERNAL" {
		t.Fatalf("错误码不对：%v", payload)
	}
}

func TestRenderWritesStableErrorCodeToCtx(t *testing.T) {
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch, run: func(*contracts.Ctx) (contracts.Decision, error) {
		return contracts.Decision{}, contracts.Errorf(502, "UPSTREAM_DOWN", "上游不可用")
	}}

	ctx := newCtx()
	decision := mustEngine(t, dispatch).Run(ctx)
	if decision.Status != 502 {
		t.Fatalf("期望 502，得到 %d", decision.Status)
	}
	if ctx.ErrorCode != "UPSTREAM_DOWN" {
		t.Fatalf("ErrorCode = %q，期望 UPSTREAM_DOWN", ctx.ErrorCode)
	}

	// 成功路径不得写 ErrorCode。
	okDispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch, run: func(*contracts.Ctx) (contracts.Decision, error) {
		return contracts.Decision{Action: contracts.ActionRespond, Status: 200, Body: []byte("ok")}, nil
	}}
	okCtx := newCtx()
	mustEngine(t, okDispatch).Run(okCtx)
	if okCtx.ErrorCode != "" {
		t.Fatalf("成功路径不应写 ErrorCode，得到 %q", okCtx.ErrorCode)
	}
}

func TestPostRunsOnPanic(t *testing.T) {
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch, run: func(*contracts.Ctx) (contracts.Decision, error) {
		panic("boom")
	}}
	post := &fakeStage{name: "post", phase: contracts.PhasePost}

	decision := mustEngine(t, dispatch, post).Run(newCtx())
	if decision.Status != 500 {
		t.Fatalf("panic 应渲染成 500，得到 %d", decision.Status)
	}
	if post.callCount != 1 {
		t.Fatalf("panic 时 post 仍须执行一次，得到 %d", post.callCount)
	}
}

func TestNewRejectsInvalidPhaseOrder(t *testing.T) {
	post := &fakeStage{name: "post", phase: contracts.PhasePost}
	pre := &fakeStage{name: "pre", phase: contracts.PhasePre}
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch}
	if _, err := New([]contracts.Stage{post, pre, dispatch}, nil); err == nil {
		t.Fatal("相位回退必须被拒绝")
	}
}

func TestNewRequiresDispatchStage(t *testing.T) {
	pre := &fakeStage{name: "pre", phase: contracts.PhasePre}
	if _, err := New([]contracts.Stage{pre}, nil); err == nil {
		t.Fatal("没有 dispatch 阶段必须被拒绝")
	}
}
