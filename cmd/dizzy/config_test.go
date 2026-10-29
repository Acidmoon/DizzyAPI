package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// withHome 把 DIZZY_HOME 指到临时目录，并在测试结束后恢复。
func withHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("DIZZY_HOME", dir)
	return dir
}

// TestLoadConfigMissingHasNoBase 断言「没有配置文件时 base 是空的」。
//
// 刻意**不给默认 base**：默认指向某个地址（尤其生产）意味着「忘了配」会静默打到
// 线上，而写操作不可撤销。缺 base 时由需要发请求的命令退 2 并给出可抄命令。
func TestLoadConfigMissingHasNoBase(t *testing.T) {
	withHome(t)
	config, err := LoadConfig()
	if err != nil {
		t.Fatalf("文件不存在不该报错：%v", err)
	}
	if config.Base != "" {
		t.Fatalf("没有配置文件时 base 应为空（不设默认），得到 %q", config.Base)
	}
	if config.LLMBase != "" || config.APIBase != "" {
		t.Fatalf("没有配置文件时不该有覆盖入口：llmBase=%q apiBase=%q", config.LLMBase, config.APIBase)
	}
	if config.TimeoutSeconds != defaultTimeoutSeconds {
		t.Fatalf("默认超时应为 %d，得到 %d", defaultTimeoutSeconds, config.TimeoutSeconds)
	}
}

// TestNoBaseIsUsageError 断言「没有 base 且没有 --base」是**用法错误（退出码 2）**，
// 并且错误里带着两条可直接抄的命令。
func TestNoBaseIsUsageError(t *testing.T) {
	withHome(t)
	config, err := resolveConfig(globalFlags{})
	if err != nil {
		t.Fatalf("读取配置本身不该失败：%v", err)
	}
	_, err = newLLMClient(config, globalFlags{Key: "sk-test"})
	if err == nil {
		t.Fatal("没有 base 时应失败")
	}
	if code := exitCodeOf(err); code != exitUsage {
		t.Fatalf("退出码应为 %d（用法错误），得到 %d：%v", exitUsage, code, err)
	}
	message := err.Error()
	for _, want := range []string{"dizzy config set base <url>", "dizzy --base <url> models"} {
		if !strings.Contains(message, want) {
			t.Fatalf("错误里应给可抄命令 %q：%s", want, message)
		}
	}
	// /api/* 那条链路同样拦，且顺序上先报 base、不报「没登录」。
	if _, apiErr := newAPIAnonClient(config, globalFlags{}); exitCodeOf(apiErr) != exitUsage {
		t.Fatalf("/api/* 缺 base 也应是用法错误，得到 %v", apiErr)
	}
}

// TestBaseFromFlag 断言 `--base` 能单独满足要求。
func TestBaseFromFlag(t *testing.T) {
	withHome(t)
	config, err := resolveConfig(globalFlags{Base: "http://127.0.0.1:7791"})
	if err != nil {
		t.Fatalf("解析配置失败：%v", err)
	}
	client, err := newLLMClient(config, globalFlags{Key: "sk-test"})
	if err != nil {
		t.Fatalf("给了 --base 应能构造客户端：%v", err)
	}
	if !strings.HasPrefix(client.URL("/v1/models", nil), "http://127.0.0.1:7791/v1/models") {
		t.Fatalf("入口地址不对：%s", client.URL("/v1/models", nil))
	}
}

// TestBaseFromConfigFile 断言 `config set base` 之后能读回并用上。
func TestBaseFromConfigFile(t *testing.T) {
	withHome(t)
	_, err := captureStdout(t, func() error {
		return runConfigSet([]string{"base", "http://127.0.0.1:7791"}, globalFlags{})
	})
	if err != nil {
		t.Fatalf("config set base 失败：%v", err)
	}
	loaded, err := LoadConfig()
	if err != nil {
		t.Fatalf("读回配置失败：%v", err)
	}
	if loaded.Base != "http://127.0.0.1:7791" {
		t.Fatalf("base 没读回：%q", loaded.Base)
	}
	config, err := resolveConfig(globalFlags{})
	if err != nil {
		t.Fatalf("解析配置失败：%v", err)
	}
	if _, err := newLLMClient(config, globalFlags{Key: "sk-test"}); err != nil {
		t.Fatalf("配置过 base 后应能构造客户端：%v", err)
	}
}

// TestConfigCommandWorksWithoutBase 断言不需要 base 的命令不被拦。
//
// `dizzy config` 与 `--help` 是「还没配入口」时唯一的自救路径，必须能跑。
func TestConfigCommandWorksWithoutBase(t *testing.T) {
	withHome(t)
	stdout, err := captureStdout(t, func() error {
		return runConfig([]string{"show"}, globalFlags{})
	})
	if err != nil {
		t.Fatalf("没有 base 时 config show 不该失败：%v", err)
	}
	if !strings.Contains(stdout, "（未设置）") {
		t.Fatalf("config show 应显示 base 未设置：\n%s", stdout)
	}
	// 只设 llmBase（还没有 base）也不能被拦：Validate 不该强制 base。
	_, err = captureStdout(t, func() error {
		return runConfigSet([]string{"llmBase", "http://127.0.0.1:8080"}, globalFlags{})
	})
	if err != nil {
		t.Fatalf("没有 base 时 config set llmBase 不该失败：%v", err)
	}
	// 帮助不碰配置，永远能跑。
	_, err = captureStdout(t, func() error {
		return run([]string{"help"})
	})
	if err != nil {
		t.Fatalf("help 不该失败：%v", err)
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
		// base 允许为空：空 = 「还没配入口」，由需要发请求的命令明确失败（退 2）。
		{"空 base 合法（还没配入口）", Config{Base: ""}, false},
		{"只有 llmBase 也合法", Config{LLMBase: "http://127.0.0.1:8080"}, false},
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
