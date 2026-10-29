// dizzy 是 DizzyAPI 的命令行客户端。
//
// 面向 agent 与开发者：零环境依赖（静态二进制，不需要 Node），一条命令能跑。
//
// 它**只是客户端**：所有操作都走 HTTP，绝不直连 SQLite 或 JSON 数据文件。
// 依赖只有标准库与 contracts；不 import modules/ 与 internal/。
package main

import (
	"errors"
	"fmt"
	"os"
	"time"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "dizzy: %v\n", err)
		os.Exit(exitCodeOf(err))
	}
}

// errUsage 表示用法错误（退出码 2）。
var errUsage = errors.New("用法错误")

// run 是 CLI 的主流程。
func run(args []string) error {
	globals, rest, err := parseGlobals(args)
	if err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}

	if len(rest) == 0 {
		printHelp(os.Stdout, registry(), globalsHelpText)
		return nil
	}

	name := rest[0]
	switch name {
	case "help", "--help", "-h":
		if len(rest) > 1 {
			item, ok := lookupCommand(rest[1])
			if !ok {
				return fmt.Errorf("%w：没有子命令 %q", errUsage, name)
			}
			printCommandHelp(os.Stdout, item)
			return nil
		}
		printHelp(os.Stdout, registry(), globalsHelpText)
		return nil
	case "version", "--version":
		fmt.Fprintln(os.Stdout, "dizzy "+version)
		return nil
	}

	item, ok := lookupCommand(name)
	if !ok {
		return fmt.Errorf("%w：没有子命令 %q（用 dizzy help 看全部）", errUsage, name)
	}
	return item.Run(rest[1:], globals)
}

// version 是 CLI 版本。
const version = "0.1.0"

// printCommandHelp 打单个子命令的帮助。
func printCommandHelp(out interface{ Write([]byte) (int, error) }, item *command) {
	fmt.Fprintf(out, "dizzy %s — %s\n", item.Name, item.Summary)
	fmt.Fprintln(out)
	fmt.Fprintln(out, "用法：")
	fmt.Fprintf(out, "  %s\n", item.Usage)
	if item.Example != "" {
		fmt.Fprintln(out)
		fmt.Fprintln(out, "示例：")
		fmt.Fprintf(out, "  %s\n", item.Example)
	}
}

// resolveConfig 合并配置与全局参数。
//
// 全局参数优先于配置文件；配置文件优先于默认值。
func resolveConfig(globals globalFlags) (Config, error) {
	config, err := LoadConfig()
	if err != nil {
		return Config{}, err
	}
	if globals.Base != "" {
		config.Base = globals.Base
	}
	if globals.LLMBase != "" {
		config.LLMBase = globals.LLMBase
	}
	if globals.APIBase != "" {
		config.APIBase = globals.APIBase
	}
	if globals.Timeout > 0 {
		config.TimeoutSeconds = globals.Timeout
	}
	if globals.JSON {
		config.JSON = true
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

// resolveAPIKey 取 Bearer key：--key 优先，其次环境变量。
//
// **不落盘**（AGENTS.md §2.4.1）。
func resolveAPIKey(globals globalFlags) string {
	if globals.Key != "" {
		return globals.Key
	}
	return os.Getenv(envAPIKey)
}

// newAPIClient 造一个走会话路径（/api/*）的客户端。
//
// 注意 `APIRequestHeader` **无条件为真**：/api/* 的每个请求（含登录、健康检查）
// 都必须带 X-Requested-With，只有会话 cookie 才是「登录后才有」。
func newAPIClient(config Config, globals globalFlags) (*Client, error) {
	token, err := SessionToken()
	if err != nil {
		if errors.Is(err, ErrCredentialsMissing) {
			return nil, fmt.Errorf("%w：先跑 `dizzy login`", err)
		}
		return nil, err
	}
	return NewClient(ClientOptions{
		BaseURL:          config.APIURL(),
		Timeout:          time.Duration(config.TimeoutSeconds) * time.Second,
		SessionToken:     token,
		APIRequestHeader: true,
		Verbose:          globals.Verbose,
		Log:              verboseLogger(globals.Verbose),
	})
}

// newAPIAnonClient 造一个**不带会话**但走 /api/* 的客户端。
//
// 登录与公开健康端点用它：还没有会话，但请求头必须带。
func newAPIAnonClient(config Config, globals globalFlags) (*Client, error) {
	return NewClient(ClientOptions{
		BaseURL:          config.APIURL(),
		Timeout:          time.Duration(config.TimeoutSeconds) * time.Second,
		APIRequestHeader: true,
		Verbose:          globals.Verbose,
		Log:              verboseLogger(globals.Verbose),
	})
}

// newLLMClient 造一个走 Bearer 路径（/v1/*）的客户端。
func newLLMClient(config Config, globals globalFlags) (*Client, error) {
	key := resolveAPIKey(globals)
	if key == "" {
		return nil, fmt.Errorf("缺少 API key：用 --key 或环境变量 %s 提供", envAPIKey)
	}
	return NewClient(ClientOptions{
		BaseURL: config.LLMURL(),
		Timeout: time.Duration(config.TimeoutSeconds) * time.Second,
		APIKey:  key,
		Verbose: globals.Verbose,
		Log:     verboseLogger(globals.Verbose),
	})
}

// verboseLogger 返回 verbose 日志出口。**只打方法与路径，不打秘密**。
func verboseLogger(enabled bool) func(string, ...any) {
	if !enabled {
		return func(string, ...any) {}
	}
	return func(format string, args ...any) {
		fmt.Fprintf(os.Stderr, "[dizzy] "+format+"\n", args...)
	}
}
