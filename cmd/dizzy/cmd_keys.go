package main

import (
	"fmt"
	"os"
	"strings"
)

// keysCommand 是 `dizzy keys`：管理自己的 API key。
//
// 走 **/api/keys**（会话）。key 的**完整值**只在创建 / 轮换时出现一次
// （api 插件的约定，packages/api/src/http.ts:648）。
//
// **CLI 默认掩码打印**：owner 的硬边界是 API key「不得打印完整 key」。
// 要完整值必须显式加 --show。
func keysCommand() *command {
	return &command{
		Name:    "keys",
		Summary: "管理 API key（list / create / rotate / enable / disable / delete）",
		Usage:   "dizzy keys <list|create|rotate|enable|disable|delete> [参数]",
		Example: "dizzy keys list\ndizzy keys create --name \"我的 key\"\ndizzy keys rotate <id>\ndizzy keys disable <id>",
		Run:     runKeys,
	}
}

func runKeys(args []string, globals globalFlags) error {
	if len(args) == 0 {
		return fmt.Errorf("%w：keys 需要子命令（list / create / rotate / enable / disable / delete）", errUsage)
	}
	action := args[0]
	rest := args[1:]

	switch action {
	case "list":
		return runKeysList(rest, globals)
	case "create":
		return runKeysCreate(rest, globals)
	case "rotate":
		return runKeysRotate(rest, globals)
	case "enable", "disable":
		return runKeysToggle(rest, globals, action == "enable")
	case "delete":
		return runKeysDelete(rest, globals)
	default:
		return fmt.Errorf("%w：没有 keys 子命令 %q", errUsage, action)
	}
}

// apiKeySummary 是一条 key 的摘要。
//
// secret 可能为 null（服务端没给）；maskedKey 是掩码。
type apiKeySummary struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	TrackingID string  `json:"trackingId"`
	Secret     *string `json:"secret"`
	MaskedKey  string  `json:"maskedKey"`
	CreatedAt  string  `json:"createdAt"`
	LastUsedAt *string `json:"lastUsedAt"`
	AppManaged bool    `json:"appManaged"`
	Enabled    bool    `json:"enabled"`
}

func runKeysList(args []string, globals globalFlags) error {
	set := newFlagSet("keys list")
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}
	if set.NArg() > 0 {
		return fmt.Errorf("%w：keys list 不接受位置参数", errUsage)
	}

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}
	client, err := newAPIClient(config, globals)
	if err != nil {
		return err
	}

	var response struct {
		Items []apiKeySummary `json:"items"`
	}
	if err := client.DoJSON(Request{Method: "GET", Path: "/api/keys"}, &response); err != nil {
		return err
	}
	if config.JSON {
		return printJSON(response)
	}
	if len(response.Items) == 0 {
		fmt.Fprintln(os.Stdout, "（还没有 API key）")
		return nil
	}
	for _, item := range response.Items {
		state := "启用"
		if !item.Enabled {
			state = "停用"
		}
		fmt.Fprintf(os.Stdout, "%s  %-20s %-24s %s\n", item.ID, item.Name, item.MaskedKey, state)
	}
	return nil
}

func runKeysCreate(args []string, globals globalFlags) error {
	set := newFlagSet("keys create")
	name := set.String("name", "", "key 的名字")
	show := set.Bool("show", false, "打印完整 key（默认只打掩码）")
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}
	if set.NArg() > 0 {
		return fmt.Errorf("%w：keys create 不接受位置参数", errUsage)
	}
	if strings.TrimSpace(*name) == "" {
		return fmt.Errorf("%w：必须用 --name 指定名字", errUsage)
	}

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}
	client, err := newAPIClient(config, globals)
	if err != nil {
		return err
	}

	var created apiKeySummary
	if err := client.DoJSON(Request{
		Method: "POST",
		Path:   "/api/keys",
		Body:   map[string]string{"name": *name},
	}, &created); err != nil {
		return err
	}

	if config.JSON {
		// JSON 输出里也**默认不给完整 secret**，除非 --show。
		payload := created
		if !*show {
			payload.Secret = nil
		}
		return printJSON(payload)
	}

	fmt.Fprintf(os.Stdout, "已创建：%s（%s）\n", created.Name, created.ID)
	printKeySecret(created, *show)
	return nil
}

func runKeysRotate(args []string, globals globalFlags) error {
	set := newFlagSet("keys rotate")
	show := set.Bool("show", false, "打印完整 key（默认只打掩码）")
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}
	if set.NArg() != 1 {
		return fmt.Errorf("%w：keys rotate 需要一个 key id", errUsage)
	}
	keyID := set.Arg(0)

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}
	client, err := newAPIClient(config, globals)
	if err != nil {
		return err
	}

	var rotated apiKeySummary
	if err := client.DoJSON(Request{
		Method: "POST",
		Path:   "/api/keys/" + keyID + "/rotate",
	}, &rotated); err != nil {
		return err
	}

	if config.JSON {
		payload := rotated
		if !*show {
			payload.Secret = nil
		}
		return printJSON(payload)
	}

	fmt.Fprintf(os.Stdout, "已轮换：%s（%s）\n", rotated.Name, rotated.ID)
	printKeySecret(rotated, *show)
	return nil
}

func runKeysToggle(args []string, globals globalFlags, enabled bool) error {
	action := "disable"
	if enabled {
		action = "enable"
	}
	set := newFlagSet("keys " + action)
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}
	if set.NArg() != 1 {
		return fmt.Errorf("%w：keys %s 需要一个 key id", errUsage, action)
	}
	keyID := set.Arg(0)

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}
	client, err := newAPIClient(config, globals)
	if err != nil {
		return err
	}

	var updated apiKeySummary
	if err := client.DoJSON(Request{
		Method: "PATCH",
		Path:   "/api/keys/" + keyID,
		Body:   map[string]bool{"enabled": enabled},
	}, &updated); err != nil {
		return err
	}

	if config.JSON {
		return printJSON(updated)
	}
	fmt.Fprintf(os.Stdout, "已%s：%s（%s）\n", action, updated.Name, updated.ID)
	return nil
}

func runKeysDelete(args []string, globals globalFlags) error {
	set := newFlagSet("keys delete")
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}
	if set.NArg() != 1 {
		return fmt.Errorf("%w：keys delete 需要一个 key id", errUsage)
	}
	keyID := set.Arg(0)

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}
	client, err := newAPIClient(config, globals)
	if err != nil {
		return err
	}
	if err := client.DoJSON(Request{
		Method: "DELETE",
		Path:   "/api/keys/" + keyID,
	}, nil); err != nil {
		return err
	}
	fmt.Fprintf(os.Stdout, "已删除：%s\n", keyID)
	return nil
}

// printKeySecret 打印一次性 secret。
//
// 默认**只打掩码**：完整 key 不进 stdout / 日志（AGENTS.md §2.4.1）。
// 要完整值必须显式 --show。
func printKeySecret(item apiKeySummary, show bool) {
	if item.Secret == nil || *item.Secret == "" {
		fmt.Fprintln(os.Stdout, "（服务端没有返回 secret）")
		return
	}
	if !show {
		fmt.Fprintf(os.Stdout, "完整 key：%s（加 --show 才显示完整值）\n", item.MaskedKey)
		return
	}
	fmt.Fprintf(os.Stdout, "完整 key：%s\n", *item.Secret)
}
