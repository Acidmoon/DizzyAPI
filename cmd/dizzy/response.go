package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// timeoutOf 从配置取超时。
func timeoutOf(config Config) time.Duration {
	seconds := config.TimeoutSeconds
	if seconds <= 0 {
		seconds = defaultTimeoutSeconds
	}
	return time.Duration(seconds) * time.Second
}

// printJSON 打机器可读的 JSON 输出。
//
// 用 Encoder 而不是 Marshal：换行结尾更友好，且大结构不会先拼成一个巨型字符串。
func printJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

// decodeJSON 解析 JSON 字节。失败时明确报错。
func decodeJSON(raw []byte, out any) error {
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("解析响应 JSON 失败：%w", err)
	}
	return nil
}

// loginResponse 是 `POST /api/auth/login` 的响应。
//
// 会话 token **不在**这个 JSON 里（它是 HttpOnly cookie），
// 所以这里只有用户信息与会话元信息。
type loginResponse struct {
	User    sessionUser `json:"user"`
	Session sessionInfo `json:"session"`
}

// sessionExpiresAt 返回会话过期时间。
func (r loginResponse) sessionExpiresAt() string {
	return r.Session.ExpiresAt
}

// sessionResponse 是 `GET /api/session` 的响应。
type sessionResponse struct {
	User        sessionUser `json:"user"`
	Email       string      `json:"email"`
	Session     sessionInfo `json:"session"`
	Permissions struct {
		Admin bool `json:"admin"`
	} `json:"permissions"`
}

// sessionUser 是用户视图。
//
// 余额是**整数分**（balanceCents），不是浮点 —— api 插件给的就是整数分。
type sessionUser struct {
	ID             int64   `json:"id"`
	Name           string  `json:"name"`
	Status         string  `json:"status"`
	Role           string  `json:"role"`
	BalanceEnabled bool    `json:"balanceEnabled"`
	BalanceCents   *int64  `json:"balanceCents"`
	Avatar         *string `json:"avatar"`
	CreatedAt      string  `json:"createdAt"`
	UpdatedAt      string  `json:"updatedAt"`
}

// sessionInfo 是会话元信息。
type sessionInfo struct {
	ID         string `json:"id"`
	CreatedAt  string `json:"createdAt"`
	ExpiresAt  string `json:"expiresAt"`
	LastSeenAt string `json:"lastSeenAt"`
}

// healthComponent 是健康报告里的一个组件。
type healthComponent struct {
	Name   string `json:"name"`
	State  string `json:"state"`
	Detail string `json:"detail"`
}

// healthResponse 是 `GET /api/health` 的响应（TS 控制面）。
type healthResponse struct {
	State      string            `json:"state"`
	At         string            `json:"at"`
	Version    string            `json:"version"`
	UptimeSec  int64             `json:"uptimeSec"`
	Bridge     healthBridge      `json:"bridge"`
	Components []healthComponent `json:"components"`
}

// healthBridge 是控制桥的连通状态。
type healthBridge struct {
	Connected bool   `json:"connected"`
	Transport string `json:"transport"`
	Address   string `json:"address"`
}

// gatewayHealthResponse 是 `GET /healthz` 的响应（Go 数据面）。
type gatewayHealthResponse struct {
	Status    string `json:"status"`
	Accounts  int    `json:"accounts"`
	Revision  string `json:"revision"`
	Requests  uint64 `json:"requests"`
	UptimeSec int64  `json:"uptimeSec"`
	StartedAt string `json:"startedAt"`
}
