package main

import (
	"fmt"
	"os"
	"strings"
)

// adminCommand 是 `dizzy admin`：管理员视图。
//
// 走 **/api/admin/* 与 /api/accounts**（会话 + 管理员权限）。
// 非管理员会拿到 403，退出码 5。
func adminCommand() *command {
	return &command{
		Name:    "admin",
		Summary: "管理员视图（账号 / 用户 / 价格 / 概览）",
		Usage:   "dizzy admin <accounts|users|pricing|stats> [子命令]",
		Example: "dizzy admin stats\ndizzy admin accounts list\ndizzy admin accounts test <id>\ndizzy admin pricing list",
		Run:     runAdmin,
	}
}

func runAdmin(args []string, globals globalFlags) error {
	if len(args) == 0 {
		return fmt.Errorf("%w：admin 需要子命令（accounts / users / pricing / stats）", errUsage)
	}
	switch args[0] {
	case "accounts":
		return runAdminAccounts(args[1:], globals)
	case "users":
		return runAdminUsers(args[1:], globals)
	case "pricing":
		return runAdminPricing(args[1:], globals)
	case "stats":
		return runAdminStats(args[1:], globals)
	default:
		return fmt.Errorf("%w：没有 admin 子命令 %q", errUsage, args[0])
	}
}

// adminAccount 是一条上游账号。
//
// **不含凭据**：api 插件的 accountOf 只挑前端契约里的字段，
// credentialRef / 令牌永远不会出现在响应里（packages/api/src/http.ts:3998）。
type adminAccount struct {
	ID                string   `json:"id"`
	Provider          string   `json:"provider"`
	Kind              string   `json:"kind"`
	Label             string   `json:"label"`
	Enabled           bool     `json:"enabled"`
	Status            string   `json:"status"`
	BaseURL           *string  `json:"baseUrl"`
	Protocol          *string  `json:"protocol"`
	Models            []string `json:"models"`
	Priority          int      `json:"priority"`
	LastTestAt        *string  `json:"lastTestAt"`
	LastTestOk        *bool    `json:"lastTestOk"`
	LastTestError     *string  `json:"lastTestError"`
	LastTestLatencyMs *int     `json:"lastTestLatencyMs"`
}

func runAdminAccounts(args []string, globals globalFlags) error {
	if len(args) == 0 {
		return fmt.Errorf("%w：admin accounts 需要子命令（list / show / test / enable / disable）", errUsage)
	}
	action := args[0]
	rest := args[1:]

	set := newFlagSet("admin accounts " + action)
	provider := set.String("provider", "", "按 provider 过滤")
	status := set.String("status", "", "按状态过滤")
	limit := set.Int("limit", 50, "条数")
	testModel := set.String("model", "", "连通性测试用的模型名")
	if err := set.Parse(rest); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}
	client, err := newAPIClient(config, globals)
	if err != nil {
		return err
	}

	switch action {
	case "list":
		if set.NArg() > 0 {
			return fmt.Errorf("%w：admin accounts list 不接受位置参数", errUsage)
		}
		query := map[string]string{}
		if *provider != "" {
			query["provider"] = *provider
		}
		if *status != "" {
			query["status"] = *status
		}
		if *limit != 50 {
			query["limit"] = fmt.Sprintf("%d", *limit)
		}
		values := mapToValues(query)
		var response struct {
			Items []adminAccount `json:"items"`
		}
		if err := client.DoJSON(Request{Method: "GET", Path: "/api/accounts", Query: values}, &response); err != nil {
			return err
		}
		if config.JSON {
			return printJSON(response)
		}
		if len(response.Items) == 0 {
			fmt.Fprintln(os.Stdout, "（没有账号）")
			return nil
		}
		for _, item := range response.Items {
			state := "启用"
			if !item.Enabled {
				state = "停用"
			}
			fmt.Fprintf(os.Stdout, "%s  %-20s %-10s %-12s %s\n",
				item.ID, item.Label, item.Provider, item.Status, state)
		}
		return nil

	case "show":
		if set.NArg() != 1 {
			return fmt.Errorf("%w：admin accounts show 需要一个账号 id", errUsage)
		}
		var item adminAccount
		if err := client.DoJSON(Request{Method: "GET", Path: "/api/accounts/" + set.Arg(0)}, &item); err != nil {
			return err
		}
		if config.JSON {
			return printJSON(item)
		}
		fmt.Fprintf(os.Stdout, "id：%s\n", item.ID)
		fmt.Fprintf(os.Stdout, "名字：%s\n", item.Label)
		fmt.Fprintf(os.Stdout, "provider：%s（%s）\n", item.Provider, item.Kind)
		fmt.Fprintf(os.Stdout, "状态：%s\n", item.Status)
		if item.BaseURL != nil {
			fmt.Fprintf(os.Stdout, "baseUrl：%s\n", *item.BaseURL)
		}
		if item.Protocol != nil {
			fmt.Fprintf(os.Stdout, "协议：%s\n", *item.Protocol)
		}
		if len(item.Models) > 0 {
			fmt.Fprintf(os.Stdout, "模型：%s\n", strings.Join(item.Models, ", "))
		}
		return nil

	case "test":
		if set.NArg() != 1 {
			return fmt.Errorf("%w：admin accounts test 需要一个账号 id", errUsage)
		}
		body := map[string]string{}
		if *testModel != "" {
			body["model"] = *testModel
		}
		var result map[string]any
		announceWriteTarget(config, "账号连通性测试 "+set.Arg(0))
		if err := client.DoJSON(Request{
			Method: "POST",
			Path:   "/api/accounts/" + set.Arg(0) + "/test",
			Body:   body,
		}, &result); err != nil {
			return err
		}
		if config.JSON {
			return printJSON(result)
		}
		fmt.Fprintln(os.Stdout, "连通性测试结果：")
		for _, key := range []string{"ok", "model", "latencyMs", "error", "message"} {
			if value, ok := result[key]; ok {
				fmt.Fprintf(os.Stdout, "  %s：%v\n", key, value)
			}
		}
		return nil

	case "enable", "disable":
		if set.NArg() != 1 {
			return fmt.Errorf("%w：admin accounts %s 需要一个账号 id", errUsage, action)
		}
		enabled := action == "enable"
		var item adminAccount
		announceWriteTarget(config, action+" 账号 "+set.Arg(0))
		if err := client.DoJSON(Request{
			Method: "PATCH",
			Path:   "/api/accounts/" + set.Arg(0),
			Body:   map[string]bool{"enabled": enabled},
		}, &item); err != nil {
			return err
		}
		fmt.Fprintf(os.Stdout, "已%s：%s（%s）\n", action, item.Label, item.ID)
		return nil

	default:
		return fmt.Errorf("%w：没有 admin accounts 子命令 %q", errUsage, action)
	}
}

