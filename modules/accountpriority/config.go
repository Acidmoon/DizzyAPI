package accountpriority

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

var strategyIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// factorSpec 是一个因子的固定属性。fixed=true 的因子天然落在 [0,1]，
// 不再做 min-max 归一化（否则「只有一个候选」会让所有值都变成 1）。
type factorSpec struct {
	fixed            bool
	defaultDirection string
	extract          func(contracts.AccountCandidate, time.Time) (float64, bool)
}

var factorSpecs = map[string]factorSpec{
	"priority":  {defaultDirection: "desc", extract: extractPriority},
	"capacity":  {defaultDirection: "desc", extract: extractCapacity},
	"health":    {fixed: true, defaultDirection: "desc", extract: extractHealth},
	"quota":     {fixed: true, defaultDirection: "desc", extract: extractQuota},
	"rateLimit": {fixed: true, defaultDirection: "desc", extract: extractRateLimit},
	"headroom":  {fixed: true, defaultDirection: "desc", extract: extractHeadroom},
	"success":   {fixed: true, defaultDirection: "desc", extract: extractSuccess},
	"latency":   {defaultDirection: "asc", extract: extractLatency},
	"cost":      {defaultDirection: "asc", extract: extractCost},
	"freshness": {defaultDirection: "desc", extract: extractFreshness},
}

var factorNames = sortedKeys(factorSpecs)

var tieBreakerNames = map[string]bool{
	"priority":  true,
	"weight":    true,
	"success":   true,
	"latency":   true,
	"freshness": true,
	"accountId": true,
}

type compiledFactor struct {
	name      string
	weight    float64
	direction string
	unknown   float64
	fixed     bool
	extract   func(contracts.AccountCandidate, time.Time) (float64, bool)
}

type compiledStrategy struct {
	group         StrategyGroup
	factors       []compiledFactor
	weightTotal   float64
	tieBreakers   []string
	selection     string
	maxCandidates int
	excludeCool   bool
	excludeSat    bool
	healthPolicy  string
}

type snapshot struct {
	revision   string
	defaultID  string
	strategies map[string]*compiledStrategy
	groups     []StrategyGroup
}

func compileConfig(cfg Config) (*snapshot, error) {
	groups := cloneStrategyGroups(cfg.Strategies)
	if len(groups) == 0 {
		groups = []StrategyGroup{DefaultStrategy()}
	}
	if len(groups) > MaxStrategies {
		return nil, newError(CodeInvalidConfig, "策略组最多 %d 个，收到 %d 个", MaxStrategies, len(groups))
	}

	seen := make(map[string]bool, len(groups))
	for i := range groups {
		group := &groups[i]
		if !strategyIDPattern.MatchString(group.ID) {
			return nil, newError(CodeInvalidConfig,
				"策略组 id %q 不合法：只允许小写字母、数字、点、下划线与连字符，且必须以字母或数字开头", group.ID)
		}
		if seen[group.ID] {
			return nil, newError(CodeInvalidConfig, "策略组 id 重复：%s", group.ID)
		}
		seen[group.ID] = true
		if len(group.Name) > MaxNameLength {
			return nil, newError(CodeInvalidConfig, "策略组 %s 的名称超过 %d 字符", group.ID, MaxNameLength)
		}
		if len(group.Description) > MaxDescriptionLength {
			return nil, newError(CodeInvalidConfig,
				"策略组 %s 的描述超过 %d 字符", group.ID, MaxDescriptionLength)
		}
	}
	sort.SliceStable(groups, func(i, j int) bool { return groups[i].ID < groups[j].ID })

	compiled := make(map[string]*compiledStrategy, len(groups))
	firstEnabled := ""
	for i := range groups {
		cs, err := compileStrategy(groups[i])
		if err != nil {
			return nil, err
		}
		if !effectiveEnabled(groups[i]) {
			continue
		}
		compiled[groups[i].ID] = cs
		if firstEnabled == "" {
			firstEnabled = groups[i].ID
		}
	}
	if firstEnabled == "" {
		return nil, newError(CodeInvalidConfig, "至少要启用一个策略组")
	}

	defaultID := cfg.DefaultStrategy
	if defaultID == "" {
		defaultID = firstEnabled
	}
	if _, ok := compiled[defaultID]; !ok {
		return nil, newError(CodeInvalidConfig, "默认策略组 %q 不存在或未启用", defaultID)
	}

	normalized := Config{DefaultStrategy: defaultID, Strategies: groups}
	return &snapshot{
		revision:   revisionOf(normalized),
		defaultID:  defaultID,
		strategies: compiled,
		groups:     groups,
	}, nil
}

