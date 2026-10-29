package main

import (
	"fmt"
	"os"
	"strings"
)

// configCommand 是 `dizzy config`：读 / 写本地配置。
//
// 配置文件**不含秘密**：API key 不落盘，会话 token 在 credentials.json 里。
func configCommand() *command {
	return &command{
		Name:    "config",
		Summary: "查看或修改本地配置（~/.dizzy/config.json）",
		Usage:   "dizzy config [show|set <键> <值>]",
		Example: "dizzy config show\ndizzy config set base http://127.0.0.1:7791\ndizzy config set llmBase http://127.0.0.1:8080\ndizzy config set defaultModel deepseek-flash",
		Run:     runConfig,
	}
}

func runConfig(args []string, globals globalFlags) error {
	if len(args) == 0 {
		return runConfigShow(globals)
	}
	switch args[0] {
	case "show":
		return runConfigShow(globals)
	case "set":
		return runConfigSet(args[1:], globals)
	default:
		return fmt.Errorf("%w：config 只接受 show / set", errUsage)
	}
}

func runConfigShow(globals globalFlags) error {
	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}
	path, err := configPath()
	if err != nil {
		return err
	}
	if globals.JSON {
		return printJSON(map[string]any{
			"path":           path,
			"base":           config.Base,
			"llmBase":        config.LLMBase,
			"apiBase":        config.APIBase,
			"defaultModel":   config.DefaultModel,
			"timeoutSeconds": config.TimeoutSeconds,
			"json":           config.JSON,
		})
	}
	fmt.Fprintf(os.Stdout, "配置文件：%s\n", path)
	fmt.Fprintf(os.Stdout, "base：%s\n", config.Base)
	fmt.Fprintf(os.Stdout, "llmBase：%s\n", orDash(config.LLMBase))
	fmt.Fprintf(os.Stdout, "apiBase：%s\n", orDash(config.APIBase))
	fmt.Fprintf(os.Stdout, "defaultModel：%s\n", orDash(config.DefaultModel))
	fmt.Fprintf(os.Stdout, "timeoutSeconds：%d\n", config.TimeoutSeconds)
	return nil
}

// orDash 把空串渲染成占位符。
func orDash(value string) string {
	if value == "" {
		return "（未设置）"
	}
	return value
}

func runConfigSet(args []string, globals globalFlags) error {
	if len(args) != 2 {
		return fmt.Errorf("%w：config set 需要「键 值」两个参数", errUsage)
	}
	key := args[0]
	value := args[1]

	config, err := LoadConfig()
	if err != nil {
		return err
	}

	switch key {
	case "base":
		config.Base = value
	case "llmBase":
		config.LLMBase = value
	case "apiBase":
		config.APIBase = value
	case "defaultModel":
		config.DefaultModel = value
	case "timeoutSeconds":
		seconds, parseErr := parsePositiveInt("timeoutSeconds", value)
		if parseErr != nil {
			return fmt.Errorf("%w：%v", errUsage, parseErr)
		}
		config.TimeoutSeconds = seconds
	case "json":
		switch strings.ToLower(value) {
		case "true", "1", "yes":
			config.JSON = true
		case "false", "0", "no":
			config.JSON = false
		default:
			return fmt.Errorf("%w：json 只能是 true 或 false", errUsage)
		}
	default:
		return fmt.Errorf("%w：没有配置项 %q（可用：base / llmBase / apiBase / defaultModel / timeoutSeconds / json）", errUsage, key)
	}

	if err := config.Validate(); err != nil {
		return err
	}
	if err := SaveConfig(config); err != nil {
		return err
	}
	fmt.Fprintf(os.Stdout, "已设置 %s = %s\n", key, value)
	return nil
}
