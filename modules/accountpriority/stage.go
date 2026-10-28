package accountpriority

import (
	"net/http"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Stage 是链路里的账号优先级阶段。
//
// 输入：Ctx.AccountCandidates（账号池快照）与 Ctx.Meta.Strategy。
// 输出：Ctx.AccountRoute（排序结果 + 选中项）。
//
// 它不做任何 I/O，也不改账号状态；选中的账号由 transport 使用，
// 失败事实由 transport 回报给 account-state（D18）。
type Stage struct {
	service *Service
}

// NewStage 用现有服务构造阶段。
func NewStage(service *Service) *Stage {
	return &Stage{service: service}
}

func (s *Stage) Name() string {
	return StageName
}

func (s *Stage) Phase() contracts.Phase {
	return contracts.PhasePre
}

func (s *Stage) Required() bool {
	return true
}

func (s *Stage) NeedBody() bool {
	return false
}

func (s *Stage) Run(ctx *contracts.Ctx) (contracts.Decision, error) {
	if ctx == nil {
		return contracts.Decision{}, newError(CodeInvalidRequest, "Ctx 不能为空")
	}
	result, picked, err := s.service.Evaluate(ScoreRequest{
		Strategy:   ctx.Meta.Strategy,
		Candidates: ctx.AccountCandidates,
	})
	if err != nil {
		return contracts.Decision{}, err
	}
	if picked == nil {
		return contracts.Decision{}, gateError(result)
	}
	ctx.AccountRoute = &contracts.AccountRoute{
		Strategy: result.Strategy,
		Ranked:   result.Ranked,
		Picked:   picked,
	}
	return contracts.Decision{Action: contracts.ActionContinue}, nil
}

// gateError 在「没有任何候选通过过滤」时给出可区分的稳定错误码。
//
// 全部因饱和被排除 → ALL_ACCOUNTS_SATURATED；全部在限流冷却 → ALL_ACCOUNTS_COOLING；
// 其它原因（禁用 / 标签 / 健康 / 模型等）保持原来的 ACCOUNT_PRIORITY_NO_ELIGIBLE_ACCOUNT。
// 三种都是 fail-closed（503 且不可重试），不会排队也不会静默放行。
func gateError(result contracts.ScoreResult) error {
	if len(result.Excluded) == 0 {
		return newError(CodeNoEligibleAccount, "没有可用账号")
	}
	saturated, cooling := true, true
	for _, excluded := range result.Excluded {
		switch excluded.Reason {
		case "saturated":
			cooling = false
		case "cooling_down":
			saturated = false
		default:
			saturated, cooling = false, false
		}
	}
	switch {
	case saturated:
		return contracts.Errorf(http.StatusServiceUnavailable, contracts.CodeAllAccountsSaturated,
			"所有账号都已达到并发上限，请稍后重试")
	case cooling:
		return contracts.Errorf(http.StatusServiceUnavailable, contracts.CodeAllAccountsCooling,
			"所有账号都在限流冷却中，请稍后重试")
	default:
		return newError(CodeNoEligibleAccount, "没有可用账号")
	}
}