func compileStrategy(group StrategyGroup) (*compiledStrategy, error) {
	healthPolicy := group.Filter.Health
	if healthPolicy == "" {
		healthPolicy = "exclude_unhealthy"
	}
	switch healthPolicy {
	case "exclude_unhealthy", "require_healthy", "allow_all":
	default:
		return nil, newError(CodeInvalidConfig,
			"策略组 %s 的 filter.health 只能是 exclude_unhealthy / require_healthy / allow_all", group.ID)
	}
	for _, provider := range group.Filter.Providers {
		if strings.TrimSpace(provider) == "" {
			return nil, newError(CodeInvalidConfig, "策略组 %s 的 filter.providers 不能包含空字符串", group.ID)
		}
	}
	for _, kind := range group.Filter.Kinds {
		if strings.TrimSpace(kind) == "" {
			return nil, newError(CodeInvalidConfig, "策略组 %s 的 filter.kinds 不能包含空字符串", group.ID)
		}
	}
	for key := range group.Filter.Tags {
		if strings.TrimSpace(key) == "" {
			return nil, newError(CodeInvalidConfig, "策略组 %s 的 filter.tags 不能有空键", group.ID)
		}
	}

	factors := make([]compiledFactor, 0, len(group.Factors))
	total := 0.0
	for name, rule := range group.Factors {
		spec, ok := factorSpecs[name]
		if !ok {
			return nil, newError(CodeInvalidConfig,
				"策略组 %s 有未知因子 %q（可用：%s）", group.ID, name, strings.Join(factorNames, " / "))
		}
		if math.IsNaN(rule.Weight) || math.IsInf(rule.Weight, 0) || rule.Weight < 0 || rule.Weight > 100 {
			return nil, newError(CodeInvalidConfig, "策略组 %s 的因子 %s 权重必须在 0 到 100 之间", group.ID, name)
		}
		direction := rule.Direction
		if direction == "" {
			direction = spec.defaultDirection
		}
		if direction != "asc" && direction != "desc" {
			return nil, newError(CodeInvalidConfig,
				"策略组 %s 的因子 %s direction 只能是 asc 或 desc", group.ID, name)
		}
		if spec.fixed && direction == "asc" {
			return nil, newError(CodeInvalidConfig,
				"策略组 %s 的因子 %s 是固定分数因子，只能越大越好", group.ID, name)
		}
		unknown := 0.5
		if rule.Unknown != nil {
			unknown = *rule.Unknown
			if math.IsNaN(unknown) || math.IsInf(unknown, 0) || unknown < 0 || unknown > 1 {
				return nil, newError(CodeInvalidConfig,
					"策略组 %s 的因子 %s unknown 必须在 0 到 1 之间", group.ID, name)
			}
		}
		if rule.Weight == 0 {
			continue
		}
		factors = append(factors, compiledFactor{
			name:      name,
			weight:    rule.Weight,
			direction: direction,
			unknown:   unknown,
			fixed:     spec.fixed,
			extract:   spec.extract,
		})
		total += rule.Weight
	}
	if total <= 0 {
		return nil, newError(CodeInvalidConfig, "策略组 %s 至少要有一个权重大于 0 的因子", group.ID)
	}
	sort.Slice(factors, func(i, j int) bool { return factors[i].name < factors[j].name })

	selection := group.Selection
	if selection == "" {
		selection = "rank"
	}
	switch selection {
	case "rank", "weighted-random":
	default:
		return nil, newError(CodeInvalidConfig,
			"策略组 %s 的 selection 只能是 rank 或 weighted-random", group.ID)
	}

	tieBreakers := group.TieBreaker
	if len(tieBreakers) == 0 {
		tieBreakers = []string{"priority", "accountId"}
	}
	seenTie := make(map[string]bool, len(tieBreakers))
	for _, name := range tieBreakers {
		if !tieBreakerNames[name] {
			return nil, newError(CodeInvalidConfig,
				"策略组 %s 有未知 tieBreaker %q（可用：priority / weight / success / latency / freshness / accountId）",
				group.ID, name)
		}
		if seenTie[name] {
			return nil, newError(CodeInvalidConfig, "策略组 %s 的 tieBreaker 重复：%s", group.ID, name)
		}
		seenTie[name] = true
	}
	tieCopy := make([]string, len(tieBreakers))
	copy(tieCopy, tieBreakers)

	maxCandidates := group.MaxCandidates
	if maxCandidates < 0 || maxCandidates > MaxCandidates {
		return nil, newError(CodeInvalidConfig,
			"策略组 %s 的 maxCandidates 必须在 0 到 %d 之间", group.ID, MaxCandidates)
	}

	return &compiledStrategy{
		group:         group,
		factors:       factors,
		weightTotal:   total,
		tieBreakers:   tieCopy,
		selection:     selection,
		maxCandidates: maxCandidates,
		excludeCool:   effectiveBool(group.Filter.ExcludeCooling, true),
		excludeSat:    effectiveBool(group.Filter.ExcludeSaturated, true),
		healthPolicy:  healthPolicy,
	}, nil
}

func revisionOf(cfg Config) string {
	payload, err := json.Marshal(cfg)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])[:16]
}

func cloneStrategyGroups(groups []StrategyGroup) []StrategyGroup {
	out := make([]StrategyGroup, len(groups))
	for i, group := range groups {
		out[i] = group
		out[i].Enabled = cloneBoolPtr(group.Enabled)
		out[i].Filter.Providers = append([]string(nil), group.Filter.Providers...)
		out[i].Filter.Kinds = append([]string(nil), group.Filter.Kinds...)
		if group.Filter.Tags != nil {
			tags := make(map[string]string, len(group.Filter.Tags))
			for key, value := range group.Filter.Tags {
				tags[key] = value
			}
			out[i].Filter.Tags = tags
		}
		out[i].Filter.ExcludeCooling = cloneBoolPtr(group.Filter.ExcludeCooling)
		out[i].Filter.ExcludeSaturated = cloneBoolPtr(group.Filter.ExcludeSaturated)
		if group.Factors != nil {
			factors := make(map[string]FactorRule, len(group.Factors))
			for name, rule := range group.Factors {
				rule.Unknown = cloneFloatPtr(rule.Unknown)
				factors[name] = rule
			}
			out[i].Factors = factors
		}
		out[i].TieBreaker = append([]string(nil), group.TieBreaker...)
	}
	return out
}

func cloneBoolPtr(value *bool) *bool {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}

func cloneFloatPtr(value *float64) *float64 {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
