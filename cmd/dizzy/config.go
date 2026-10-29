// Package main 是 DizzyAPI 的命令行客户端（dizzy）。
//
// 它是**客户端**，不是网关：只通过 HTTP 访问 DizzyAPI，绝不直连 SQLite 或
// JSON 数据文件（AGENTS.md §2.4「一个数据一个写者」）。
//
// 依赖只有标准库与 contracts（拿 Gemini 模型名归一与协议常量）；
// **绝不 import modules/ 或 internal/** —— 那些是网关内部实现。
//
// 两条鉴权路径完全不同（AGENTS.md §4.2）：
//
//	/v1/*  → Authorization: Bearer <API key>（Go 的 key-auth 校验哈希快照）
//	/api/* → HttpOnly 会话 cookie，且每个请求都要带 X-Requested-With: dizzyapi
//
// 本文件负责配置与凭据的读写。秘密只进 credentials.json（0600），API key
// **不落盘**（只从环境变量或 --key 参数读）。
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// 文件与目录的权限。**没有默认入口地址**：`base` 必须显式配置或每次 `--base`，
// 否则需要发请求的命令直接退 2 并给出可抄的两行命令 —— 默认指向某个地址（尤其
// 生产）意味着「忘了配」会静默打到线上，而写操作是不可撤销的。
const (
	// credentialsFileMode 是凭据文件的权限：只有本人可读写。
	credentialsFileMode os.FileMode = 0o600
	// configFileMode 是配置文件的权限：本人可读写，组与其他用户可读。
	configFileMode os.FileMode = 0o644
	// dirMode 是配置目录的权限。
	dirMode os.FileMode = 0o700
)

// 凭据文件与配置文件的固定名字（放在 ~/.dizzy/ 下）。
const (
	credentialsFileName = "credentials.json"
	configFileName      = "config.json"
)

// 环境变量名。API key 只从这两个地方读，**不落盘**。
const (
	envAPIKey   = "DIZZYAPI_KEY"
	envPassword = "DIZZYAPI_PASSWORD"
)

// Config 是 CLI 的持久化配置（~/.dizzy/config.json）。
//
// 这里**不含任何秘密**：API key 不落盘，会话 token 在 credentials.json 里。
type Config struct {
	// Base 是入口地址（生产是同一个域名）。
	Base string `json:"base"`
	// LLMBase 可选：覆盖 /v1/* 的入口（本地开发时 gatewayd 与 api 是两个端口）。
	LLMBase string `json:"llmBase,omitempty"`
	// APIBase 可选：覆盖 /api/* 的入口。
	APIBase string `json:"apiBase,omitempty"`
	// DefaultModel 是 chat / models 的默认模型。
	DefaultModel string `json:"defaultModel,omitempty"`
	// TimeoutSeconds 是单次请求的超时秒数；0 = 用默认值。
	TimeoutSeconds int `json:"timeoutSeconds,omitempty"`
	// JSON 默认为 JSON 输出。
	JSON bool `json:"json,omitempty"`
}

// DefaultConfig 返回默认配置（未落盘的那一份）。
//
// **base 为空**：没有默认入口地址，必须显式配置或 `--base`。
func DefaultConfig() Config {
	return Config{TimeoutSeconds: defaultTimeoutSeconds}
}

// defaultTimeoutSeconds 是单次请求的默认超时。
const defaultTimeoutSeconds = 60

// ErrConfigInvalid 表示配置非法。CLI 遇到它必须**明确失败**，不静默降级
// （AGENTS.md §2.4.5）。
var ErrConfigInvalid = errors.New("配置非法")

// Validate 校验配置的**形状**。非法时返回带说明的 ErrConfigInvalid。
//
// 注意 `base` 允许为空：空 = 「还没配入口」，由需要发请求的命令在构造客户端时
// 明确失败（退 2 并给出可抄命令）。这里不判它，否则 `dizzy config show` 与
// `config set llmBase ...` 这类**不需要 base 的操作**也会被拦住。
func (c Config) Validate() error {
	if strings.TrimSpace(c.Base) != "" {
		if _, err := parseBaseURL(c.Base); err != nil {
			return fmt.Errorf("%w：base %q 不合法：%v", ErrConfigInvalid, c.Base, err)
		}
	}
	for name, value := range map[string]string{"llmBase": c.LLMBase, "apiBase": c.APIBase} {
		if value == "" {
			continue
		}
		if _, err := parseBaseURL(value); err != nil {
			return fmt.Errorf("%w：%s %q 不合法：%v", ErrConfigInvalid, name, value, err)
		}
	}
	if c.TimeoutSeconds < 0 {
		return fmt.Errorf("%w：timeoutSeconds 不能为负", ErrConfigInvalid)
	}
	return nil
}

