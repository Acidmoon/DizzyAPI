package accountpriority

import (
	"math"
	"math/rand/v2"
	"sort"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// ───────────────────────────────── 因子原始值

func extractPriority(candidate contracts.AccountCandidate, _ time.Time) (float64, bool) {
	return float64(candidate.Priority), true
}

func extractCapacity(candidate contracts.AccountCandidate, _ time.Time) (float64, bool) {
	if candidate.Weight == nil {
		return 1, true
	}
	return *candidate.Weight, true
}

func extractHealth(candidate contracts.AccountCandidate, _ time.Time) (float64, bool) {
	switch candidate.Health {
	case contracts.HealthHealthy:
		return 1, true
	case contracts.HealthDegraded:
		return 0.5, true
	case contracts.HealthUnhealthy:
		return 0, true
	default:
		// 未知（含空字符串）交给规则里的 unknown，不假装健康（D17）。
		return 0, false
	}
}

func extractQuota(candidate contracts.AccountCandidate, _ time.Time) (float64, bool) {
	if candidate.QuotaRatio == nil {
		return 0, false
	}
	return clamp01(*candidate.QuotaRatio), true
}

func extractRateLimit(candidate contracts.AccountCandidate, _ time.Time) (float64, bool) {
	if candidate.RateLimitRatio == nil {
		return 0, false
	}
	return clamp01(*candidate.RateLimitRatio), true
}

func extractHeadroom(candidate contracts.AccountCandidate, _ time.Time) (float64, bool) {
	if candidate.Concurrency <= 0 {
		return 0, false
	}
	headroom := float64(candidate.Concurrency-candidate.InFlight) / float64(candidate.Concurrency)
	return clamp01(headroom), true
}

func extractSuccess(candidate contracts.AccountCandidate, _ time.Time) (float64, bool) {
	if candidate.SuccessRate == nil {
		return 0, false
	}
	return clamp01(*candidate.SuccessRate), true
}

func extractLatency(candidate contracts.AccountCandidate, _ time.Time) (float64, bool) {
	if candidate.LatencyP95Ms == nil || *candidate.LatencyP95Ms < 0 {
		return 0, false
	}
	return *candidate.LatencyP95Ms, true
}

func extractCost(candidate contracts.AccountCandidate, _ time.Time) (float64, bool) {
	if candidate.CostMultiplier == nil || *candidate.CostMultiplier < 0 {
		return 0, false
	}
	return *candidate.CostMultiplier, true
}

func extractFreshness(candidate contracts.AccountCandidate, now time.Time) (float64, bool) {
	if candidate.LastUsedAt == nil {
		return 0, false
	}
	idle := now.Sub(*candidate.LastUsedAt).Seconds()
	if idle < 0 {
		idle = 0
	}
	return idle, true
}

// ───────────────────────────────── 过滤

// excludeReason 返回空字符串表示可以进入打分；否则是剔除原因。
func (cs *compiledStrategy) excludeReason(candidate contracts.AccountCandidate, now time.Time) string {
	filter := cs.group.Filter

	if candidate.Disabled {
		return "disabled"
	}
	if len(filter.Providers) > 0 && !containsString(filter.Providers, candidate.Provider) {
		return "provider_mismatch"
	}
	if len(filter.Kinds) > 0 && !containsString(filter.Kinds, candidate.Kind) {
		return "kind_mismatch"
	}
	for key, value := range filter.Tags {
		if candidate.Tags[key] != value {
			return "tag_mismatch"
		}
	}

	switch cs.healthPolicy {
	case "require_healthy":
		if candidate.Health != contracts.HealthHealthy {
			return "health_not_healthy"
		}
	case "exclude_unhealthy":
		if candidate.Health == contracts.HealthUnhealthy {
			return "unhealthy"
		}
	}

	if cs.excludeCool && candidate.CooldownUntil != nil && now.Before(*candidate.CooldownUntil) {
		return "cooling_down"
	}
	if cs.excludeSat && candidate.Concurrency > 0 && candidate.InFlight >= candidate.Concurrency {
		return "saturated"
	}
	return ""
}

// ───────────────────────────────── 打分与排序

type rankedEntry struct {
	scored    contracts.ScoredAccount
	candidate contracts.AccountCandidate
}

func (cs *compiledStrategy) rank(candidates []contracts.AccountCandidate, now time.Time) []rankedEntry {
	count := len(candidates)
	rawValues := make([][]float64, count)
	known := make([][]bool, count)
	for i := range candidates {
		rawValues[i] = make([]float64, len(cs.factors))
		known[i] = make([]bool, len(cs.factors))
		for fi, factor := range cs.factors {
			value, ok := factor.extract(candidates[i], now)
			if math.IsNaN(value) || math.IsInf(value, 0) {
				ok = false
			}
			rawValues[i][fi] = value
			known[i][fi] = ok
		}
	}

	mins := make([]float64, len(cs.factors))
	maxs := make([]float64, len(cs.factors))
	anyKnown := make([]bool, len(cs.factors))
	for fi, factor := range cs.factors {
		if factor.fixed {
			continue
		}
		minimum := math.Inf(1)
		maximum := math.Inf(-1)
		for i := range candidates {
			if !known[i][fi] {
				continue
			}
			anyKnown[fi] = true
			minimum = math.Min(minimum, rawValues[i][fi])
			maximum = math.Max(maximum, rawValues[i][fi])
		}
		mins[fi] = minimum
		maxs[fi] = maximum
	}

	entries := make([]rankedEntry, count)
	for i, candidate := range candidates {
		breakdown := make([]contracts.ScoreFactor, 0, len(cs.factors))
		total := 0.0
		for fi, factor := range cs.factors {
			normalized := factor.unknown
			var raw *float64
			if known[i][fi] {
				value := rawValues[i][fi]
				raw = floatPtr(value)
				switch {
				case factor.fixed:
					normalized = clamp01(value)
				case !anyKnown[fi] || maxs[fi]-mins[fi] <= 1e-12:
					normalized = 1
				default:
					normalized = (value - mins[fi]) / (maxs[fi] - mins[fi])
					if factor.direction == "asc" {
						normalized = 1 - normalized
					}
				}
				normalized = clamp01(normalized)
			}
			contribution := factor.weight * normalized
			total += contribution
			breakdown = append(breakdown, contracts.ScoreFactor{
				Name:         factor.name,
				Raw:          raw,
				Normalized:   normalized,
				Weight:       factor.weight,
				Contribution: contribution,
			})
		}
		entries[i] = rankedEntry{
			scored: contracts.ScoredAccount{
				AccountID: candidate.AccountID,
				Score:     100 * total / cs.weightTotal,
				Breakdown: breakdown,
			},
			candidate: candidate,
		}
	}

	sort.SliceStable(entries, func(i, j int) bool { return cs.less(entries[i], entries[j]) })
	return entries
}

func (cs *compiledStrategy) less(a, b rankedEntry) bool {
	if diff := a.scored.Score - b.scored.Score; math.Abs(diff) > 1e-9 {
		return diff > 0
	}
	for _, name := range cs.tieBreakers {
		switch name {
		case "priority":
			if a.candidate.Priority != b.candidate.Priority {
				return a.candidate.Priority > b.candidate.Priority
			}
		case "weight":
			aw, bw := effectiveWeight(a.candidate), effectiveWeight(b.candidate)
			if math.Abs(aw-bw) > 1e-12 {
				return aw > bw
			}
		case "success":
			if better, decided := compareFloatPtr(a.candidate.SuccessRate, b.candidate.SuccessRate, true); decided {
				return better
			}
		case "latency":
			if better, decided := compareFloatPtr(a.candidate.LatencyP95Ms, b.candidate.LatencyP95Ms, false); decided {
				return better
			}
		case "freshness":
			at, bt := a.candidate.LastUsedAt, b.candidate.LastUsedAt
			switch {
			case at == nil && bt == nil:
			case at == nil:
				return false
			case bt == nil:
				return true
			case !at.Equal(*bt):
				return at.Before(*bt)
			}
		case "accountId":
			if a.candidate.AccountID != b.candidate.AccountID {
				return a.candidate.AccountID < b.candidate.AccountID
			}
		}
	}
	return false
}

// compareFloatPtr 比较两个可空浮点：nil 永远排在后面。
// higherBetter 为 true 时较大的更好，否则较小的更好。
// 第二个返回值表示是否已经分出胜负。
func compareFloatPtr(a, b *float64, higherBetter bool) (bool, bool) {
	switch {
	case a == nil && b == nil:
		return false, false
	case a == nil:
		return false, true
	case b == nil:
		return true, true
	case *a == *b:
		return false, false
	case higherBetter:
		return *a > *b, true
	default:
		return *a < *b, true
	}
}

func (cs *compiledStrategy) pickWeighted(ranked []contracts.ScoredAccount, seed uint64) contracts.ScoredAccount {
	if len(ranked) == 0 {
		return contracts.ScoredAccount{}
	}
	total := 0.0
	for _, entry := range ranked {
		if entry.Score > 0 {
			total += entry.Score
		}
	}
	if total <= 0 {
		return ranked[seed%uint64(len(ranked))]
	}
	random := rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))
	target := random.Float64() * total
	for _, entry := range ranked {
		if entry.Score <= 0 {
			continue
		}
		if target < entry.Score {
			return entry
		}
		target -= entry.Score
	}
	return ranked[len(ranked)-1]
}

