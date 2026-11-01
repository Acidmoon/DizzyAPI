package main

import (
	"flag"
	"fmt"
	"io"
	"net/url"
	"strings"
)

// globalFlags 是所有子命令都有的全局参数。
type globalFlags struct {
	// Base 覆盖入口地址。
	Base string
	// LLMBase 覆盖 /v1/* 的入口（本地开发时 gatewayd 与 api 是两个端口）。
	LLMBase string
	// APIBase 覆盖 /api/* 的入口。
	APIBase string
	// JSON 让输出走机器可读的 JSON。
	JSON bool
	// Timeout 是单次请求超时（秒）。
	Timeout int
	// Key 是 Bearer API key。**只从参数或环境变量读，不落盘**。
	Key string
	// Verbose 把请求概要打到 stderr。
	Verbose bool
}

// command 是 CLI 的一个子命令。
type command struct {
	// Name 是命令名。
	Name string
	// Summary 是一句话说明（--help 里显示）。
	Summary string
	// Usage 是用法行。
	Usage string
	// Example 是示例（--help 里显示）。
	Example string
	// Run 执行命令。它拿到已解析好的参数与全局参数。
	Run func(args []string, globals globalFlags) error
}

// registry 是全部子命令。顺序就是 --help 里的顺序。
func registry() []*command {
	return []*command{
		loginCommand(),
		logoutCommand(),
		whoamiCommand(),
		healthCommand(),
		chatCommand(),
		modelsCommand(),
		usageCommand(),
		keysCommand(),
		configCommand(),
		adminCommand(),
	}
}

// lookupCommand 按名字找子命令。
func lookupCommand(name string) (*command, bool) {
	for _, item := range registry() {
		if item.Name == name {
			return item, true
		}
	}
	return nil, false
}

// parseGlobals 从参数里抽全局参数，并返回剩下的子命令参数。
//
// 全局参数可以出现在子命令**之前或之后**（`dizzy --json chat` 与
// `dizzy chat --json` 都合法）。
func parseGlobals(args []string) (globalFlags, []string, error) {
	var globals globalFlags
	var rest []string
	seen := map[string]bool{}

	for index := 0; index < len(args); index++ {
		argument := args[index]
		name, inlineValue, hasInline := splitFlag(argument)
		switch name {
		case "--base":
			value, consumed, err := flagValue(args, index, name, inlineValue, hasInline)
			if err != nil {
				return globals, nil, err
			}
			globals.Base = value
			index += consumed
		case "--llm-base":
			value, consumed, err := flagValue(args, index, name, inlineValue, hasInline)
			if err != nil {
				return globals, nil, err
			}
			globals.LLMBase = value
			index += consumed
		case "--api-base":
			value, consumed, err := flagValue(args, index, name, inlineValue, hasInline)
			if err != nil {
				return globals, nil, err
			}
			globals.APIBase = value
			index += consumed
		case "--json":
			globals.JSON = true
		case "--timeout":
			value, consumed, err := flagValue(args, index, name, inlineValue, hasInline)
			if err != nil {
				return globals, nil, err
			}
			timeout, err := parsePositiveInt(name, value)
			if err != nil {
				return globals, nil, err
			}
			globals.Timeout = timeout
			index += consumed
		case "--key":
			value, consumed, err := flagValue(args, index, name, inlineValue, hasInline)
			if err != nil {
				return globals, nil, err
			}
			globals.Key = value
			index += consumed
		case "--verbose":
			globals.Verbose = true
		default:
			rest = append(rest, argument)
		}
		seen[name] = true
	}
	return globals, rest, nil
}

// splitFlag 把 `--name=value` 拆成名字与内联值。
func splitFlag(argument string) (string, string, bool) {
	if !strings.HasPrefix(argument, "--") {
		return argument, "", false
	}
	name, value, found := strings.Cut(argument, "=")
	if !found {
		return name, "", false
	}
	return name, value, true
}

