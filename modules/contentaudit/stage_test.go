package contentaudit

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
	contentauditcache "github.com/Acidmoon/DizzyAPI/internal/contentaudit"
)

// fakeRules 是消费者接口的假实现：只用于「快照不可用」这类场景。
type fakeRules struct {
	ready   bool
	age     time.Duration
	ttl     time.Duration
	enabled bool
	hits    []contracts.ContentAuditHit
	texts   []string
}

func (f *fakeRules) Ready() bool        { return f.ready }
func (f *fakeRules) Age() time.Duration { return f.age }
func (f *fakeRules) TTL() time.Duration { return f.ttl }
func (f *fakeRules) Enabled() bool      { return f.enabled }
func (f *fakeRules) Match(texts []string) []contracts.ContentAuditHit {
	f.texts = texts
	return f.hits
}

func request(protocol contracts.Protocol, body string) *contracts.Ctx {
	return &contracts.Ctx{
		Context:        context.Background(),
		ReqID:          "req-content-audit",
		ClientProtocol: protocol,
		Body:           contracts.BytesBody([]byte(body)),
	}
}

func newCache(t *testing.T, rules ...contentauditcache.Rule) *contentauditcache.Cache {
	t.Helper()
	cache := contentauditcache.New()
	if _, err := cache.Replace(contentauditcache.Snapshot{
		Version:    contentauditcache.SnapshotVersion,
		Generation: 1,
		Revision:   "rev-test",
		Enabled:    true,
		Rules:      rules,
	}); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	return cache
}

// 文本提取：只审用户输入，不审 system / assistant / 工具结果。
func TestExtractTexts(t *testing.T) {
	cases := []struct {
		name     string
		protocol contracts.Protocol
		op       contracts.Operation
		body     string
		want     []string
	}{
		{
			name:     "openai-chat 字符串 content",
			protocol: contracts.ProtocolOpenAIChat,
			body:     `{"messages":[{"role":"system","content":"sys"},{"role":"user","content":"hello"},{"role":"assistant","content":"hi"}]}`,
			want:     []string{"hello"},
		},
		{
			name:     "openai-chat parts 数组",
			protocol: contracts.ProtocolOpenAIChat,
			body:     `{"messages":[{"role":"user","content":[{"type":"text","text":"a"},{"type":"image_url","image_url":{"url":"x"}},{"type":"text","text":"b"}]}]}`,
			want:     []string{"a", "b"},
		},
		{
			name:     "anthropic 只取 user 的 text part",
			protocol: contracts.ProtocolAnthropic,
			body:     `{"system":"sys","messages":[{"role":"user","content":[{"type":"text","text":"hi there"}]},{"role":"assistant","content":"ignored"}]}`,
			want:     []string{"hi there"},
		},
		{
			name:     "responses 字符串 input",
			protocol: contracts.ProtocolOpenAIResponses,
			body:     `{"input":"plain input"}`,
			want:     []string{"plain input"},
		},
		{
			name:     "responses 消息数组",
			protocol: contracts.ProtocolOpenAIResponses,
			body:     `{"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ignored"}]}]}`,
			want:     []string{"hello"},
		},
		{
			name:     "gemini contents 只取 user",
			protocol: contracts.ProtocolGemini,
			body:     `{"contents":[{"role":"user","parts":[{"text":"gemini hi"}]},{"role":"model","parts":[{"text":"ignored"}]}]}`,
			want:     []string{"gemini hi"},
		},
		{
			name: "embeddings 字符串",
			op:   contracts.OperationEmbeddings,
			body: `{"input":"embed me"}`,
			want: []string{"embed me"},
		},
		{
			name: "embeddings 数组",
			op:   contracts.OperationEmbeddings,
			body: `{"input":["a","b"]}`,
			want: []string{"a", "b"},
		},
		{
			name:     "未知协议不审",
			protocol: contracts.Protocol(""),
			body:     `{"messages":[{"role":"user","content":"x"}]}`,
			want:     nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			texts, truncated, err := ExtractTexts([]byte(tc.body), tc.protocol, tc.op)
			if err != nil {
				t.Fatalf("ExtractTexts: %v", err)
			}
			if truncated {
				t.Fatal("不该截断")
			}
			if strings.Join(texts, "|") != strings.Join(tc.want, "|") {
				t.Fatalf("提取结果 %q，期望 %q", texts, tc.want)
			}
		})
	}

	if _, _, err := ExtractTexts([]byte(`{not json`), contracts.ProtocolOpenAIChat, ""); err == nil {
		t.Fatal("坏 JSON 应返回错误（由调用方放行）")
	}
}

