package accountpriority

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

func TestStageWritesRoute(t *testing.T) {
	service, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	stage := NewStage(service)
	ctx := &contracts.Ctx{
		Context:           context.Background(),
		ReqID:             "req-1",
		Meta:              contracts.RequestMeta{Model: "claude-sonnet-5-5"},
		AccountCandidates: []contracts.AccountCandidate{candidate("a"), candidate("b")},
	}

	decision, err := stage.Run(ctx)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if decision.Action != contracts.ActionContinue {
		t.Fatalf("期望继续链路，得到 %v", decision.Action)
	}
	if ctx.AccountRoute == nil {
		t.Fatal("阶段没有写 AccountRoute")
	}
	if ctx.AccountRoute.Strategy != "default" {
		t.Fatalf("期望 default 策略，得到 %s", ctx.AccountRoute.Strategy)
	}
	if len(ctx.AccountRoute.Ranked) != 2 || ctx.AccountRoute.Picked == nil {
		t.Fatalf("路由不完整：%+v", ctx.AccountRoute)
	}
}

func TestStageSelectsNamedStrategy(t *testing.T) {
	service, err := New(Config{Strategies: []StrategyGroup{
		strategyWithFactors("default", map[string]FactorRule{"health": {Weight: 1}}),
		strategyWithFactors("latency", map[string]FactorRule{"latency": {Weight: 100, Direction: "asc"}}),
	}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	stage := NewStage(service)
	fast := candidate("fast")
	fast.LatencyP95Ms = fptr(10)
	slow := candidate("slow")
	slow.LatencyP95Ms = fptr(900)
	ctx := &contracts.Ctx{
		Context:           context.Background(),
		Meta:              contracts.RequestMeta{Strategy: "latency"},
		AccountCandidates: []contracts.AccountCandidate{slow, fast},
	}

	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctx.AccountRoute.Picked.AccountID != "fast" {
		t.Fatalf("策略没有生效，选中了 %s", ctx.AccountRoute.Picked.AccountID)
	}
}

func TestStageRejectsEmptyPool(t *testing.T) {
	service, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	stage := NewStage(service)
	ctx := &contracts.Ctx{
		Context: context.Background(),
		Meta:    contracts.RequestMeta{},
	}
	_, err = stage.Run(ctx)
	if err == nil || !IsCode(err, CodeNoEligibleAccount) {
		t.Fatalf("期望没有可用账号错误，得到 %v", err)
	}
	if ctx.AccountRoute != nil {
		t.Fatal("失败时不应写路由")
	}
}

func TestStageRejectsNilCtx(t *testing.T) {
	service, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = NewStage(service).Run(nil)
	if err == nil || !IsCode(err, CodeInvalidRequest) {
		t.Fatalf("期望参数错误，得到 %v", err)
	}
}

func TestScoreWithNoCandidatesIsNotAnError(t *testing.T) {
	service, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	result, err := service.Score(ScoreRequest{})
	if err != nil {
		t.Fatalf("预览空池不应报错：%v", err)
	}
	if len(result.Ranked) != 0 {
		t.Fatalf("空池不应有排序结果：%+v", result)
	}
}

// stageErrorOf 取出 StageError（阶段错误）；否则返回 nil。
func stageErrorOf(err error) *contracts.StageError {
	var stageErr *contracts.StageError
	if errors.As(err, &stageErr) {
		return stageErr
	}
	return nil
}

// TestStageReportsSaturatedGate 验证「全部账号饱和」时阶段给出稳定错误码，
// 而不是笼统的「没有可用账号」：客户端与日志都要能看出是闸门拒绝。
func TestStageReportsSaturatedGate(t *testing.T) {
	service, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	stage := NewStage(service)
	saturatedA := candidate("sat-a")
	saturatedA.Concurrency = 2
	saturatedA.InFlight = 2
	saturatedB := candidate("sat-b")
	saturatedB.Concurrency = 1
	saturatedB.InFlight = 3
	ctx := &contracts.Ctx{
		Context:           context.Background(),
		Meta:              contracts.RequestMeta{},
		AccountCandidates: []contracts.AccountCandidate{saturatedA, saturatedB},
	}

	_, err = stage.Run(ctx)
	stageErr := stageErrorOf(err)
	if stageErr == nil {
		t.Fatalf("期望 StageError，得到 %v", err)
	}
	if stageErr.Code != contracts.CodeAllAccountsSaturated {
		t.Fatalf("错误码 = %q，期望 %q", stageErr.Code, contracts.CodeAllAccountsSaturated)
	}
	if stageErr.Status != http.StatusServiceUnavailable || stageErr.Retryable {
		t.Fatalf("闸门拒绝必须是 503 且不可重试：%+v", stageErr)
	}
	if ctx.AccountRoute != nil {
		t.Fatal("失败时不应写路由")
	}
}

func TestStageReportsCoolingGate(t *testing.T) {
	service, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	stage := NewStage(service)
	coolingA := candidate("cool-a")
	coolingA.CooldownUntil = tptr(time.Now().Add(time.Minute))
	coolingB := candidate("cool-b")
	coolingB.CooldownUntil = tptr(time.Now().Add(time.Minute))
	ctx := &contracts.Ctx{
		Context:           context.Background(),
		AccountCandidates: []contracts.AccountCandidate{coolingA, coolingB},
	}

	_, err = stage.Run(ctx)
	stageErr := stageErrorOf(err)
	if stageErr == nil {
		t.Fatalf("期望 StageError，得到 %v", err)
	}
	if stageErr.Code != contracts.CodeAllAccountsCooling {
		t.Fatalf("错误码 = %q，期望 %q", stageErr.Code, contracts.CodeAllAccountsCooling)
	}
}

func TestStageMixedGateReasonsStayNoEligible(t *testing.T) {
	service, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	stage := NewStage(service)
	saturated := candidate("sat")
	saturated.Concurrency = 1
	saturated.InFlight = 1
	disabled := candidate("off")
	disabled.Disabled = true
	ctx := &contracts.Ctx{
		Context:           context.Background(),
		AccountCandidates: []contracts.AccountCandidate{saturated, disabled},
	}

	_, err = stage.Run(ctx)
	if !IsCode(err, CodeNoEligibleAccount) {
		t.Fatalf("混合原因应保持 NO_ELIGIBLE_ACCOUNT，得到 %v", err)
	}
}

// TestOversaturatedWithoutConcurrencyStaysEligible 是向后兼容的验收点：
// 旧快照没有 concurrency（0）时，InFlight 再大也不能被当成饱和。
func TestOversaturatedWithoutConcurrencyStaysEligible(t *testing.T) {
	service, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	legacy := candidate("legacy")
	legacy.Concurrency = 0
	legacy.InFlight = 100
	result, err := service.Score(ScoreRequest{
		Candidates: []contracts.AccountCandidate{legacy},
		Now:        tptr(testNow),
	})
	if err != nil {
		t.Fatalf("Score: %v", err)
	}
	if len(result.Ranked) != 1 {
		t.Fatalf("未声明 concurrency 的账号不能被判饱和：%+v", result.Excluded)
	}
}
