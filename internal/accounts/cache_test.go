package accounts

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

func snapshot(accounts ...Account) Snapshot {
	return Snapshot{Version: SnapshotVersion, Generation: "g1", Accounts: accounts}
}

func account(id, token string) Account {
	return Account{
		AccountID: id,
		Provider:  "openai",
		Kind:      "api_key",
		BaseURL:   "https://api.example.com/v1",
		Token:     token,
		Priority:  0,
	}
}

func TestReplaceAndRead(t *testing.T) {
	cache := New()
	result, err := cache.Replace(snapshot(account("acc-1", "sk-one"), account("acc-2", "sk-two")))
	if err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if result.Accounts != 2 || result.Revision == "" {
		t.Fatalf("结果不对：%+v", result)
	}

	candidates := cache.Candidates()
	if len(candidates) != 2 || candidates[0].AccountID != "acc-1" {
		t.Fatalf("候选不对：%+v", candidates)
	}
	for _, candidate := range candidates {
		if candidate.Health != "unknown" {
			t.Fatalf("未知健康状态必须是一等状态：%+v", candidate)
		}
	}

	credential, ok := cache.Credential("acc-2")
	if !ok || credential.AccessToken != "sk-two" {
		t.Fatalf("凭据不对：%+v ok=%v", credential, ok)
	}
	if _, ok := cache.Credential("missing"); ok {
		t.Fatal("不存在的账号不应返回凭据")
	}
}

func TestReplaceIsAtomic(t *testing.T) {
	cache := New()
	if _, err := cache.Replace(snapshot(account("acc-1", "sk-one"))); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	bad := snapshot(account("acc-2", "sk-two"))
	bad.Accounts = append(bad.Accounts, account("acc-2", "sk-three"))
	if _, err := cache.Replace(bad); err == nil {
		t.Fatal("重复 id 必须整份拒绝")
	}
	if _, ok := cache.Credential("acc-2"); ok {
		t.Fatal("拒绝的快照不应部分应用")
	}
	if _, ok := cache.Credential("acc-1"); !ok {
		t.Fatal("旧快照必须保留")
	}
}

func TestExpiredAccountsAreNotCandidates(t *testing.T) {
	cache := New()
	expired := account("acc-old", "sk-old")
	expired.ExpiresAt = timePtr(time.Now().Add(-time.Minute))
	expiring := account("acc-soon", "sk-soon")
	expiring.ExpiresAt = timePtr(time.Now().Add(5 * time.Second))
	fresh := account("acc-fresh", "sk-fresh")
	fresh.ExpiresAt = timePtr(time.Now().Add(time.Hour))

	if _, err := cache.Replace(snapshot(expired, expiring, fresh)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	candidates := cache.Candidates()
	if len(candidates) != 1 || candidates[0].AccountID != "acc-fresh" {
		t.Fatalf("过期账号不应成为候选：%+v", candidates)
	}
	if _, ok := cache.Credential("acc-old"); ok {
		t.Fatal("过期账号不应返回凭据")
	}
}

func TestRejectsInvalidAccount(t *testing.T) {
	cases := []struct {
		name    string
		account Account
	}{
		{"empty id", Account{Provider: "openai", BaseURL: "https://x.test", Token: "t"}},
		{"empty provider", Account{AccountID: "a", BaseURL: "https://x.test", Token: "t"}},
		{"bad scheme", Account{AccountID: "a", Provider: "openai", BaseURL: "ftp://x.test", Token: "t"}},
		{"user info", Account{AccountID: "a", Provider: "openai", BaseURL: "https://u:p@x.test", Token: "t"}},
		{"empty token", Account{AccountID: "a", Provider: "openai", BaseURL: "https://x.test"}},
		{"bad kind", Account{AccountID: "a", Provider: "openai", Kind: "unknown", BaseURL: "https://x.test", Token: "t"}},
		{"bad protocol", Account{AccountID: "a", Provider: "openai", BaseURL: "https://x.test", Token: "t", Protocol: "gemini"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cache := New()
			if _, err := cache.Replace(snapshot(tc.account)); err == nil {
				t.Fatal("非法账号必须被拒绝")
			}
		})
	}
}

func TestProtocolFlowsToCredentialAndRevision(t *testing.T) {
	cache := New()
	withoutProtocol := account("acc-1", "sk-one")
	if _, err := cache.Replace(snapshot(withoutProtocol)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	baseRevision := cache.State().Revision

	// 空协议合法（旧快照兼容），凭据里协议为空。
	credential, ok := cache.Credential("acc-1")
	if !ok || credential.Protocol != "" {
		t.Fatalf("旧快照协议应为空：%+v ok=%v", credential, ok)
	}

	// 声明协议后 revision 必须变化（协议进内容哈希）。
	withProtocol := account("acc-1", "sk-one")
	withProtocol.Protocol = "anthropic"
	if _, err := cache.Replace(snapshot(withProtocol)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if cache.State().Revision == baseRevision {
		t.Fatal("协议变化必须改变 revision")
	}
	credential, ok = cache.Credential("acc-1")
	if !ok || credential.Protocol != "anthropic" {
		t.Fatalf("凭据应带协议：%+v ok=%v", credential, ok)
	}
}

func TestStateDoesNotContainTokens(t *testing.T) {
	cache := New()
	if _, err := cache.Replace(snapshot(account("acc-1", "sk-very-secret"))); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	payload, err := json.Marshal(cache.State())
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(payload), "sk-very-secret") {
		t.Fatalf("状态泄漏了令牌：%s", payload)
	}
}

func TestConcurrentReadersAndWriters(t *testing.T) {
	cache := New()
	if _, err := cache.Replace(snapshot(account("acc-0", "sk-0"))); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	var wg sync.WaitGroup
	for writer := 0; writer < 4; writer++ {
		wg.Add(1)
		go func(writer int) {
			defer wg.Done()
			for index := 0; index < 200; index++ {
				id := fmt.Sprintf("acc-%d", (writer*200+index)%16)
				snapshot := snapshot(account(id, "sk-"+id))
				if _, err := cache.Replace(snapshot); err != nil {
					t.Errorf("Replace: %v", err)
					return
				}
			}
		}(writer)
	}
	for reader := 0; reader < 32; reader++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := 0; index < 500; index++ {
				_ = cache.Candidates()
				_, _ = cache.Credential("acc-0")
				_ = cache.State()
			}
		}()
	}
	wg.Wait()
}

