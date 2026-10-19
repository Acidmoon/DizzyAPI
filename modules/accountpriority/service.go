package accountpriority

import (
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Service 是账号优先级模块的并发安全门面。
//
// 读路径（Score / Pick / Evaluate）只做一次 atomic.Pointer 读取，
// 之后全是请求内局部计算；写路径（Replace）串行化后整体换快照。
// 这样 LLM 请求之间不会互相等锁，配置更新也不会让读路径看到半份配置。
type Service struct {
	mu        sync.Mutex
	snap      atomic.Pointer[snapshot]
	startedAt time.Time
	scored    atomic.Uint64
	picked    atomic.Uint64
}

// 编译期确认：本服务就是 contracts 里声明的那个能力面。
var _ contracts.AccountScorer = (*Service)(nil)

// New 用一份配置构造服务；配置为空时启用内置默认策略。
func New(cfg Config) (*Service, error) {
	snap, err := compileConfig(cfg)
	if err != nil {
		return nil, err
	}
	service := &Service{startedAt: time.Now().UTC()}
	service.snap.Store(snap)
	return service, nil
}

// Replace 原子替换整套策略。只有全部校验通过才会生效，绝不部分应用。
func (s *Service) Replace(cfg Config) (string, error) {
	snap, err := compileConfig(cfg)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.snap.Store(snap)
	s.mu.Unlock()
	return snap.revision, nil
}

// Status 返回运行期状态。它不包含任何账号或秘密。
func (s *Service) Status() Status {
	snap := s.snap.Load()
	status := Status{
		Ready:           true,
		Revision:        snap.revision,
		DefaultStrategy: snap.defaultID,
		Strategies:      len(snap.strategies),
		StartedAt:       s.startedAt,
		Scored:          s.scored.Load(),
		Picked:          s.picked.Load(),
		CandidatesMax:   MaxCandidates,
	}
	return status
}

// Strategies 返回全部策略组（含已禁用的），供管理面展示。
func (s *Service) Strategies() StrategyList {
	snap := s.snap.Load()
	return StrategyList{
		Revision:        snap.revision,
		DefaultStrategy: snap.defaultID,
		Strategies:      cloneStrategyGroups(snap.groups),
	}
}

// Score 返回排序与可解释明细；没有可用账号时返回空 Ranked，不报错。
func (s *Service) Score(req ScoreRequest) (contracts.ScoreResult, error) {
	result, _, err := s.Evaluate(req)
	return result, err
}

// Pick 返回最终选中的账号；没有可用账号时报错。
func (s *Service) Pick(req ScoreRequest) (*contracts.ScoredAccount, error) {
	_, picked, err := s.Evaluate(req)
	if err != nil {
		return nil, err
	}
	if picked == nil {
		return nil, newError(CodeNoEligibleAccount, "没有可用账号")
	}
	return picked, nil
}

// Evaluate 一次算出排序与选中项，避免阶段里重复打分。
func (s *Service) Evaluate(req ScoreRequest) (contracts.ScoreResult, *contracts.ScoredAccount, error) {
	if err := validateRequest(req); err != nil {
		return contracts.ScoreResult{}, nil, err
	}

	snap := s.snap.Load()
	strategyID := req.Strategy
	if strategyID == "" {
		strategyID = snap.defaultID
	}
	strategy, ok := snap.strategies[strategyID]
	if !ok {
		return contracts.ScoreResult{}, nil, newError(CodeStrategyNotFound,
			"策略组 %q 不存在或未启用", strategyID)
	}

	now := time.Now().UTC()
	if req.Now != nil {
		now = req.Now.UTC()
	}
	result, picked := strategy.evaluate(req.Candidates, now, req.Limit, req.Seed)
	result.Revision = snap.revision

	s.scored.Add(1)
	if picked != nil {
		s.picked.Add(1)
	}
	return result, picked, nil
}

func validateRequest(req ScoreRequest) error {
	if len(req.Candidates) > MaxCandidates {
		return newError(CodeTooManyCandidates,
			"一次最多评分 %d 个候选，收到 %d 个", MaxCandidates, len(req.Candidates))
	}
	if req.Limit < 0 || req.Limit > MaxCandidates {
		return newError(CodeInvalidRequest, "limit 必须在 0 到 %d 之间", MaxCandidates)
	}
	seen := make(map[string]struct{}, len(req.Candidates))
	for _, candidate := range req.Candidates {
		if strings.TrimSpace(candidate.AccountID) == "" {
			return newError(CodeInvalidRequest, "候选账号必须带非空的 accountId")
		}
		if _, exists := seen[candidate.AccountID]; exists {
			return newError(CodeDuplicateCandidate, "候选账号 id 重复：%s", candidate.AccountID)
		}
		seen[candidate.AccountID] = struct{}{}
	}
	return nil
}
