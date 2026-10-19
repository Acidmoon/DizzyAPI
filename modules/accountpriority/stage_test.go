package accountpriority

import (
	"context"
	"testing"

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