// parseBaseURL 校验并归一一个入口地址。
//
// 只允许 http / https，且必须带主机名；路径前缀保留（本地可能挂在子路径下）。
func parseBaseURL(raw string) (*url.URL, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, errors.New("地址不能为空")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("只支持 http / https，收到 %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return nil, errors.New("缺少主机名")
	}
	if parsed.User != nil {
		return nil, errors.New("地址里不能带用户信息")
	}
	parsed.Path = strings.TrimSuffix(parsed.Path, "/")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed, nil
}

// LLMURL 给出 /v1/* 入口的基地址。
func (c Config) LLMURL() string {
	if c.LLMBase != "" {
		return c.LLMBase
	}
	return c.Base
}

// APIURL 给出 /api/* 入口的基地址。
func (c Config) APIURL() string {
	if c.APIBase != "" {
		return c.APIBase
	}
	return c.Base
}

// configDir 返回配置目录（~/.dizzy）。可用 DIZZY_HOME 覆盖（测试用）。
func configDir() (string, error) {
	if override := os.Getenv("DIZZY_HOME"); override != "" {
		return override, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("找不到用户主目录：%w", err)
	}
	return filepath.Join(home, ".dizzy"), nil
}

// configPath 返回配置文件的完整路径。
func configPath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, configFileName), nil
}

// credentialsPath 返回凭据文件的完整路径。
func credentialsPath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, credentialsFileName), nil
}

// LoadConfig 读取配置。文件不存在时返回默认配置（不是错误）。
//
// 文件存在但 JSON 非法时**明确失败**：静默回落默认值会让「配置写错了」
// 看起来像「配置生效了」。
func LoadConfig() (Config, error) {
	path, err := configPath()
	if err != nil {
		return Config{}, err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return DefaultConfig(), nil
	}
	if err != nil {
		return Config{}, fmt.Errorf("读取配置 %s 失败：%w", path, err)
	}
	var config Config
	if err := json.Unmarshal(raw, &config); err != nil {
		return Config{}, fmt.Errorf("%w：配置 %s 不是合法 JSON：%v", ErrConfigInvalid, path, err)
	}
	if config.TimeoutSeconds == 0 {
		config.TimeoutSeconds = defaultTimeoutSeconds
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

// SaveConfig 原子写配置文件（先写临时文件再改名）。
func SaveConfig(config Config) error {
	if err := config.Validate(); err != nil {
		return err
	}
	dir, err := configDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return fmt.Errorf("创建配置目录 %s 失败：%w", dir, err)
	}
	payload, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化配置失败：%w", err)
	}
	payload = append(payload, '\n')
	return writeFileAtomic(filepath.Join(dir, configFileName), payload, configFileMode)
}

// writeFileAtomic 先写临时文件再改名，避免半截文件。
//
// 权限在创建临时文件时就给足（rename 不会再改权限），并且**显式 chmod**——
// umask 会把 0600 再收窄，但绝不会放宽；chmod 是为了在已有文件的情况下
// 把权限纠正回 0600。
func writeFileAtomic(path string, payload []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("创建临时文件失败：%w", err)
	}
	tempName := temp.Name()
	defer func() {
		// 出错路径上把临时文件清掉；成功路径上它已被 rename 走。
		_ = os.Remove(tempName)
	}()
	if err := temp.Chmod(mode); err != nil {
		_ = temp.Close()
		return fmt.Errorf("设置文件权限失败：%w", err)
	}
	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close()
		return fmt.Errorf("写文件失败：%w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("关闭文件失败：%w", err)
	}
	if err := os.Rename(tempName, path); err != nil {
		return fmt.Errorf("写文件 %s 失败：%w", path, err)
	}
	return nil
}
