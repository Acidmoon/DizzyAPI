package accounts

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
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