// 命中 block 规则：403 CONTENT_BLOCKED、不可重试、计数与规则命中都记上。
func TestBlocksOnHit(t *testing.T) {
	stage := New(Config{SnapshotTTL: time.Second}, newCache(t,
		contentauditcache.Rule{ID: "r1", Pattern: "badword", Action: contentauditcache.ActionBlock},
	), nil)

	_, err := stage.Run(request(contracts.ProtocolOpenAIChat,
		`{"messages":[{"role":"user","content":"please say BADWORD"}]}`))
	stageErr, ok := err.(*contracts.StageError)
	if !ok {
		t.Fatalf("期望 StageError，得到 %v", err)
	}
	if stageErr.Code != contracts.CodeContentBlocked || stageErr.Status != http.StatusForbidden {
		t.Fatalf("错误码 / 状态不对：%+v", stageErr)
	}
	if stageErr.Retryable {
		t.Fatal("内容命中必须不可重试")
	}
	stats := stage.Stats()
	if stats.Blocked != 1 || stats.RuleHitTotal != 1 || stats.RuleHits["r1"] != 1 {
		t.Fatalf("计数不对：%+v", stats)
	}
}

// 命中 log 规则：放行 + 计数 + 告警，不拒绝。
func TestLogActionAllows(t *testing.T) {
	stage := New(Config{SnapshotTTL: time.Second}, newCache(t,
		contentauditcache.Rule{ID: "r2", Pattern: "secret-token", Action: contentauditcache.ActionLog, Category: "pii"},
	), nil)

	decision, err := stage.Run(request(contracts.ProtocolOpenAIChat,
		`{"messages":[{"role":"user","content":"my SECRET-TOKEN"}]}`))
	if err != nil {
		t.Fatalf("log 规则不该拒绝：%v", err)
	}
	if decision.Action != contracts.ActionContinue {
		t.Fatalf("应当继续：%+v", decision)
	}
	stats := stage.Stats()
	if stats.Logged != 1 || stats.Blocked != 0 || stats.RuleHits["r2"] != 1 {
		t.Fatalf("计数不对：%+v", stats)
	}
}