func runAdminUsers(args []string, globals globalFlags) error {
	set := newFlagSet("admin users list")
	if len(args) > 0 && args[0] == "list" {
		if err := set.Parse(args[1:]); err != nil {
			return fmt.Errorf("%w：%v", errUsage, err)
		}
	} else if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
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
		Items []struct {
			ID           int64  `json:"id"`
			Name         string `json:"name"`
			Status       string `json:"status"`
			Role         string `json:"role"`
			BalanceMinor string `json:"balanceMinor"`
		} `json:"items"`
	}
	if err := client.DoJSON(Request{Method: "GET", Path: "/api/users"}, &response); err != nil {
		return err
	}
	if config.JSON {
		return printJSON(response)
	}
	for _, item := range response.Items {
		fmt.Fprintf(os.Stdout, "%d  %-20s %-10s %-8s %s 微元\n",
			item.ID, item.Name, item.Role, item.Status, item.BalanceMinor)
	}
	return nil
}

func runAdminPricing(args []string, globals globalFlags) error {
	action := "list"
	if len(args) > 0 {
		action = args[0]
	}
	set := newFlagSet("admin pricing " + action)
	model := set.String("model", "", "模型名")
	input := set.String("input", "", "输入单价（元 / 百万 token）")
	output := set.String("output", "", "输出单价（元 / 百万 token）")
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}
	client, err := newAPIClient(config, globals)
	if err != nil {
		return err
	}

	switch action {
	case "list":
		var response struct {
			Items []catalogPrice `json:"items"`
		}
		if err := client.DoJSON(Request{Method: "GET", Path: "/api/pricing"}, &response); err != nil {
			return err
		}
		if config.JSON {
			return printJSON(response)
		}
		for _, item := range response.Items {
			fmt.Fprintf(os.Stdout, "输入 %s / 输出 %s %s\n",
				item.InputPerMillion, item.OutputPerMillion, item.Currency)
		}
		return nil
	case "set":
		if *model == "" || *input == "" || *output == "" {
			return fmt.Errorf("%w：pricing set 需要 --model / --input / --output", errUsage)
		}
		var written catalogPrice
		announceWriteTarget(config, "设置价格 "+*model)
		if err := client.DoJSON(Request{
			Method: "PUT",
			Path:   "/api/pricing/" + *model,
			Body: map[string]string{
				"inputPerMillion":  *input,
				"outputPerMillion": *output,
			},
		}, &written); err != nil {
			return err
		}
		fmt.Fprintf(os.Stdout, "已设置 %s：输入 %s / 输出 %s %s\n",
			*model, written.InputPerMillion, written.OutputPerMillion, written.Currency)
		return nil
	default:
		return fmt.Errorf("%w：admin pricing 只接受 list / set", errUsage)
	}
}

func runAdminStats(args []string, globals globalFlags) error {
	set := newFlagSet("admin stats")
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}
	client, err := newAPIClient(config, globals)
	if err != nil {
		return err
	}

	var response map[string]any
	if err := client.DoJSON(Request{Method: "GET", Path: "/api/admin/stats"}, &response); err != nil {
		return err
	}
	if config.JSON {
		return printJSON(response)
	}
	fmt.Fprintln(os.Stdout, "概览：")
	for _, key := range []string{"users", "accounts", "keys"} {
		if value, ok := response[key].(map[string]any); ok {
			fmt.Fprintf(os.Stdout, "  %s：%v\n", key, value)
		}
	}
	if usage, ok := response["usage"]; ok {
		fmt.Fprintf(os.Stdout, "  usage：%v\n", usage)
	}
	return nil
}
