package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"
)

// loginCommand 是 `dizzy login`。
//
// 密码**只**从环境变量或 stdin 读：**明确不接受命令行明文**（会进 shell history）。
func loginCommand() *command {
	return &command{
		Name:    "login",
		Summary: "登录并保存会话到 ~/.dizzy/credentials.json",
		Usage:   "dizzy login [--email <邮箱>] [--base <url>]",
		Example: "dizzy login --email me@example.com\ndizzy login --email me@example.com < password.txt",
		Run:     runLogin,
	}
}

func runLogin(args []string, globals globalFlags) error {
	set := newFlagSet("login")
	email := set.String("email", "", "登录邮箱")
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}
	if set.NArg() > 0 {
		return fmt.Errorf("%w：login 不接受位置参数", errUsage)
	}

	address := strings.TrimSpace(*email)
	if address == "" {
		return fmt.Errorf("%w：必须用 --email 指定邮箱", errUsage)
	}

	password, err := readPassword()
	if err != nil {
		return err
	}

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}

	// 登录是**还没有会话**的 /api/* 请求：请求头必须带，cookie 还没有。
	client, err := newAPIAnonClient(config, globals)
	if err != nil {
		return err
	}

	var response loginResponse
	raw, err := client.Do(Request{
		Method: "POST",
		Path:   "/api/auth/login",
		Body: map[string]string{
			"email":    address,
			"password": password,
		},
		CaptureCookie: sessionCookieName,
	})
	if err != nil {
		return err
	}
	if len(raw.Body) > 0 {
		if err := decodeJSON(raw.Body, &response); err != nil {
			return err
		}
	}

	// 会话 cookie 是 HttpOnly 的，只在 Set-Cookie 头里（不进 JSON 体）。
	token := raw.Cookie
	if token == "" {
		return errors.New("登录成功但响应里没有会话 cookie：网关的 Set-Cookie 没被带回来")
	}

	credentials := Credentials{Session: &Session{
		Token:     token,
		ExpiresAt: response.sessionExpiresAt(),
		Email:     address,
	}}
	if err := SaveCredentials(credentials); err != nil {
		return err
	}

	if config.JSON {
		return printJSON(map[string]any{
			"ok":        true,
			"email":     address,
			"expiresAt": credentials.Session.ExpiresAt,
			"user":      response.User,
		})
	}
	fmt.Fprintf(os.Stdout, "已登录：%s\n", address)
	if credentials.Session.ExpiresAt != "" {
		fmt.Fprintf(os.Stdout, "会话到期：%s\n", credentials.Session.ExpiresAt)
	}
	return nil
}

// readPassword 读密码。
//
// 来源顺序：环境变量 DIZZYAPI_PASSWORD → stdin 一行。
//
// **不做终端隐藏输入**：Windows 上隐藏输入需要 golang.org/x/term（第三方依赖），
// 与「只依赖标准库」冲突。环境变量与 stdin 管道覆盖了 agent 与 CI 的主要用法。
func readPassword() (string, error) {
	if fromEnv := os.Getenv(envPassword); fromEnv != "" {
		return fromEnv, nil
	}
	info, err := os.Stdin.Stat()
	if err == nil && info.Mode()&os.ModeCharDevice == 0 {
		// stdin 是管道或文件：读第一行。
		reader := bufio.NewReader(os.Stdin)
		line, readErr := reader.ReadString('\n')
		if readErr != nil && line == "" {
			return "", fmt.Errorf("从 stdin 读密码失败：%w", readErr)
		}
		password := strings.TrimRight(line, "\r\n")
		if password == "" {
			return "", errors.New("密码为空")
		}
		return password, nil
	}
	return "", fmt.Errorf(
		"没有拿到密码：请设置环境变量 %s，或用管道提供（dizzy login --email x < password.txt）",
		envPassword,
	)
}

// logoutCommand 是 `dizzy logout`。
func logoutCommand() *command {
	return &command{
		Name:    "logout",
		Summary: "登出并删除本机会话",
		Usage:   "dizzy logout",
		Example: "dizzy logout",
		Run:     runLogout,
	}
}

func runLogout(args []string, globals globalFlags) error {
	set := newFlagSet("logout")
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}
	if set.NArg() > 0 {
		return fmt.Errorf("%w：logout 不接受位置参数", errUsage)
	}

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}

	// 先读 token 再删本地凭据：远端登出需要它。
	// 读不到（本来就没登录）也算登出成功 —— 登出是幂等的。
	token, tokenErr := SessionToken()

	// 本地凭据删掉：即使远端登出失败，本机也不再留着会话。
	if err := ClearCredentials(); err != nil {
		return err
	}

	if tokenErr != nil {
		if !errors.Is(tokenErr, ErrCredentialsMissing) {
			return tokenErr
		}
		fmt.Fprintln(os.Stdout, "已登出")
		return nil
	}

	client, err := NewClient(ClientOptions{
		BaseURL:          config.APIURL(),
		Timeout:          timeoutOf(config),
		SessionToken:     token,
		APIRequestHeader: true,
		Verbose:          globals.Verbose,
		Log:              verboseLogger(globals.Verbose),
	})
	if err != nil {
		return err
	}
	if err := client.DoJSON(Request{Method: "POST", Path: "/api/auth/logout"}, nil); err != nil {
		var apiError *APIError
		if errors.As(err, &apiError) && apiError.Status < 500 {
			// 远端说会话已失效：也算登出成功。
			fmt.Fprintln(os.Stdout, "已登出")
			return nil
		}
		fmt.Fprintf(os.Stderr, "dizzy: 本地凭据已删除，但远端登出失败：%v\n", err)
		return nil
	}
	fmt.Fprintln(os.Stdout, "已登出")
	return nil
}

// whoamiCommand 是 `dizzy whoami`。
func whoamiCommand() *command {
	return &command{
		Name:    "whoami",
		Summary: "显示当前登录用户与余额",
		Usage:   "dizzy whoami",
		Example: "dizzy whoami\ndizzy whoami --json",
		Run:     runWhoami,
	}
}

func runWhoami(args []string, globals globalFlags) error {
	set := newFlagSet("whoami")
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}
	if set.NArg() > 0 {
		return fmt.Errorf("%w：whoami 不接受位置参数", errUsage)
	}

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}
	client, err := newAPIClient(config, globals)
	if err != nil {
		return err
	}

	var response sessionResponse
	if err := client.DoJSON(Request{Method: "GET", Path: "/api/session"}, &response); err != nil {
		return err
	}

	if config.JSON {
		return printJSON(response)
	}

	name := response.User.Name
	if name == "" {
		name = "（未设置用户名）"
	}
	fmt.Fprintf(os.Stdout, "用户：%s\n", name)
	if response.Email != "" {
		fmt.Fprintf(os.Stdout, "邮箱：%s\n", response.Email)
	}
	fmt.Fprintf(os.Stdout, "角色：%s\n", response.User.Role)
	fmt.Fprintf(os.Stdout, "状态：%s\n", response.User.Status)
	// 余额是**整数分**（api 插件的 balanceCents）。这里原样显示，不做浮点换算。
	if response.User.BalanceCents != nil {
		fmt.Fprintf(os.Stdout, "余额：%d 分\n", *response.User.BalanceCents)
	}
	if response.Session.ExpiresAt != "" {
		fmt.Fprintf(os.Stdout, "会话到期：%s\n", response.Session.ExpiresAt)
	}
	return nil
}