func timePtr(value time.Time) *time.Time { return &value }

func floatPtr(value float64) *float64 { return &value }

// 这条用例是本线的验收关键：weight / concurrency / health / tags 必须真的从快照透传到
// Candidate。少了这一步，TS 侧加了字段、Go 侧测试还全绿，调度仍然只按 priority 打分。
func TestCandidatesPassThroughSchedulingFields(t *testing.T) {
	rich := account("acc-rich", "sk-rich")
	rich.Weight = floatPtr(2.5)
	rich.Concurrency = 4
	rich.Health = "degraded"
	rich.Tags = map[string]string{"label": "", "tier": "pro"}
	plain := account("acc-plain", "sk-plain")

	cache := New()
	if _, err := cache.Replace(snapshot(rich, plain)); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	candidates := cache.Candidates()
	if len(candidates) != 2 {
		t.Fatalf("候选数量不对：%+v", candidates)
	}
	byID := map[string]contracts.AccountCandidate{}
	for _, candidate := range candidates {
		byID[candidate.AccountID] = candidate
	}

	got := byID["acc-rich"]
	if got.Weight == nil || *got.Weight != 2.5 {
		t.Fatalf("weight 没有透传：%+v", got.Weight)
	}
	if got.Concurrency != 4 {
		t.Fatalf("concurrency 没有透传：%d", got.Concurrency)
	}
	if got.Health != contracts.HealthDegraded {
		t.Fatalf("health 没有透传：%q", got.Health)
	}
	if !reflect.DeepEqual(got.Tags, map[string]string{"label": "", "tier": "pro"}) {
		t.Fatalf("tags 没有透传：%+v", got.Tags)
	}

	// 旧快照（没声明这三个键）：健康状态必须是 unknown，而不是「默认健康」。
	old := byID["acc-plain"]
	if old.Weight != nil {
		t.Fatalf("未声明权重时不该有值：%v", *old.Weight)
	}
	if old.Concurrency != 0 {
		t.Fatalf("未声明并发上限时应为 0：%d", old.Concurrency)
	}
	if old.Health != contracts.HealthUnknown {
		t.Fatalf("未声明健康状态必须是 unknown：%q", old.Health)
	}
}

func TestRejectsInvalidSchedulingFields(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Account)
	}{
		{"zero weight", func(a *Account) { a.Weight = floatPtr(0) }},
		{"negative weight", func(a *Account) { a.Weight = floatPtr(-1) }},
		{"NaN weight", func(a *Account) { a.Weight = floatPtr(math.NaN()) }},
		{"infinite weight", func(a *Account) { a.Weight = floatPtr(math.Inf(1)) }},
		{"huge weight", func(a *Account) { a.Weight = floatPtr(MaxWeight + 1) }},
		{"negative concurrency", func(a *Account) { a.Concurrency = -1 }},
		{"huge concurrency", func(a *Account) { a.Concurrency = MaxConcurrency + 1 }},
		{"bad health", func(a *Account) { a.Health = "sick" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bad := account("acc-bad", "sk-bad")
			tc.mutate(&bad)
			cache := New()
			if _, err := cache.Replace(snapshot(bad)); err == nil {
				t.Fatal("非法字段必须整份拒绝")
			}
		})
	}
}

func TestRevisionChangesWhenOnlyWeightChanges(t *testing.T) {
	cache := New()
	first := account("acc-1", "sk-one")
	first.Weight = floatPtr(1)
	if _, err := cache.Replace(snapshot(first)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	before := cache.State().Revision

	second := account("acc-1", "sk-one")
	second.Weight = floatPtr(2)
	if _, err := cache.Replace(snapshot(second)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if cache.State().Revision == before {
		t.Fatal("只改权重也必须改变 revision")
	}

	third := account("acc-1", "sk-one")
	third.Health = "unhealthy"
	if _, err := cache.Replace(snapshot(third)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if cache.State().Revision == before {
		t.Fatal("健康状态变化也必须改变 revision")
	}

	fourth := account("acc-1", "sk-one")
	fourth.Concurrency = 8
	if _, err := cache.Replace(snapshot(fourth)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if cache.State().Revision == before {
		t.Fatal("并发上限变化也必须改变 revision")
	}
}
