package accountpriority

import (
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
		return contracts.Decision{}, newError(CodeNoEligibleAccount, "没有可用账号")
	}
	ctx.AccountRoute = &contracts.AccountRoute{
		Strategy: result.Strategy,
		Ranked:   result.Ranked,
		Picked:   picked,
	}
	return contracts.Decision{Action: contracts.ActionContinue}, nil
}
