package modelroute

import (
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func routerStage() *RouteStage { return NewRouteStage(New(nil, discardLogger())) }

func candidate(id string, models ...string) contracts.AccountCandidate {
	return contracts.AccountCandidate{AccountID: id, Models: models}
}

func TestRouteKeepsUndeclaredAccounts(t *testing.T) {
	stage := routerStage()
	ctx := &contracts.Ctx{ReqID: "r", Meta: contracts.RequestMeta{Model: "gpt-4o"}}
	ctx.AccountCandidates = []contracts.AccountCandidate{candidate("a"), candidate("b")}

	decision, err := stage.Run(ctx)
	if err != nil || decision.Action != contracts.ActionContinue {
		t.Fatalf("未声明账号应保留：%+v %v", decision, err)
	}
	if len(ctx.AccountCandidates) != 2 {
		t.Fatalf("候选应原样保留：%+v", ctx.AccountCandidates)
	}
}

func TestRouteFiltersNonMatchingAccounts(t *testing.T) {
	stage := routerStage()
	ctx := &contracts.Ctx{ReqID: "r", Meta: contracts.RequestMeta{Model: "gpt-4o"}}
	ctx.AccountCandidates = []contracts.AccountCandidate{
		candidate("match", "gpt-4o", "gpt-4o-mini"),
		candidate("other", "claude-sonnet-4-5"),
		candidate("undeclared"),
	}

	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(ctx.AccountCandidates) != 2 {
		t.Fatalf("应保留命中 + 未声明：%+v", ctx.AccountCandidates)
	}
	ids := []string{ctx.AccountCandidates[0].AccountID, ctx.AccountCandidates[1].AccountID}
	if strings.Join(ids, ",") != "match,undeclared" {
		t.Fatalf("过滤结果不对：%v", ids)
	}
}

func TestRouteAllFilteredReturnsModelNotServed(t *testing.T) {
	stage := routerStage()
	ctx := &contracts.Ctx{ReqID: "r", Meta: contracts.RequestMeta{Model: "gpt-4o"}}
	ctx.AccountCandidates = []contracts.AccountCandidate{
		candidate("a", "claude-sonnet-4-5"),
		candidate("b", "gemini-pro"),
	}

	_, err := stage.Run(ctx)
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) {
		t.Fatalf("期望 StageError，得到 %v", err)
	}
	if stageErr.Code != CodeModelNotServed || stageErr.Status != 503 || stageErr.Retryable {
		t.Fatalf("应为 503 且不可重试：%+v", stageErr)
	}
	if !strings.Contains(stageErr.Message, "gpt-4o") {
		t.Fatalf("消息应带模型名：%s", stageErr.Message)
	}
	if len(ctx.AccountCandidates) != 2 {
		t.Fatal("失败时不应改写候选列表")
	}
}

func TestRouteEmptyModelDoesNotFilter(t *testing.T) {
	stage := routerStage()
	ctx := &contracts.Ctx{ReqID: "r"}
	ctx.AccountCandidates = []contracts.AccountCandidate{candidate("a", "claude-sonnet-4-5")}

	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(ctx.AccountCandidates) != 1 {
		t.Fatal("缺 model 时不应过滤")
	}
}

func TestRouteNoCandidatesIsNotModelNotServed(t *testing.T) {
	stage := routerStage()
	ctx := &contracts.Ctx{ReqID: "r", Meta: contracts.RequestMeta{Model: "gpt-4o"}}

	// 没有候选时应交给 accountpriority 报「没有可用账号」，不要误报模型未服务。
	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestRegisterRouterAndMapper(t *testing.T) {
	reg := contracts.NewRegistry()
	if _, err := RegisterRouter(reg, Config{}, discardLogger()); err != nil {
		t.Fatalf("RegisterRouter: %v", err)
	}
	if err := RegisterMapper(reg, Config{}, fakeCreds{"a": {}}, discardLogger()); err != nil {
		t.Fatalf("RegisterMapper: %v", err)
	}

	stages := reg.Stages()
	if len(stages) != 2 {
		t.Fatalf("应注册两个阶段：%d", len(stages))
	}
	if stages[0].Name() != RouteStageName || stages[0].Phase() != contracts.PhasePre {
		t.Fatalf("路由阶段不对：%s %v", stages[0].Name(), stages[0].Phase())
	}
	if stages[1].Name() != MapStageName || stages[1].Phase() != contracts.PhaseDispatch {
		t.Fatalf("映射阶段不对：%s %v", stages[1].Name(), stages[1].Phase())
	}
	if _, ok := reg.Lookup(ServiceName); !ok {
		t.Fatal("应注册能力型服务")
	}
}

func TestRegisterRejectsNilInputs(t *testing.T) {
	if _, err := RegisterRouter(nil, Config{}, discardLogger()); err == nil {
		t.Fatal("nil Registry 必须报错")
	}
	if err := RegisterMapper(nil, Config{}, fakeCreds{}, discardLogger()); err == nil {
		t.Fatal("nil Registry 必须报错")
	}
	reg := contracts.NewRegistry()
	if err := RegisterMapper(reg, Config{}, nil, discardLogger()); err == nil {
		t.Fatal("nil CredentialSource 必须报错")
	}
}
