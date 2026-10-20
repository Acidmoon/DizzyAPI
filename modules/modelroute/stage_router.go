package modelroute

import (
	"strings"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// RouteStage 是 pre 相位的模型路由过滤阶段，注册在 accountpriority 之前。
//
// 输入：Ctx.Meta.Model（客户端请求的对外模型名）与 Ctx.AccountCandidates。
// 输出：原地收窄的 Ctx.AccountCandidates。
//
// 它不做 I/O，也不改账号状态；被过滤掉的账号只是不参与本次打分。
type RouteStage struct {
	service *Service
}

// NewRouteStage 用现有服务构造阶段。
func NewRouteStage(service *Service) *RouteStage {
	return &RouteStage{service: service}
}

func (s *RouteStage) Name() string           { return RouteStageName }
func (s *RouteStage) Phase() contracts.Phase { return contracts.PhasePre }
func (s *RouteStage) Required() bool         { return true }
func (s *RouteStage) NeedBody() bool         { return false }

var continueDecision = contracts.Decision{Action: contracts.ActionContinue}

func (s *RouteStage) Run(ctx *contracts.Ctx) (contracts.Decision, error) {
	if ctx == nil {
		return contracts.Decision{}, contracts.Errorf(500, CodeInvalidRequest, "请求上下文为空")
	}

	model := strings.TrimSpace(ctx.Meta.Model)
	if model == "" {
		// 缺 model 交给后续阶段报错；这里不过滤。
		return continueDecision, nil
	}

	candidates := ctx.AccountCandidates
	if len(candidates) == 0 {
		// 没有候选：交给 accountpriority 报「没有可用账号」，不要误报模型未服务。
		return continueDecision, nil
	}

	kept := make([]contracts.AccountCandidate, 0, len(candidates))
	dropped := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if servesModel(candidate.Models, model) {
			kept = append(kept, candidate)
			continue
		}
		dropped = append(dropped, candidate.AccountID)
	}
	if len(dropped) == 0 {
		// 没有任何账号被过滤：保持原候选列表不动。
		return continueDecision, nil
	}
	if len(kept) == 0 {
		// 有候选、但都不服务该模型：换账号也没用，不可重试。
		return contracts.Decision{}, modelNotServed(model)
	}

	ctx.AccountCandidates = kept
	s.service.logger.Info("模型路由过滤账号",
		"reqId", ctx.ReqID,
		"model", model,
		"dropped", len(dropped),
		"kept", len(kept),
		"droppedAccounts", dropped,
	)
	return continueDecision, nil
}

// servesModel 判断账号是否服务请求的模型。
//
// 账号未声明 Models（nil 或空数组）= 不参与过滤，一律保留（向后兼容）：
// 不能把「未声明」当成「不服务任何模型」，那会让旧账号静默失效。
func servesModel(models []string, model string) bool {
	if len(models) == 0 {
		return true
	}
	for _, declared := range models {
		if declared == model {
			return true
		}
	}
	return false
}