// flagValue 取一个参数的值：支持 `--name value` 与 `--name=value`。
//
// 返回 consumed 是「额外消耗了几个参数」（`--name value` 消耗 1）。
func flagValue(args []string, index int, name, inlineValue string, hasInline bool) (string, int, error) {
	if hasInline {
		return inlineValue, 0, nil
	}
	if index+1 >= len(args) {
		return "", 0, fmt.Errorf("%s 缺少参数值", name)
	}
	return args[index+1], 1, nil
}

// parsePositiveInt 解析正整数。非法时明确失败。
func parsePositiveInt(name, value string) (int, error) {
	parsed := 0
	for _, character := range value {
		if character < '0' || character > '9' {
			return 0, fmt.Errorf("%s 必须是正整数，收到 %q", name, value)
		}
		parsed = parsed*10 + int(character-'0')
		if parsed > 3600 {
			return 0, fmt.Errorf("%s 不能超过 3600 秒", name)
		}
	}
	if parsed <= 0 {
		return 0, fmt.Errorf("%s 必须是正整数，收到 %q", name, value)
	}
	return parsed, nil
}

// newFlagSet 建一个子命令的 flag 集。
//
// flag 集的错误输出全部丢弃：我们自己统一格式化错误并给退出码
// （flag 包默认打用法并 os.Exit(2)，与「统一退出码」冲突）。
func newFlagSet(name string) *flag.FlagSet {
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	set.SetOutput(io.Discard)
	set.Usage = func() {}
	return set
}

// usageWriter 返回写帮助的出口。
func usageWriter(out io.Writer) io.Writer {
	return out
}

// printHelp 打帮助文本。
func printHelp(out io.Writer, commands []*command, globalsHelp string) {
	fmt.Fprintln(out, "dizzy · DizzyAPI 命令行客户端")
	fmt.Fprintln(out)
	fmt.Fprintln(out, "用法：")
	fmt.Fprintln(out, "  dizzy <子命令> [参数]")
	fmt.Fprintln(out)
	fmt.Fprintln(out, "子命令：")
	for _, item := range commands {
		fmt.Fprintf(out, "  %-10s %s\n", item.Name, item.Summary)
	}
	fmt.Fprintln(out)
	fmt.Fprintln(out, "全局参数：")
	fmt.Fprint(out, globalsHelp)
	fmt.Fprintln(out)
	fmt.Fprintln(out, "退出码：0 成功 · 1 通用失败 · 2 用法错误 · 3 未登录 · 4 认证失败")
	fmt.Fprintln(out, "        5 权限不足 · 6 不存在 · 7 余额不足 · 8 限流 · 9 上游/网关错误")
	fmt.Fprintln(out)
	fmt.Fprintln(out, "示例：")
	fmt.Fprintln(out, "  dizzy login --base https://your-gateway.example.com")
	fmt.Fprintln(out, "  dizzy chat -m deepseek-flash \"你好\" --stream")
	fmt.Fprintln(out, "  dizzy usage --range 7d --by model")
	fmt.Fprintln(out, "  dizzy keys list")
	fmt.Fprintln(out, "  dizzy health")
}

// globalsHelpText 是全局参数说明。
const globalsHelpText = `  --base <url>     覆盖入口地址（默认读 ~/.dizzy/config.json）
  --llm-base <url> 只覆盖 /v1/* 的入口（本地开发时 gatewayd 是另一个端口）
  --api-base <url> 只覆盖 /api/* 的入口
  --json           输出机器可读的 JSON
  --timeout <秒>   单次请求超时（默认 60）
  --key <key>      Bearer API key（也可用环境变量 DIZZYAPI_KEY；不落盘）
  --verbose        把请求概要打到 stderr
`

// mapToValues 把字符串 map 转成 url.Values（跳过空值）。
func mapToValues(source map[string]string) url.Values {
	values := url.Values{}
	for key, value := range source {
		if value == "" {
			continue
		}
		values.Set(key, value)
	}
	return values
}
