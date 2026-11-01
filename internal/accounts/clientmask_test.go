package accounts

import (
	"fmt"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// 客户端指纹档案在**装载侧**的护栏。
//
// 重点是「坏数据整份拒绝」：这些头会原样贴到发往上游的请求上，一个换行就是头注入，
// 一个受保护头名就是顶掉鉴权。任何一条不合法 → **整份快照拒绝**，绝不部分应用。

func maskedAccount() Account {
	acc := account("acc-mask", "sk-mask")
	acc.ClientUserAgent = "opencode/0.4.2 (cli; linux x64)"
	acc.ClientHeaders = []contracts.AccountHeader{
		{Name: "x-opencode-session", Value: contracts.PlaceholderSession},
		{Name: "x-opencode-client", Value: "cli"},
	}
	return acc
}

func TestClientMaskFlowsToCredentialAndCandidates(t *testing.T) {
	cache := New()
	if _, err := cache.Replace(snapshot(maskedAccount())); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	credential, ok := cache.Credential("acc-mask")
	if !ok {
		t.Fatal("没拿到凭据")
	}
	if credential.ClientUserAgent != "opencode/0.4.2 (cli; linux x64)" {
		t.Fatalf("UA 没透传：%q", credential.ClientUserAgent)
	}
	if len(credential.ClientHeaders) != 2 {
		t.Fatalf("头没透传：%+v", credential.ClientHeaders)
	}
	// 模板必须**原样**透传：展开发生在 transport（要用请求体算 session）。
	if credential.ClientHeaders[0].Value != contracts.PlaceholderSession {
		t.Fatalf("模板被提前展开了：%q", credential.ClientHeaders[0].Value)
	}

	candidates := cache.Candidates()
	if len(candidates) != 1 {
		t.Fatalf("候选数量不对：%d", len(candidates))
	}
	if len(candidates[0].ClientHeaders) != 2 || candidates[0].ClientUserAgent == "" {
		t.Fatalf("候选里没带上档案：%+v", candidates[0])
	}

	// 快照不可变：改返回的切片不该影响缓存。
	credential.ClientHeaders[0].Name = "tampered"
	again, _ := cache.Credential("acc-mask")
	if again.ClientHeaders[0].Name != "x-opencode-session" {
		t.Fatal("缓存被调用方改坏了：克隆没做")
	}
}

func TestClientMaskRejectsBadHeaders(t *testing.T) {
	tooMany := make([]contracts.AccountHeader, 0, contracts.MaxClientHeaders+1)
	for i := 0; i <= contracts.MaxClientHeaders; i++ {
		tooMany = append(tooMany, contracts.AccountHeader{
			Name:  fmt.Sprintf("x-h-%d", i),
			Value: "v",
		})
	}

	cases := map[string]struct {
		headers   []contracts.AccountHeader
		userAgent string
	}{
		"受保护头：Authorization": {
			headers: []contracts.AccountHeader{{Name: "Authorization", Value: "Bearer x"}},
		},
		"受保护头：大小写变体也拦": {
			headers: []contracts.AccountHeader{{Name: "X-Api-Key", Value: "x"}},
		},
		"受保护头：Host": {
			headers: []contracts.AccountHeader{{Name: "Host", Value: "evil.example.com"}},
		},
		"头值含 CRLF（头注入）": {
			headers: []contracts.AccountHeader{{Name: "x-a", Value: "v\r\nX-Evil: 1"}},
		},
		"头名含空格": {
			headers: []contracts.AccountHeader{{Name: "x bad", Value: "v"}},
		},
		"不认识的占位符": {
			headers: []contracts.AccountHeader{{Name: "x-a", Value: "{{token}}"}},
		},
		"重复头名（大小写不同）": {
			headers: []contracts.AccountHeader{
				{Name: "x-a", Value: "1"},
				{Name: "X-A", Value: "2"},
			},
		},
		"头太多":    {headers: tooMany},
		"UA 含换行": {userAgent: "agent\r\nX-Evil: 1"},
	}

	for name, tc := range cases {
		cache := New()
		acc := account("acc-bad", "sk-bad")
		acc.ClientHeaders = tc.headers
		acc.ClientUserAgent = tc.userAgent
		if _, err := cache.Replace(snapshot(acc)); err == nil {
			t.Fatalf("%s：必须整份拒绝", name)
		} else if !strings.Contains(err.Error(), "ACCOUNTS_INVALID_ACCOUNT") {
			t.Fatalf("%s：错误码不对：%v", name, err)
		}
		// 拒绝之后缓存仍是空的：不许部分应用。
		if _, ok := cache.Credential("acc-bad"); ok {
			t.Fatalf("%s：拒绝之后不该留下凭据", name)
		}
	}
}
