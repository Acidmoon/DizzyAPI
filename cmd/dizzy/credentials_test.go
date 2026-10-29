package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestCredentialsRoundTrip(t *testing.T) {
	withHome(t)
	wanted := Credentials{Session: &Session{
		Token:     "session-token-value",
		ExpiresAt: "2026-11-05T00:00:00Z",
		Email:     "me@example.com",
	}}
	if err := SaveCredentials(wanted); err != nil {
		t.Fatalf("保存凭据失败：%v", err)
	}
	loaded, err := LoadCredentials()
	if err != nil {
		t.Fatalf("读取凭据失败：%v", err)
	}
	if loaded.Session == nil {
		t.Fatal("会话不该为空")
	}
	if loaded.Session.Token != wanted.Session.Token {
		t.Fatalf("token 不一致：%q != %q", loaded.Session.Token, wanted.Session.Token)
	}
	if loaded.Session.ExpiresAt != wanted.Session.ExpiresAt {
		t.Fatalf("过期时间不一致")
	}
}

// TestCredentialsFilePermissions 断言凭据文件的**实际保护边界**。
//
// Unix：文件权限必须是 0600（owner 验收清单的硬要求），而且已有文件权限过宽时
// 覆盖保存要把它纠正回来。
//
// Windows：Go 的 FileMode 在 Windows 上是合成值（`os.Chmod` 只认 0200 只读位，
// 读回来恒为 0666），所以「0600」既拿不到也不是那里的安全边界 —— Windows 的保护
// 来自 `%USERPROFILE%` 的 ACL（默认只授予本人 / SYSTEM / Administrators）。
// 因此这里断言「默认路径落在用户目录的 .dizzy 下」。
func TestCredentialsFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Setenv("DIZZY_HOME", "")
		path, err := credentialsPath()
		if err != nil {
			t.Fatalf("取路径失败：%v", err)
		}
		home, err := os.UserHomeDir()
		if err != nil {
			t.Fatalf("拿不到用户目录：%v", err)
		}
		wanted := filepath.Join(home, ".dizzy", credentialsFileName)
		if path != wanted {
			t.Fatalf("凭据路径应在用户目录下：%q != %q", path, wanted)
		}
		return
	}

	dir := withHome(t)
	path := filepath.Join(dir, credentialsFileName)

	if err := SaveCredentials(Credentials{Session: &Session{Token: "t"}}); err != nil {
		t.Fatalf("保存凭据失败：%v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat 失败：%v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("凭据文件权限必须是 0600，得到 %v", got)
	}

	// 权限被改宽之后再保存，必须纠正回 0600。
	if err := os.Chmod(path, 0o666); err != nil {
		t.Fatalf("chmod 失败：%v", err)
	}
	if err := SaveCredentials(Credentials{Session: &Session{Token: "t"}}); err != nil {
		t.Fatalf("覆盖保存失败：%v", err)
	}
	info, err = os.Stat(path)
	if err != nil {
		t.Fatalf("stat 失败：%v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("覆盖保存后权限应被纠正回 0600，得到 %v", got)
	}
}

func TestLoadCredentialsMissingIsEmpty(t *testing.T) {
	withHome(t)
	credentials, err := LoadCredentials()
	if err != nil {
		t.Fatalf("文件不存在不该报错：%v", err)
	}
	if credentials.Session != nil {
		t.Fatal("没有凭据文件时会话应为空")
	}
}

func TestSessionTokenMissing(t *testing.T) {
	withHome(t)
	_, err := SessionToken()
	if !errors.Is(err, ErrCredentialsMissing) {
		t.Fatalf("应返回 ErrCredentialsMissing，得到 %v", err)
	}
}

func TestClearCredentialsIsIdempotent(t *testing.T) {
	withHome(t)
	// 文件不存在时也不该报错。
	if err := ClearCredentials(); err != nil {
		t.Fatalf("清空不存在的凭据不该报错：%v", err)
	}
	if err := SaveCredentials(Credentials{Session: &Session{Token: "t"}}); err != nil {
		t.Fatalf("保存凭据失败：%v", err)
	}
	if err := ClearCredentials(); err != nil {
		t.Fatalf("清空凭据失败：%v", err)
	}
	if _, err := SessionToken(); !errors.Is(err, ErrCredentialsMissing) {
		t.Fatalf("清空后应没有会话，得到 %v", err)
	}
}

// TestCredentialsNeverStoreAPIKey 断言凭据文件里**没有** API key 字段。
//
// owner 的硬边界：API key 只能从环境变量或 --key 读，不得落盘。
func TestCredentialsNeverStoreAPIKey(t *testing.T) {
	dir := withHome(t)
	if err := SaveCredentials(Credentials{Session: &Session{Token: "t"}}); err != nil {
		t.Fatalf("保存凭据失败：%v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, credentialsFileName))
	if err != nil {
		t.Fatalf("读凭据失败：%v", err)
	}
	for _, forbidden := range []string{"apiKey", "api_key", "secret", "password"} {
		if containsFold(string(raw), forbidden) {
			t.Fatalf("凭据文件里不该出现 %q：%s", forbidden, raw)
		}
	}
}

// containsFold 判断子串（大小写不敏感）。
func containsFold(haystack, needle string) bool {
	return stringsContains(lowerASCII(haystack), lowerASCII(needle))
}

// lowerASCII 是小写转换（只处理 ASCII，足够用于字段名比较）。
func lowerASCII(text string) string {
	result := []byte(text)
	for index, character := range result {
		if character >= 'A' && character <= 'Z' {
			result[index] = character + ('a' - 'A')
		}
	}
	return string(result)
}

// stringsContains 是标准库 strings.Contains 的薄封装（避免测试文件里多一个 import
// 分支：这里只需要这一个用途）。
func stringsContains(haystack, needle string) bool {
	if needle == "" {
		return true
	}
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return true
		}
	}
	return false
}
