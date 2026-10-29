package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// withHome 把 DIZZY_HOME 指到临时目录，并在测试结束后恢复。
func withHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("DIZZY_HOME", dir)
	return dir
}

func TestLoadConfigMissingReturnsDefault(t *testing.T) {
	withHome(t)
	config, err := LoadConfig()
	if err != nil {
		t.Fatalf("文件不存在不该报错：%v", err)
	}
	if config.Base != defaultBaseURL {
		t.Fatalf("默认 base 应为 %q，得到 %q", defaultBaseURL, config.Base)
	}
	if config.TimeoutSeconds != defaultTimeoutSeconds {
		t.Fatalf("默认超时应为 %d，得到 %d", defaultTimeoutSeconds, config.TimeoutSeconds)
	}
}

func TestSaveThenLoadConfig(t *testing.T) {
	withHome(t)
	wanted := Config{
		Base:           "http://127.0.0.1:7791",
		LLMBase:        "http://127.0.0.1:8080",
		APIBase:        "http://127.0.0.1:7791",
		DefaultModel:   "deepseek-flash",
		TimeoutSeconds: 30,
		JSON:           true,
	}
	if err := SaveConfig(wanted); err != nil {
		t.Fatalf("保存配置失败：%v", err)
	}
	loaded, err := LoadConfig()
	if err != nil {
		t.Fatalf("读取配置失败：%v", err)
	}
	if loaded != wanted {
		t.Fatalf("配置往返不一致：%+v != %+v", loaded, wanted)
	}
}

// TestConfigFilePermissions 断言配置文件的**实际保护边界**。
//
// Unix：权限必须是 0644。
//
// Windows：Go 的 FileMode 是合成值（`os.Chmod` 只认 0200 只读位），
// 「0644」在 Windows 上既拿不到也不是保护边界；那里的保护来自用户目录 ACL。
// 所以 Windows 上断言「默认配置路径落在用户目录的 .dizzy 下」。
func TestConfigFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Setenv("DIZZY_HOME", "")
		path, err := configPath()
		if err != nil {
			t.Fatalf("取路径失败：%v", err)
		}
		home, err := os.UserHomeDir()
		if err != nil {
			t.Fatalf("拿不到用户目录：%v", err)
		}
		wanted := filepath.Join(home, ".dizzy", configFileName)
		if path != wanted {
			t.Fatalf("配置路径应在用户目录下：%q != %q", path, wanted)
		}
		return
	}

	dir := withHome(t)
	if err := SaveConfig(DefaultConfig()); err != nil {
		t.Fatalf("保存配置失败：%v", err)
	}
	info, err := os.Stat(filepath.Join(dir, configFileName))
	if err != nil {
		t.Fatalf("stat 失败：%v", err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("配置文件权限应为 0644，得到 %v", info.Mode().Perm())
	}
}

func TestLoadConfigRejectsBrokenJSON(t *testing.T) {
	dir := withHome(t)
	path := filepath.Join(dir, configFileName)
	if err := os.WriteFile(path, []byte("{ not json"), 0o644); err != nil {
		t.Fatalf("写测试文件失败：%v", err)
	}
	_, err := LoadConfig()
	if err == nil {
		t.Fatal("坏 JSON 必须明确失败，不能静默回落默认值")
	}
	if !errors.Is(err, ErrConfigInvalid) {
		t.Fatalf("错误应包含 ErrConfigInvalid，得到 %v", err)
	}
}

func TestConfigValidate(t *testing.T) {
	cases := []struct {
		name    string
		config  Config
		wantErr bool
	}{
		{"正常 https", Config{Base: "https://example.com"}, false},
		{"正常 http", Config{Base: "http://127.0.0.1:7791"}, false},
		{"带路径前缀", Config{Base: "https://example.com/gw"}, false},
		{"空 base", Config{Base: ""}, true},
		{"没有 scheme", Config{Base: "example.com"}, true},
		{"不是 http", Config{Base: "ftp://example.com"}, true},
		{"缺主机名", Config{Base: "https:///path"}, true},
		{"带用户信息", Config{Base: "https://user:pass@example.com"}, true},
		{"负超时", Config{Base: "https://example.com", TimeoutSeconds: -1}, true},
		{"llmBase 非法", Config{Base: "https://example.com", LLMBase: "nope"}, true},
		{"apiBase 非法", Config{Base: "https://example.com", APIBase: "nope"}, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			err := testCase.config.Validate()
			if testCase.wantErr && err == nil {
				t.Fatalf("期望校验失败，但通过了")
			}
			if !testCase.wantErr && err != nil {
				t.Fatalf("期望校验通过，但失败：%v", err)
			}
			if testCase.wantErr && err != nil && !errors.Is(err, ErrConfigInvalid) {
				t.Fatalf("错误应包含 ErrConfigInvalid，得到 %v", err)
			}
		})
	}
}

func TestConfigURLFallback(t *testing.T) {
	base := Config{Base: "https://example.com"}
	if base.LLMURL() != "https://example.com" {
		t.Fatalf("LLMURL 应回落到 base，得到 %q", base.LLMURL())
	}
	if base.APIURL() != "https://example.com" {
		t.Fatalf("APIURL 应回落到 base，得到 %q", base.APIURL())
	}

	overridden := Config{
		Base:    "https://example.com",
		LLMBase: "http://127.0.0.1:8080",
		APIBase: "http://127.0.0.1:7791",
	}
	if overridden.LLMURL() != "http://127.0.0.1:8080" {
		t.Fatalf("LLMURL 应优先用 llmBase，得到 %q", overridden.LLMURL())
	}
	if overridden.APIURL() != "http://127.0.0.1:7791" {
		t.Fatalf("APIURL 应优先用 apiBase，得到 %q", overridden.APIURL())
	}
}

// TestParseBaseURLTrimsTrailingSlash 断言末尾斜杠被去掉：拼路径时不能出现双斜杠。
func TestParseBaseURLTrimsTrailingSlash(t *testing.T) {
	parsed, err := parseBaseURL("https://example.com/gw/")
	if err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	if parsed.Path != "/gw" {
		t.Fatalf("末尾斜杠应被去掉，得到路径 %q", parsed.Path)
	}
}