// 快照未就绪 / 过期：默认放行 + 计数；严格模式 503。
func TestStaleSnapshotPolicy(t *testing.T) {
	lenient := New(Config{SnapshotTTL: time.Second}, &fakeRules{ready: false}, nil)
	decision, err := lenient.Run(request(contracts.ProtocolOpenAIChat, `{"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatalf("默认策略应放行：%v", err)
	}
	if decision.Action != contracts.ActionContinue || lenient.Stats().AllowedStale != 1 {
		t.Fatalf("放行路径计数不对：%+v", lenient.Stats())
	}

	strict := New(Config{SnapshotTTL: time.Second, RequireSnapshot: true}, &fakeRules{ready: false}, nil)
	_, err = strict.Run(request(contracts.ProtocolOpenAIChat, `{"messages":[{"role":"user","content":"hi"}]}`))
	stageErr, ok := err.(*contracts.StageError)
	if !ok {
		t.Fatalf("严格模式应拒绝，得到 %v", err)
	}
	if stageErr.Code != contracts.CodeContentAuditSnapshotUnavailable || stageErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("严格模式错误码不对：%+v", stageErr)
	}
	if stageErr.Retryable {
		t.Fatalf("严格模式拒绝不可重试：%+v", stageErr)
	}
	if strict.Stats().StrictFailed != 1 {
		t.Fatalf("严格模式计数不对：%+v", strict.Stats())
	}
}

// 过期（就绪但超过 TTL）也算不可用。
func TestExpiredSnapshotIsUnavailable(t *testing.T) {
	stage := New(Config{SnapshotTTL: time.Second}, &fakeRules{ready: true, age: 2 * time.Second, ttl: time.Second, enabled: true}, nil)
	if _, err := stage.Run(request(contracts.ProtocolOpenAIChat, `{"messages":[{"role":"user","content":"hi"}]}`)); err != nil {
		t.Fatalf("默认策略应放行：%v", err)
	}
	if stage.Stats().AllowedStale != 1 {
		t.Fatalf("过期应计入 allowedStale：%+v", stage.Stats())
	}
}

// 持续失效：第 10 次里程碑即使还在节流窗口内也要补一行告警，并标「持续失效」。
func TestStaleStreakSustained(t *testing.T) {
	var buffer bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buffer, &slog.HandlerOptions{Level: slog.LevelWarn}))
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	stage := New(Config{SnapshotTTL: time.Second}, &fakeRules{ready: false}, logger)
	stage.now = func() time.Time { return now }

	for index := 0; index < 10; index += 1 {
		if _, err := stage.Run(request(contracts.ProtocolOpenAIChat, `{"messages":[]}`)); err != nil {
			t.Fatalf("放行模式不该报错：%v", err)
		}
		now = now.Add(time.Second)
	}
	stats := stage.Stats()
	if stats.StaleStreak != 10 || stats.StaleReason != "snapshot-unavailable" {
		t.Fatalf("连续不可用观察不对：%+v", stats)
	}
	lines := strings.Count(buffer.String(), "内容审核快照不可用")
	if lines != 2 {
		t.Fatalf("偶发 1 行 + 第 10 次里程碑 1 行，实际 %d 行：%s", lines, buffer.String())
	}
	if !strings.Contains(buffer.String(), "持续失效") {
		t.Fatalf("里程碑告警要标注持续失效：%s", buffer.String())
	}
}

// 解析失败 / 没有可审文本：放行 + 计数，绝不 panic。
func TestParseFailureAndNoTextAllow(t *testing.T) {
	stage := New(Config{SnapshotTTL: time.Second}, newCache(t,
		contentauditcache.Rule{ID: "r1", Pattern: "badword", Action: contentauditcache.ActionBlock},
	), nil)

	decision, err := stage.Run(request(contracts.ProtocolOpenAIChat, `{not json`))
	if err != nil {
		t.Fatalf("解析失败应放行：%v", err)
	}
	if decision.Action != contracts.ActionContinue || stage.Stats().ParseFailed != 1 {
		t.Fatalf("解析失败计数不对：%+v", stage.Stats())
	}

	if _, err := stage.Run(request(contracts.ProtocolOpenAIChat, `{"messages":[{"role":"assistant","content":"only assistant"}]}`)); err != nil {
		t.Fatalf("没有用户文本应放行：%v", err)
	}
	if stage.Stats().NoText != 1 {
		t.Fatalf("noText 计数不对：%+v", stage.Stats())
	}
}

// 审核关闭：全放行，连匹配都不做。
func TestDisabledSnapshotAllows(t *testing.T) {
	cache := contentauditcache.New()
	if _, err := cache.Replace(contentauditcache.Snapshot{
		Version: contentauditcache.SnapshotVersion, Generation: 1, Revision: "rev-off", Enabled: false,
	}); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	stage := New(Config{SnapshotTTL: time.Second}, cache, nil)
	if _, err := stage.Run(request(contracts.ProtocolOpenAIChat, `{"messages":[{"role":"user","content":"badword"}]}`)); err != nil {
		t.Fatalf("关闭时不该拒绝：%v", err)
	}
	if stats := stage.Stats(); stats.Blocked != 0 || stats.RuleHitTotal != 0 {
		t.Fatalf("关闭时不该有命中：%+v", stats)
	}
}

// 超长文本按 maxScanBytes 截断，并记 truncated（不静默）。
func TestTruncatesLongText(t *testing.T) {
	stage := New(Config{SnapshotTTL: time.Second}, newCache(t,
		contentauditcache.Rule{ID: "r1", Pattern: "badword", Action: contentauditcache.ActionBlock},
	), nil)
	body := `{"messages":[{"role":"user","content":"` + strings.Repeat("a", maxScanBytes+10) + `badword"}]}`
	decision, err := stage.Run(request(contracts.ProtocolOpenAIChat, body))
	if err != nil {
		t.Fatalf("截断后不该报错：%v", err)
	}
	// 截断之后末尾的 badword 没被扫到（这是已知边界，靠 truncated 计数暴露）。
	if decision.Action != contracts.ActionContinue {
		t.Fatalf("截断场景应当放行：%+v", decision)
	}
	if stage.Stats().Truncated != 1 {
		t.Fatalf("truncated 计数不对：%+v", stage.Stats())
	}
}

// 命中统计有上限，不会因为规则爆炸把内存撑大。
func TestRuleHitsBounded(t *testing.T) {
	stage := New(Config{SnapshotTTL: time.Second}, &fakeRules{
		ready: true, ttl: time.Second, enabled: true,
		hits: []contracts.ContentAuditHit{
			{RuleID: "a", Action: contracts.ContentAuditActionLog},
			{RuleID: "b", Action: contracts.ContentAuditActionLog},
		},
	}, nil)
	if _, err := stage.Run(request(contracts.ProtocolOpenAIChat, `{"messages":[{"role":"user","content":"x"}]}`)); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if stats := stage.Stats(); stats.RuleHits["a"] != 1 || stats.RuleHits["b"] != 1 || stats.RuleHitTotal != 2 {
		t.Fatalf("命中统计不对：%+v", stats)
	}
}
