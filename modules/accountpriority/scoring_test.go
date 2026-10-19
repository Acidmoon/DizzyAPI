package accountpriority

import (
	"math"
	"sync"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

var testNow = time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)

func fptr(value float64) *float64 { return &value }

func tptr(value time.Time) *time.Time { return &value }

func strategyWithFactors(id string, factors map[string]FactorRule) StrategyGroup {
	enabled := true
	return StrategyGroup{ID: id, Name: id, Enabled: &enabled, Factors: factors}
}

func candidate(id string) contracts.AccountCandidate {
	return contracts.AccountCandidate{
		AccountID:  id,
		Provider:   "claude",
		Kind:       "oauth",
		Health:     contracts.HealthHealthy,
		Priority:   0,
		QuotaRatio: fptr(0.8),
	}
}

func TestDefaultStrategyRanksBetterCandidateFirst(t *testing.T) {
	service, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	better := contracts.AccountCandidate{
		AccountID:      "better",
		Provider:       "claude",
		Health:         contracts.HealthHealthy,
		Priority:       10,
		Weight:         fptr(1),
		QuotaRatio:     fptr(0.9),
		RateLimitRatio: fptr(0.9),
		InFlight:       0,
		Concurrency:    4,
		SuccessRate:    fptr(0.99),
		LatencyP95Ms:   fptr(100),
		CostMultiplier: fptr(1),
	}
	worse := contracts.AccountCandidate{
		AccountID:      "worse",
		Provider:       "claude",
		Health:         contracts.HealthHealthy,
		Priority:       0,
		Weight:         fptr(1),
		QuotaRatio:     fptr(0.2),
		RateLimitRatio: fptr(0.2),
		InFlight:       3,
		Concurrency:    4,
		SuccessRate:    fptr(0.8),
		LatencyP95Ms:   fptr(800),
		CostMultiplier: fptr(1.5),
	}
	result, err := service.Score(ScoreRequest{
		Candidates: []contracts.AccountCandidate{worse, better},
		Now:        tptr(testNow),
	})
	if err != nil {
		t.Fatalf("Score: %v", err)
	}
	if len(result.Ranked) != 2 {
		t.Fatalf("期望 2 个可评分账号，得到 %d", len(result.Ranked))
	}
	if result.Ranked[0].AccountID != "better" {
		t.Fatalf("期望 better 排第一，得到 %s", result.Ranked[0].AccountID)
	}
	if result.Ranked[0].Score <= result.Ranked[1].Score {
		t.Fatalf("分数没有体现差距：%v <= %v", result.Ranked[0].Score, result.Ranked[1].Score)
	}
	if len(result.Ranked[0].Breakdown) == 0 {
		t.Fatal("缺少可解释明细")
	}
}

