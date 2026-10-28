package engine

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accountruntime"
)

// gateCtx 构造一份带道具候选快照的请求上下文：并发闸门从 AccountCandidates
// 里读 concurrency，所以测试必须同时给 Ranked 与 Candidates。
func gateCtx(ranked []contracts.ScoredAccount, candidates []contracts.AccountCandidate) *contracts.Ctx {
	return &contracts.Ctx{
		Context:           context.Background(),
		ReqID:             "req-gate",
		Meta:              contracts.RequestMeta{Model: "test-model"},
		AccountCandidates: candidates,
		AccountRoute:      &contracts.AccountRoute{Strategy: "default", Ranked: ranked},
	}
}

func gateEngine(t *testing.T, tracker *accountruntime.Tracker, stages ...contracts.Stage) *Engine {
	t.Helper()
	instance, err := New(stages, nil, WithAccountRuntime(tracker))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return instance
}

func decisionCode(decision contracts.Decision) string {
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(decision.Body, &payload); err != nil {
		return ""
	}
	return payload.Error.Code
}

// TestConcurrencyGateRejectsOverLimitWithoutQueueing 是这条线的验收关键：
// 10 个并发打 concurrency=2 的账号，同时刻活跃数不超过 2，其余立刻 503
// ALL_ACCOUNTS_SATURATED（不排队、不放行）。
func TestConcurrencyGateRejectsOverLimitWithoutQueueing(t *testing.T) {
	tracker := accountruntime.New(0)
	entered := make(chan string, 16)
	unblock := make(chan struct{})
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch, run: func(ctx *contracts.Ctx) (contracts.Decision, error) {
		entered <- ctx.AccountRoute.Picked.AccountID
		<-unblock
		return contracts.Decision{Action: contracts.ActionRespond, Status: 200, Body: []byte("ok")}, nil
	}}
	instance := gateEngine(t, tracker, dispatch)

	const requests = 10
	var wg sync.WaitGroup
	var okCount, saturatedCount atomic.Int64
	var unexpected atomic.Int64
	for index := 0; index < requests; index += 1 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// 每个请求用自己的候选快照：engine 会把 in-flight 写进它。
			ctx := gateCtx(
				[]contracts.ScoredAccount{{AccountID: "a"}},
				[]contracts.AccountCandidate{{AccountID: "a", Concurrency: 2}},
			)
			decision := instance.Run(ctx)
			switch {
			case decision.Status == 200:
				okCount.Add(1)
				if ctx.ReleaseInFlight == nil {
					unexpected.Add(1)
					return
				}
				ctx.ReleaseInFlight()
			case decision.Status == 503 && decisionCode(decision) == contracts.CodeAllAccountsSaturated:
				saturatedCount.Add(1)
			default:
				unexpected.Add(1)
			}
		}()
	}

	// 前两个请求必须进入 dispatch 并卡住；此时活跃数就是 2。
	for index := 0; index < 2; index += 1 {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatal("期望恰好 2 个请求进入 dispatch")
		}
	}
	if got := tracker.InFlight("a"); got != 2 {
		t.Fatalf("活跃数 = %d，期望 2", got)
	}
	// 其余 8 个必须在第一个还没结束时就被闸门拒绝（不排队）。
	deadline := time.Now().Add(3 * time.Second)
	for saturatedCount.Load() < requests-2 {
		if time.Now().After(deadline) {
			t.Fatalf("等待闸门拒绝超时：saturated=%d", saturatedCount.Load())
		}
		time.Sleep(time.Millisecond)
	}
	if tracker.InFlight("a") != 2 {
		t.Fatalf("被拒绝的请求不应占用槽位：活跃数 = %d", tracker.InFlight("a"))
	}

	close(unblock)
	wg.Wait()
	if okCount.Load() != 2 || saturatedCount.Load() != requests-2 || unexpected.Load() != 0 {
		t.Fatalf("结果不对：ok=%d saturated=%d unexpected=%d",
			okCount.Load(), saturatedCount.Load(), unexpected.Load())
	}
	if got := tracker.Active(); got != 0 {
		t.Fatalf("请求结束后活跃数应归零，得到 %d", got)
	}
}