// evaluate 是一次纯计算：不读共享状态、不写任何东西。
// 并发请求可以同时调用它，唯一的共享输入是编译好的只读策略快照。
func (cs *compiledStrategy) evaluate(
	candidates []contracts.AccountCandidate,
	now time.Time,
	limit int,
	seed uint64,
) (contracts.ScoreResult, *contracts.ScoredAccount) {
	result := contracts.ScoreResult{Strategy: cs.group.ID, EvaluatedAt: now}
	eligible := make([]contracts.AccountCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if reason := cs.excludeReason(candidate, now); reason != "" {
			result.Excluded = append(result.Excluded, contracts.ExcludedAccount{
				AccountID: candidate.AccountID,
				Reason:    reason,
			})
			continue
		}
		eligible = append(eligible, candidate)
	}
	if len(eligible) == 0 {
		return result, nil
	}

	entries := cs.rank(eligible, now)
	length := len(entries)
	if cs.maxCandidates > 0 && cs.maxCandidates < length {
		length = cs.maxCandidates
	}
	if limit > 0 && limit < length {
		length = limit
	}
	result.Ranked = make([]contracts.ScoredAccount, length)
	for i := 0; i < length; i++ {
		result.Ranked[i] = entries[i].scored
	}
	if length == 0 {
		return result, nil
	}

	var picked contracts.ScoredAccount
	if cs.selection == "weighted-random" {
		if seed == 0 {
			seed = uint64(now.UnixNano())
		}
		picked = cs.pickWeighted(result.Ranked, seed)
	} else {
		picked = result.Ranked[0]
	}
	return result, &picked
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func effectiveWeight(candidate contracts.AccountCandidate) float64 {
	if candidate.Weight == nil {
		return 1
	}
	return *candidate.Weight
}

func clamp01(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}
