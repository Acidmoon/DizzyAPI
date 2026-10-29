package contentaudit_test

import (
	"strings"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/contentaudit"
)

func snapshot(generation int64, revision string, enabled bool, rules ...contentaudit.Rule) contentaudit.Snapshot {
	return contentaudit.Snapshot{
		Version:    contentaudit.SnapshotVersion,
		Generation: generation,
		Revision:   revision,
		Enabled:    enabled,
		Rules:      rules,
	}
}

func blockRule(id, pattern string) contentaudit.Rule {
	return contentaudit.Rule{ID: id, Pattern: pattern, Action: contentaudit.ActionBlock}
}

func logRule(id, pattern string) contentaudit.Rule {
	return contentaudit.Rule{ID: id, Pattern: pattern, Action: contentaudit.ActionLog, Category: "pii"}
}

func TestReplaceAndMatchIsCaseInsensitive(t *testing.T) {
	cache := contentaudit.New()
	result, err := cache.Replace(snapshot(1, "rev-1", true,
		blockRule("r1", "BadWord"),
		logRule("r2", "secret-token"),
	))
	if err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if !result.Ready || result.Rules != 2 || !result.Enabled || result.Revision != "rev-1" {
		t.Fatalf("结果不对：%+v", result)
	}

	hits := cache.Match([]string{"hello BADWORD world"})
	if len(hits) != 1 || hits[0].RuleID != "r1" || hits[0].Action != contracts.ContentAuditActionBlock {
		t.Fatalf("大小写不敏感的子串匹配失败：%+v", hits)
	}

	// 命中 log 规则：动作与分类要带出来。
	hits = cache.Match([]string{"my SECRET-TOKEN is here"})
	if len(hits) != 1 || hits[0].Action != contracts.ContentAuditActionLog || hits[0].Category != "pii" {
		t.Fatalf("log 规则命中不对：%+v", hits)
	}

	// 同一规则只报一次（多段文本重复命中）。
	hits = cache.Match([]string{"badword", "BADWORD again"})
	if len(hits) != 1 {
		t.Fatalf("同一规则应去重：%+v", hits)
	}

	// 没命中。
	if hits := cache.Match([]string{"clean text"}); hits != nil {
		t.Fatalf("不该命中：%+v", hits)
	}
}

// 审核关闭时 Go 侧全放行（TS 推 enabled=false + 空规则）。
func TestDisabledSnapshotAllowsEverything(t *testing.T) {
	cache := contentaudit.New()
	if _, err := cache.Replace(snapshot(1, "rev-off", false)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if cache.Enabled() {
		t.Fatal("enabled=false 时不该报告开启")
	}
	if hits := cache.Match([]string{"badword"}); hits != nil {
		t.Fatalf("关闭时不该匹配：%+v", hits)
	}
}

func TestRejectsInvalidSnapshots(t *testing.T) {
	cases := []struct {
		name     string
		snapshot contentaudit.Snapshot
		code     string
	}{
		{"版本不对", contentaudit.Snapshot{Version: 2, Generation: 1, Revision: "r"}, contentaudit.CodeInvalidSnapshot},
		{"generation 非正", snapshot(0, "r", true), contentaudit.CodeInvalidSnapshot},
		{"revision 为空", contentaudit.Snapshot{Version: 1, Generation: 1}, contentaudit.CodeInvalidSnapshot},
		{"规则 id 为空", snapshot(1, "r", true, blockRule("", "x")), contentaudit.CodeInvalidSnapshot},
		{"规则 id 重复", snapshot(1, "r", true, blockRule("a", "x"), logRule("a", "y")), contentaudit.CodeInvalidSnapshot},
		{"pattern 为空", snapshot(1, "r", true, blockRule("a", "  ")), contentaudit.CodeInvalidSnapshot},
		{"pattern 超长", snapshot(1, "r", true, blockRule("a", strings.Repeat("x", contentaudit.MaxPatternBytes+1))), contentaudit.CodeInvalidSnapshot},
		{"pattern 重复（忽略大小写）", snapshot(1, "r", true, blockRule("a", "Bad"), logRule("b", "bad")), contentaudit.CodeDuplicatePattern},
		{"action 非法", snapshot(1, "r", true, contentaudit.Rule{ID: "a", Pattern: "x", Action: "drop"}), contentaudit.CodeInvalidSnapshot},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cache := contentaudit.New()
			_, err := cache.Replace(tc.snapshot)
			if err == nil {
				t.Fatal("非法快照必须整份拒绝")
			}
			if !contentaudit.IsError(err, tc.code) {
				t.Fatalf("错误码不对：%v（期望 %s）", err, tc.code)
			}
			if cache.Ready() {
				t.Fatal("被拒绝的快照不能留下任何状态")
			}
		})
	}
}

// generation 回退 / 同代内容冲突都不覆盖当前快照；同代同 revision 幂等。
func TestRejectsGenerationRollback(t *testing.T) {
	cache := contentaudit.New()
	if _, err := cache.Replace(snapshot(10, "rev-10", true, blockRule("r1", "bad"))); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	if _, err := cache.Replace(snapshot(9, "rev-9", true, blockRule("r1", "evil"))); err == nil {
		t.Fatal("generation 回退必须拒绝")
	} else if !contentaudit.IsError(err, contentaudit.CodeStaleSnapshot) {
		t.Fatalf("错误码不对：%v", err)
	}
	if hits := cache.Match([]string{"bad"}); len(hits) != 1 {
		t.Fatalf("拒绝后不能覆盖旧快照：%+v", hits)
	}

	if _, err := cache.Replace(snapshot(10, "rev-other", true, blockRule("r1", "evil"))); err == nil {
		t.Fatal("同 generation 不同 revision 必须拒绝")
	}

	result, err := cache.Replace(snapshot(10, "rev-10", true, blockRule("r1", "bad")))
	if err != nil {
		t.Fatalf("同代同 revision 应幂等成功：%v", err)
	}
	if result.Rules != 1 || result.Generation != 10 {
		t.Fatalf("幂等结果不对：%+v", result)
	}
}

func TestStateReportsStaleness(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	cache := contentaudit.New(contentaudit.WithTTL(time.Second), contentaudit.WithClock(func() time.Time { return now }))

	empty := cache.State()
	if empty.Ready || empty.Size != 0 || empty.TtlMs != 1_000 {
		t.Fatalf("空缓存状态不对：%+v", empty)
	}

	if _, err := cache.Replace(snapshot(1, "rev-1", true, blockRule("r1", "bad"))); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	state := cache.State()
	if !state.Ready || state.Size != 1 || !state.Enabled || state.Stale || state.AgeMs != 0 {
		t.Fatalf("新鲜状态不对：%+v", state)
	}

	now = now.Add(1500 * time.Millisecond)
	state = cache.State()
	if !state.Stale || state.AgeMs != 1500 {
		t.Fatalf("过期状态不对：%+v", state)
	}
	if !cache.Stale() {
		t.Fatal("Stale() 应为真")
	}
}

// 空规则快照是合法的：审核开着但一条规则都没有 = 全放行。
func TestEmptyRuleSnapshotIsReady(t *testing.T) {
	cache := contentaudit.New()
	if _, err := cache.Replace(snapshot(1, "rev-empty", true)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if !cache.Ready() || !cache.Enabled() {
		t.Fatalf("空规则快照应就绪且开启：%+v", cache.State())
	}
	if hits := cache.Match([]string{"anything"}); hits != nil {
		t.Fatalf("没有规则不该命中：%+v", hits)
	}
}
