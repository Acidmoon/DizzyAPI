package main

import (
	"fmt"
	"os"
)

// healthCommand 是 `dizzy health`。
//
// 它打**两个**健康端点，因为它们属于两个进程：
//   - GET /healthz  → Go 数据面（gatewayd）：账号快照、请求数、运行时长
//   - GET /api/health → TS 控制面（api 插件）：桥连通性、各插件状态
//
// 两个都不需要鉴权（/healthz 是 LLM 入口的公开探针，/api/health 是公开面）。
func healthCommand() *command {
	return &command{
		Name:    "health",
		Summary: "检查网关健康（Go 数据面 + TS 控制面）",
		Usage:   "dizzy health",
		Example: "dizzy health\ndizzy health --json",
		Run:     runHealth,
	}
}

func runHealth(args []string, globals globalFlags) error {
	set := newFlagSet("health")
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}
	if set.NArg() > 0 {
		return fmt.Errorf("%w：health 不接受位置参数", errUsage)
	}

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}

	// 数据面与控制面是**两个不同的 base**（本地开发时是两个端口）。
	gateway, gatewayErr := NewClient(ClientOptions{
		BaseURL: config.LLMURL(),
		Timeout: timeoutOf(config),
		Verbose: globals.Verbose,
		Log:     verboseLogger(globals.Verbose),
	})
	// /api/health 是公开端点，但**请求头仍然必须带**（/api/* 的无条件要求）。
	control, controlErr := newAPIAnonClient(config, globals)
	if gatewayErr != nil {
		return gatewayErr
	}
	if controlErr != nil {
		return controlErr
	}

	result := map[string]any{}

	var gatewayHealth gatewayHealthResponse
	if err := gateway.DoJSON(Request{Method: "GET", Path: "/healthz"}, &gatewayHealth); err != nil {
		result["dataPlane"] = map[string]any{"ok": false, "error": err.Error()}
	} else {
		result["dataPlane"] = map[string]any{
			"ok":        gatewayHealth.Status == "ok",
			"status":    gatewayHealth.Status,
			"accounts":  gatewayHealth.Accounts,
			"requests":  gatewayHealth.Requests,
			"uptimeSec": gatewayHealth.UptimeSec,
		}
	}

	var controlHealth healthResponse
	if err := control.DoJSON(Request{Method: "GET", Path: "/api/health"}, &controlHealth); err != nil {
		result["controlPlane"] = map[string]any{"ok": false, "error": err.Error()}
	} else {
		result["controlPlane"] = map[string]any{
			"ok":         controlHealth.State == "ok",
			"state":      controlHealth.State,
			"version":    controlHealth.Version,
			"uptimeSec":  controlHealth.UptimeSec,
			"bridge":     controlHealth.Bridge,
			"components": controlHealth.Components,
		}
	}

	if config.JSON {
		if err := printJSON(result); err != nil {
			return err
		}
	} else {
		printHealth(result)
	}

	// 两边都健康才算成功：任一端挂了就返回非 0 退出码，agent 才能发现。
	if !healthPartOK(result, "dataPlane") || !healthPartOK(result, "controlPlane") {
		return errUnhealthy
	}
	return nil
}

// errUnhealthy 表示健康检查没全过。
var errUnhealthy = fmt.Errorf("健康检查未通过")

// healthPartOK 判断健康报告里某一部分是否正常。
func healthPartOK(result map[string]any, part string) bool {
	value, ok := result[part].(map[string]any)
	if !ok {
		return false
	}
	healthy, ok := value["ok"].(bool)
	return ok && healthy
}

// printHealth 打人看的健康报告。
func printHealth(result map[string]any) {
	if dataPlane, ok := result["dataPlane"].(map[string]any); ok {
		if okFlag, _ := dataPlane["ok"].(bool); okFlag {
			fmt.Fprintf(os.Stdout, "数据面（/healthz）：ok  账号 %v  请求 %v  运行时长 %vs\n",
				dataPlane["accounts"], dataPlane["requests"], dataPlane["uptimeSec"])
		} else {
			fmt.Fprintf(os.Stdout, "数据面（/healthz）：异常  %v\n", dataPlane["error"])
		}
	}
	if controlPlane, ok := result["controlPlane"].(map[string]any); ok {
		if okFlag, _ := controlPlane["ok"].(bool); okFlag {
			fmt.Fprintf(os.Stdout, "控制面（/api/health）：%v  版本 %v\n",
				controlPlane["state"], controlPlane["version"])
			bridge, _ := controlPlane["bridge"].(map[string]any)
			if bridge != nil {
				connected, _ := bridge["connected"].(bool)
				transport, _ := bridge["transport"].(string)
				address, _ := bridge["address"].(string)
				fmt.Fprintf(os.Stdout, "  控制桥：%v（%v %v）\n", connected, transport, address)
			}
			components, _ := controlPlane["components"].([]healthComponent)
			for _, component := range components {
				line := fmt.Sprintf("  - %s：%s", component.Name, component.State)
				if component.Detail != "" {
					line += "（" + component.Detail + "）"
				}
				fmt.Fprintln(os.Stdout, line)
			}
		} else {
			fmt.Fprintf(os.Stdout, "控制面（/api/health）：异常  %v\n", controlPlane["error"])
		}
	}
}
