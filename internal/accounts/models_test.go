package accounts

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestModelsUnionDedupesAndSorts(t *testing.T) {
	cache := New()
	first := account("acc-1", "sk-1")
	first.Models = []string{"gpt-4o", "claude-sonnet-4-5"}
	second := account("acc-2", "sk-2")
	second.Models = []string{"claude-sonnet-4-5", "gpt-4o-mini"}
	// 未声明模型的账号不贡献任何模型名。
	third := account("acc-3", "sk-3")

	if _, err := cache.Replace(snapshot(first, second, third)); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	got := cache.Models()
	want := []string{"claude-sonnet-4-5", "gpt-4o", "gpt-4o-mini"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("模型并集不对：got=%v want=%v", got, want)
	}
}

func TestModelsSkipsUnusableAccounts(t *testing.T) {
	cache := New()
	expired := account("acc-old", "sk-old")
	expired.Models = []string{"old-only"}
	expired.ExpiresAt = timePtr(time.Now().Add(-time.Minute))
	fresh := account("acc-new", "sk-new")
	fresh.Models = []string{"new-only"}

	if _, err := cache.Replace(snapshot(expired, fresh)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	got := cache.Models()
	if len(got) != 1 || got[0] != "new-only" {
		t.Fatalf("过期账号的模型不应出现：%v", got)
	}
}

func TestModelsAndModelMapFlowToCredentialAndCandidates(t *testing.T) {
	cache := New()
	entry := account("acc-1", "sk-1")
	entry.Models = []string{"claude-sonnet-4-5"}
	entry.ModelMap = map[string]string{"claude-sonnet-4-5": "claude-sonnet-4-5-20250929"}

	if _, err := cache.Replace(snapshot(entry)); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	credential, ok := cache.Credential("acc-1")
	if !ok {
		t.Fatal("凭据缺失")
	}
	if len(credential.Models) != 1 || credential.Models[0] != "claude-sonnet-4-5" {
		t.Fatalf("凭据未带 models：%+v", credential.Models)
	}
	if credential.ModelMap["claude-sonnet-4-5"] != "claude-sonnet-4-5-20250929" {
		t.Fatalf("凭据未带 modelMap：%+v", credential.ModelMap)
	}

	candidates := cache.Candidates()
	if len(candidates) != 1 || len(candidates[0].Models) != 1 || candidates[0].Models[0] != "claude-sonnet-4-5" {
		t.Fatalf("候选未带 models：%+v", candidates)
	}
}

func TestModelFieldsChangeRevision(t *testing.T) {
	cache := New()
	base := account("acc-1", "sk-1")
	if _, err := cache.Replace(snapshot(base)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	baseRevision := cache.State().Revision

	withModels := account("acc-1", "sk-1")
	withModels.Models = []string{"gpt-4o"}
	if _, err := cache.Replace(snapshot(withModels)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	modelsRevision := cache.State().Revision
	if modelsRevision == baseRevision {
		t.Fatal("models 变化必须改变 revision")
	}

	withMap := account("acc-1", "sk-1")
	withMap.Models = []string{"gpt-4o"}
	withMap.ModelMap = map[string]string{"gpt-4o": "gpt-4o-2024"}
	if _, err := cache.Replace(snapshot(withMap)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if cache.State().Revision == modelsRevision {
		t.Fatal("modelMap 变化必须改变 revision")
	}
}

func TestLegacySnapshotWithoutModelFieldsIsAccepted(t *testing.T) {
	cache := New()
	// 旧快照没有 models / modelMap：必须照常接受，不因升级被拒。
	if _, err := cache.Replace(snapshot(account("acc-1", "sk-1"))); err != nil {
		t.Fatalf("旧快照必须被接受：%v", err)
	}
	if models := cache.Models(); len(models) != 0 {
		t.Fatalf("未声明模型的账号不应贡献模型名：%v", models)
	}
	credential, ok := cache.Credential("acc-1")
	if !ok || credential.Models != nil || credential.ModelMap != nil {
		t.Fatalf("旧快照凭据的模型字段应为 nil：%+v ok=%v", credential, ok)
	}
}

func TestRejectsInvalidModelFields(t *testing.T) {
	tooManyModels := make([]string, 0, MaxModels+1)
	for index := 0; index <= MaxModels; index++ {
		tooManyModels = append(tooManyModels, fmt.Sprintf("m-%d", index))
	}
	tooManyEntries := make(map[string]string, MaxModelMapEntries+1)
	for index := 0; index <= MaxModelMapEntries; index++ {
		tooManyEntries[fmt.Sprintf("k-%d", index)] = "upstream"
	}
	longName := strings.Repeat("m", MaxModelNameBytes+1)

	cases := []struct {
		name   string
		mutate func(*Account)
	}{
		{"empty model name", func(a *Account) { a.Models = []string{"gpt-4o", "  "} }},
		{"control char in model", func(a *Account) { a.Models = []string{"bad\nname"} }},
		{"too long model name", func(a *Account) { a.Models = []string{longName} }},
		{"too many models", func(a *Account) { a.Models = tooManyModels }},
		{"empty map key", func(a *Account) { a.ModelMap = map[string]string{"": "upstream"} }},
		{"empty map value", func(a *Account) { a.ModelMap = map[string]string{"gpt-4o": "  "} }},
		{"control char in map", func(a *Account) { a.ModelMap = map[string]string{"gpt-4o": "up\x7fstream"} }},
		{"too many map entries", func(a *Account) { a.ModelMap = tooManyEntries }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cache := New()
			entry := account("acc-1", "sk-1")
			tc.mutate(&entry)
			if _, err := cache.Replace(snapshot(entry)); err == nil {
				t.Fatal("非法 models / modelMap 必须整份拒绝")
			}
			if _, ok := cache.Credential("acc-1"); ok {
				t.Fatal("被拒的快照不应部分应用")
			}
		})
	}
}