func TestFilterExcludesWithReasons(t *testing.T) {
	enabled := true
	strategy := StrategyGroup{
		ID:      "strict",
		Enabled: &enabled,
		Filter: Filter{
			Providers:        []string{"claude"},
			Tags:             map[string]string{"region": "us"},
			Health:           "exclude_unhealthy",
			ExcludeCooling:   &enabled,
			ExcludeSaturated: &enabled,
		},
		Factors: map[string]FactorRule{"health": {Weight: 1}},
	}
	service, err := New(Config{Strategies: []StrategyGroup{strategy}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ok := candidate("ok")
	ok.Tags = map[string]string{"region": "us"}
	wrongProvider := candidate("wrong-provider")
	wrongProvider.Provider = "openai"
	wrongProvider.Tags = map[string]string{"region": "us"}
	wrongTag := candidate("wrong-tag")
	wrongTag.Tags = map[string]string{"region": "eu"}
	unhealthy := candidate("unhealthy")
	unhealthy.Health = contracts.HealthUnhealthy
	unhealthy.Tags = map[string]string{"region": "us"}
	cooling := candidate("cooling")
	cooling.Tags = map[string]string{"region": "us"}
	cooling.CooldownUntil = tptr(testNow.Add(10 * time.Minute))
	saturated := candidate("saturated")
	saturated.Tags = map[string]string{"region": "us"}
	saturated.InFlight = 2
	saturated.Concurrency = 2
	disabled := candidate("disabled")
	disabled.Tags = map[string]string{"region": "us"}
	disabled.Disabled = true

	result, err := service.Score(ScoreRequest{
		Candidates: []contracts.AccountCandidate{
			ok, wrongProvider, wrongTag, unhealthy, cooling, saturated, disabled,
		},
		Now: tptr(testNow),
	})
	if err != nil {
		t.Fatalf("Score: %v", err)
	}
	if len(result.Ranked) != 1 || result.Ranked[0].AccountID != "ok" {
		t.Fatalf("只有 ok 应该通过过滤，得到 %+v", result.Ranked)
	}
	reasons := map[string]string{}
	for _, excluded := range result.Excluded {
		reasons[excluded.AccountID] = excluded.Reason
	}
	expected := map[string]string{
		"wrong-provider": "provider_mismatch",
		"wrong-tag":      "tag_mismatch",
		"unhealthy":      "unhealthy",
		"cooling":        "cooling_down",
		"saturated":      "saturated",
		"disabled":       "disabled",
	}
	for id, reason := range expected {
		if reasons[id] != reason {
			t.Errorf("%s 的剔除原因期望 %s，得到 %s", id, reason, reasons[id])
		}
	}
}

func TestUnknownValuesAreFirstClass(t *testing.T) {
	service, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	result, err := service.Score(ScoreRequest{
		Candidates: []contracts.AccountCandidate{{AccountID: "cold", Provider: "claude"}},
		Now:        tptr(testNow),
	})
	if err != nil {
		t.Fatalf("Score: %v", err)
	}
	if len(result.Ranked) != 1 {
		t.Fatalf("未知健康的账号默认不应被排除，得到 %+v", result.Excluded)
	}
	var healthFactor *contracts.ScoreFactor
	for i := range result.Ranked[0].Breakdown {
		if result.Ranked[0].Breakdown[i].Name == "health" {
			healthFactor = &result.Ranked[0].Breakdown[i]
		}
	}
	if healthFactor == nil {
		t.Fatal("缺少 health 明细")
	}
	if healthFactor.Raw != nil {
		t.Fatal("未知的 health 原始值必须是 null，而不是 0")
	}
	if math.Abs(healthFactor.Normalized-0.3) > 1e-9 {
		t.Fatalf("默认策略里未知 health 应取 0.3，得到 %v", healthFactor.Normalized)
	}
}

func TestLatencyDirectionAscending(t *testing.T) {
	service, err := New(Config{Strategies: []StrategyGroup{
		strategyWithFactors("latency", map[string]FactorRule{
			"latency": {Weight: 100, Direction: "asc"},
		}),
	}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	fast := candidate("fast")
	fast.LatencyP95Ms = fptr(100)
	slow := candidate("slow")
	slow.LatencyP95Ms = fptr(900)

	result, err := service.Score(ScoreRequest{
		Strategy:   "latency",
		Candidates: []contracts.AccountCandidate{slow, fast},
		Now:        tptr(testNow),
	})
	if err != nil {
		t.Fatalf("Score: %v", err)
	}
	if result.Ranked[0].AccountID != "fast" {
		t.Fatalf("延迟越低应越靠前，得到 %+v", result.Ranked)
	}
}

func TestTieBreakerAccountIDIsDeterministic(t *testing.T) {
	service, err := New(Config{Strategies: []StrategyGroup{
		strategyWithFactors("equal", map[string]FactorRule{"health": {Weight: 1}}),
	}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	first, err := service.Score(ScoreRequest{
		Strategy:   "equal",
		Candidates: []contracts.AccountCandidate{candidate("b"), candidate("a"), candidate("c")},
		Now:        tptr(testNow),
	})
	if err != nil {
		t.Fatalf("Score: %v", err)
	}
	second, err := service.Score(ScoreRequest{
		Strategy:   "equal",
		Candidates: []contracts.AccountCandidate{candidate("c"), candidate("b"), candidate("a")},
		Now:        tptr(testNow),
	})
	if err != nil {
		t.Fatalf("Score: %v", err)
	}
	for i, expected := range []string{"a", "b", "c"} {
		if first.Ranked[i].AccountID != expected || second.Ranked[i].AccountID != expected {
			t.Fatalf("排序不稳定：%v / %v", first.Ranked, second.Ranked)
		}
	}
}

func TestWeightedRandomIsReproducible(t *testing.T) {
	service, err := New(Config{Strategies: []StrategyGroup{
		{
			ID:         "random",
			Factors:    map[string]FactorRule{"health": {Weight: 1}},
			Selection:  "weighted-random",
			TieBreaker: []string{"accountId"},
		},
	}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	request := ScoreRequest{
		Strategy:   "random",
		Candidates: []contracts.AccountCandidate{candidate("a"), candidate("b"), candidate("c")},
		Now:        tptr(testNow),
		Seed:       42,
	}
	first, err := service.Pick(request)
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	second, err := service.Pick(request)
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	if first.AccountID != second.AccountID {
		t.Fatalf("同一个 seed 应得到同一个账号：%s != %s", first.AccountID, second.AccountID)
	}
}

func TestRevisionStableAcrossStrategyOrder(t *testing.T) {
	a := strategyWithFactors("a", map[string]FactorRule{"health": {Weight: 1}})
	b := strategyWithFactors("b", map[string]FactorRule{"quota": {Weight: 1}})
	first, err := New(Config{Strategies: []StrategyGroup{a, b}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	second, err := New(Config{Strategies: []StrategyGroup{b, a}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if first.Status().Revision != second.Status().Revision {
		t.Fatalf("策略顺序不应改变 revision：%s != %s",
			first.Status().Revision, second.Status().Revision)
	}

	changed := strategyWithFactors("a", map[string]FactorRule{"health": {Weight: 2}})
	third, err := New(Config{Strategies: []StrategyGroup{changed, b}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if third.Status().Revision == first.Status().Revision {
		t.Fatal("权重变化应改变 revision")
	}
}

func TestRequestValidation(t *testing.T) {
	service, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	cases := []struct {
		name string
		req  ScoreRequest
		code ErrorCode
	}{
		{
			name: "空 accountId",
			req:  ScoreRequest{Candidates: []contracts.AccountCandidate{{Provider: "claude"}}},
			code: CodeInvalidRequest,
		},
		{
			name: "重复 accountId",
			req: ScoreRequest{Candidates: []contracts.AccountCandidate{
				{AccountID: "a"}, {AccountID: "a"},
			}},
			code: CodeDuplicateCandidate,
		},
		{
			name: "负数 limit",
			req:  ScoreRequest{Limit: -1},
			code: CodeInvalidRequest,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := service.Score(testCase.req)
			if err == nil || !IsCode(err, testCase.code) {
				t.Fatalf("期望错误码 %s，得到 %v", testCase.code, err)
			}
		})
	}
}

func TestConcurrentScoringAndReplace(t *testing.T) {
	service, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	alternate := Config{Strategies: []StrategyGroup{
		strategyWithFactors("alt", map[string]FactorRule{"health": {Weight: 1}}),
	}}
	candidates := []contracts.AccountCandidate{
		candidate("a"), candidate("b"), candidate("c"), candidate("d"),
	}
	request := ScoreRequest{Candidates: candidates, Now: tptr(testNow)}

	var wait sync.WaitGroup
	for worker := 0; worker < 32; worker++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for iteration := 0; iteration < 100; iteration++ {
				if _, err := service.Score(request); err != nil {
					t.Errorf("并发 Score 失败：%v", err)
					return
				}
				if _, err := service.Pick(request); err != nil {
					t.Errorf("并发 Pick 失败：%v", err)
					return
				}
			}
		}()
	}
	for writer := 0; writer < 4; writer++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for iteration := 0; iteration < 50; iteration++ {
				if _, err := service.Replace(alternate); err != nil {
					t.Errorf("并发 Replace 失败：%v", err)
					return
				}
			}
		}()
	}
	wait.Wait()
}

func TestStrategiesReturnsCopy(t *testing.T) {
	service, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	before := service.Status().Revision
	list := service.Strategies()
	list.Strategies[0].Factors["health"] = FactorRule{Weight: 999}

	after := service.Strategies()
	if after.Strategies[0].Factors["health"].Weight == 999 {
		t.Fatal("管理面读到的策略组必须是副本，不能改到运行期快照")
	}
	if service.Status().Revision != before {
		t.Fatal("读操作不应改变 revision")
	}
}