func TestInFlightHeldUntilHTTPReleases(t *testing.T) {
	tracker := accountruntime.New(0)
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch, run: func(*contracts.Ctx) (contracts.Decision, error) {
		return contracts.Decision{Action: contracts.ActionRespond, Status: 200, Body: []byte("ok")}, nil
	}}
	instance := gateEngine(t, tracker, dispatch)
	ctx := gateCtx(
		[]contracts.ScoredAccount{{AccountID: "a"}},
		[]contracts.AccountCandidate{{AccountID: "a", Concurrency: 1}},
	)

	if decision := instance.Run(ctx); decision.Status != 200 {
		t.Fatalf("期望 200，得到 %d", decision.Status)
	}
	// engine 不提前释放：流式响应的槽位必须等 HTTP 入口读完整个流。
	if got := tracker.InFlight("a"); got != 1 {
		t.Fatalf("engine 返回后槽位仍应持有：活跃数 = %d", got)
	}
	if ctx.ReleaseInFlight == nil {
		t.Fatal("成功响应必须交回 release")
	}
	ctx.ReleaseInFlight()
	ctx.ReleaseInFlight() // 幂等
	if got := tracker.InFlight("a"); got != 0 {
		t.Fatalf("释放后活跃数应为 0，得到 %d", got)
	}
}

func TestInFlightReleasedOnRetryableErrorAndFailover(t *testing.T) {
	tracker := accountruntime.New(0)
	var seen []string
	var mu sync.Mutex
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch, run: func(ctx *contracts.Ctx) (contracts.Decision, error) {
		account := ctx.AccountRoute.Picked.AccountID
		mu.Lock()
		seen = append(seen, account)
		mu.Unlock()
		if account == "a" {
			return contracts.Decision{}, &contracts.StageError{Status: 502, Code: "UPSTREAM_ERROR", Message: "boom", Retryable: true}
		}
		return contracts.Decision{Action: contracts.ActionRespond, Status: 200, Body: []byte("ok")}, nil
	}}
	instance := gateEngine(t, tracker, dispatch)
	ctx := gateCtx(
		[]contracts.ScoredAccount{{AccountID: "a"}, {AccountID: "b"}},
		[]contracts.AccountCandidate{{AccountID: "a", Concurrency: 1}, {AccountID: "b", Concurrency: 1}},
	)

	if decision := instance.Run(ctx); decision.Status != 200 {
		t.Fatalf("期望换号成功，得到 %d", decision.Status)
	}
	if len(seen) != 2 || seen[0] != "a" || seen[1] != "b" {
		t.Fatalf("尝试顺序不对：%v", seen)
	}
	// a 失败后槽位必须立刻释放；b 的槽位由 HTTP 持有。
	if got := tracker.InFlight("a"); got != 0 {
		t.Fatalf("失败账号的槽位泄漏：a.InFlight = %d", got)
	}
	ctx.ReleaseInFlight()
	if got := tracker.Active(); got != 0 {
		t.Fatalf("全部结束后活跃数应归零，得到 %d", got)
	}
}

func TestInFlightReleasedOnPanic(t *testing.T) {
	tracker := accountruntime.New(0)
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch, run: func(*contracts.Ctx) (contracts.Decision, error) {
		panic("boom")
	}}
	instance := gateEngine(t, tracker, dispatch)
	ctx := gateCtx(
		[]contracts.ScoredAccount{{AccountID: "a"}},
		[]contracts.AccountCandidate{{AccountID: "a", Concurrency: 1}},
	)

	decision := instance.Run(ctx)
	if decision.Status != 500 {
		t.Fatalf("panic 应渲染 500，得到 %d", decision.Status)
	}
	if got := tracker.Active(); got != 0 {
		t.Fatalf("panic 路径泄漏了槽位：%d", got)
	}
}

