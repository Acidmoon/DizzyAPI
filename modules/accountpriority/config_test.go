package accountpriority

import (
	"strconv"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

func TestEmptyConfigUsesBuiltInDefault(t *testing.T) {
	service, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	status := service.Status()
	if status.DefaultStrategy != "default" || status.Strategies != 1 {
		t.Fatalf("期望内置 default 策略，得到 %+v", status)
	}
	list := service.Strategies()
	if len(list.Strategies) != 1 || list.Strategies[0].ID != "default" {
		t.Fatalf("策略列表不对：%+v", list.Strategies)
	}
}

func TestConfigValidationRejectsBadStrategies(t *testing.T) {
	disabled := false
	base := func() StrategyGroup {
		return strategyWithFactors("ok", map[string]FactorRule{"health": {Weight: 1}})
	}

	cases := []struct {
		name   string
		config Config
		match  string
	}{
		{
			name: "重复 id",
			config: Config{Strategies: []StrategyGroup{
				base(), base(),
			}},
			match: "重复",
		},
		{
			name: "非法 id",
			config: Config{Strategies: []StrategyGroup{
				strategyWithFactors("Bad ID", map[string]FactorRule{"health": {Weight: 1}}),
			}},
			match: "不合法",
		},
		{
			name: "未知因子",
			config: Config{Strategies: []StrategyGroup{
				strategyWithFactors("ok", map[string]FactorRule{"magic": {Weight: 1}}),
			}},
			match: "未知因子",
		},
		{
			name: "权重全为零",
			config: Config{Strategies: []StrategyGroup{
				strategyWithFactors("ok", map[string]FactorRule{"health": {Weight: 0}}),
			}},
			match: "至少",
		},
		{
			name: "非法方向",
			config: Config{Strategies: []StrategyGroup{
				strategyWithFactors("ok", map[string]FactorRule{"latency": {Weight: 1, Direction: "up"}}),
			}},
			match: "direction",
		},
		{
			name: "固定分数因子写 asc",
			config: Config{Strategies: []StrategyGroup{
				strategyWithFactors("ok", map[string]FactorRule{"health": {Weight: 1, Direction: "asc"}}),
			}},
			match: "越大越好",
		},
		{
			name: "unknown 越界",
			config: Config{Strategies: []StrategyGroup{
				strategyWithFactors("ok", map[string]FactorRule{
					"health": {Weight: 1, Unknown: fptr(1.5)},
				}),
			}},
			match: "unknown",
		},
		{
			name: "非法 selection",
			config: Config{Strategies: []StrategyGroup{
				{
					ID:        "ok",
					Factors:   map[string]FactorRule{"health": {Weight: 1}},
					Selection: "random",
				},
			}},
			match: "selection",
		},
		{
			name: "非法 tieBreaker",
			config: Config{Strategies: []StrategyGroup{
				{
					ID:         "ok",
					Factors:    map[string]FactorRule{"health": {Weight: 1}},
					TieBreaker: []string{"magic"},
				},
			}},
			match: "tieBreaker",
		},
		{
			name: "默认策略不存在",
			config: Config{
				DefaultStrategy: "missing",
				Strategies: []StrategyGroup{
					base(),
				},
			},
			match: "默认策略组",
		},
		{
			name: "默认策略被禁用",
			config: Config{
				DefaultStrategy: "ok",
				Strategies: []StrategyGroup{
					{
						ID:      "ok",
						Enabled: &disabled,
						Factors: map[string]FactorRule{"health": {Weight: 1}},
					},
				},
			},
			match: "至少要启用",
		},
		{
			name: "非法健康策略",
			config: Config{Strategies: []StrategyGroup{
				{
					ID:      "ok",
					Filter:  Filter{Health: "healthy_only"},
					Factors: map[string]FactorRule{"health": {Weight: 1}},
				},
			}},
			match: "filter.health",
		},
		{
			name: "maxCandidates 越界",
			config: Config{Strategies: []StrategyGroup{
				{
					ID:            "ok",
					Factors:       map[string]FactorRule{"health": {Weight: 1}},
					MaxCandidates: -1,
				},
			}},
			match: "maxCandidates",
		},
		{
			name: "禁用的策略也要校验",
			config: Config{Strategies: []StrategyGroup{
				base(),
				{
					ID:      "off",
					Enabled: &disabled,
					Factors: map[string]FactorRule{"magic": {Weight: 1}},
				},
			}},
			match: "未知因子",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := New(testCase.config)
			if err == nil {
				t.Fatal("期望校验失败")
			}
			if !IsCode(err, CodeInvalidConfig) {
				t.Fatalf("期望 %s，得到 %v", CodeInvalidConfig, err)
			}
			if !strings.Contains(err.Error(), testCase.match) {
				t.Fatalf("错误信息应包含 %q，得到 %q", testCase.match, err.Error())
			}
		})
	}
}

func TestTooManyStrategies(t *testing.T) {
	groups := make([]StrategyGroup, 0, MaxStrategies+1)
	for index := 0; index <= MaxStrategies; index++ {
		groups = append(groups, strategyWithFactors(
			"s"+strconv.Itoa(index),
			map[string]FactorRule{"health": {Weight: 1}},
		))
	}
	_, err := New(Config{Strategies: groups})
	if err == nil || !strings.Contains(err.Error(), "最多") {
		t.Fatalf("期望策略数量上限错误，得到 %v", err)
	}
}

func TestDisabledStrategyCannotBeSelected(t *testing.T) {
	enabled := true
	disabled := false
	service, err := New(Config{
		DefaultStrategy: "on",
		Strategies: []StrategyGroup{
			{ID: "on", Enabled: &enabled, Factors: map[string]FactorRule{"health": {Weight: 1}}},
			{ID: "off", Enabled: &disabled, Factors: map[string]FactorRule{"health": {Weight: 1}}},
		},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = service.Score(ScoreRequest{Strategy: "off"})
	if err == nil || !IsCode(err, CodeStrategyNotFound) {
		t.Fatalf("禁用的策略不应可选，得到 %v", err)
	}
}

func TestRegisterAddsServiceAndStage(t *testing.T) {
	registry := contracts.NewRegistry()
	service, err := Register(registry, Config{})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if service == nil {
		t.Fatal("Register 应返回服务实例")
	}
	if registry.Services()[ServiceName] == nil {
		t.Fatal("服务没有注册进注册表")
	}
	impl, ok := registry.Lookup(ServiceName)
	if !ok {
		t.Fatal("Lookup 找不到服务")
	}
	scorer, ok := impl.(contracts.AccountScorer)
	if !ok {
		t.Fatal("服务没有实现 contracts.AccountScorer")
	}
	if _, err := scorer.Score(contracts.ScoreRequest{}); err != nil {
		t.Fatalf("跨模块接口调用失败：%v", err)
	}
	stages := registry.Stages()
	if len(stages) != 1 || stages[0].Name() != StageName {
		t.Fatalf("阶段没有注册进注册表：%+v", stages)
	}
	if stages[0].Phase() != contracts.PhasePre || !stages[0].Required() || stages[0].NeedBody() {
		t.Fatalf("阶段属性不对：phase=%v required=%v needBody=%v",
			stages[0].Phase(), stages[0].Required(), stages[0].NeedBody())
	}
}