func TestConcurrencyZeroMeansUnlimited(t *testing.T) {
	tracker := accountruntime.New(0)
	entered := make(chan struct{}, 16)
	unblock := make(chan struct{})
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch, run: func(*contracts.Ctx) (contracts.Decision, error) {
		entered <- struct{}{}
		<-unblock
		return contracts.Decision{Action: contracts.ActionRespond, Status: 200, Body: []byte("ok")}, nil
	}}
	instance := gateEngine(t, tracker, dispatch)

	const requests = 5
	var wg sync.WaitGroup
	for index := 0; index < requests; index += 1 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// 旧快照没有 concurrency：0 = 不限制，不能把老账号静默变不可选。
			ctx := gateCtx(
				[]contracts.ScoredAccount{{AccountID: "old"}},
				[]contracts.AccountCandidate{{AccountID: "old"}},
			)
			decision := instance.Run(ctx)
			if decision.Status == 200 {
				ctx.ReleaseInFlight()
			}
		}()
	}
	for index := 0; index < requests; index += 1 {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatal("concurrency=0 时所有请求都应进入 dispatch（不限制）")
		}
	}
	close(unblock)
	wg.Wait()
	if got := tracker.Active(); got != 0 {
		t.Fatalf("全部结束后活跃数应归零，得到 %d", got)
	}
}

func TestAllSaturatedFailsClosedWithoutDispatch(t *testing.T) {
	tracker := accountruntime.New(0)
	release, ok := tracker.Acquire("a", 1)
	if !ok {
		t.Fatal("Acquire 失败")
	}
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch}
	instance := gateEngine(t, tracker, dispatch)
	ctx := gateCtx(
		[]contracts.ScoredAccount{{AccountID: "a"}},
		[]contracts.AccountCandidate{{AccountID: "a", Concurrency: 1}},
	)

	decision := instance.Run(ctx)
	if decision.Status != 503 {
		t.Fatalf("期望 503，得到 %d", decision.Status)
	}
	if code := decisionCode(decision); code != contracts.CodeAllAccountsSaturated {
		t.Fatalf("错误码 = %q，期望 %q", code, contracts.CodeAllAccountsSaturated)
	}
	if dispatch.callCount != 0 {
		t.Fatalf("饱和时不能放行到 dispatch，实际执行 %d 次", dispatch.callCount)
	}
	if got := tracker.InFlight("a"); got != 1 {
		t.Fatalf("被拒绝的请求不能动别人的槽位：%d", got)
	}
	release()
}

func TestEngineAppliesRuntimeToCandidatesBeforePre(t *testing.T) {
	tracker := accountruntime.New(30 * time.Second)
	tracker.RecordLimit("b")

	var observed []contracts.AccountCandidate
	pre := &fakeStage{name: "pre", phase: contracts.PhasePre, run: func(ctx *contracts.Ctx) (contracts.Decision, error) {
		observed = append([]contracts.AccountCandidate(nil), ctx.AccountCandidates...)
		return contracts.Decision{Action: contracts.ActionContinue}, nil
	}}
	dispatch := &fakeStage{name: "dispatch", phase: contracts.PhaseDispatch, run: func(*contracts.Ctx) (contracts.Decision, error) {
		return contracts.Decision{Action: contracts.ActionRespond, Status: 200, Body: []byte("ok")}, nil
	}}
	instance := gateEngine(t, tracker, pre, dispatch)
	ctx := gateCtx(
		[]contracts.ScoredAccount{{AccountID: "a"}},
		[]contracts.AccountCandidate{
			{AccountID: "a", Concurrency: 1, InFlight: 999},
			{AccountID: "b", Concurrency: 1},
		},
	)
	if decision := instance.Run(ctx); decision.Status != 200 {
		t.Fatalf("期望 200，得到 %d", decision.Status)
	}
	ctx.ReleaseInFlight()

	if len(observed) != 2 {
		t.Fatalf("pre 阶段看到 %d 个候选", len(observed))
	}
	if observed[0].InFlight != 0 {
		t.Fatalf("pre 前必须刷新 InFlight（%d）", observed[0].InFlight)
	}
	if observed[1].CooldownUntil == nil {
		t.Fatal("pre 前必须把冷却写进候选")
	}
}
