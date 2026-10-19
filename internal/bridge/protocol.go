// Package bridge 是 cordis（TS）与 gatewayd（Go）之间的控制桥。
//
// 它只承载控制消息：组件生命周期、配置下发、命令与查询、事件上行（AGENTS.md D3）。
// LLM 请求**不**走这里（§2.3）；因此这里不需要请求级 Ctx、body 或客户端生命周期。
//
// 帧格式：4 字节大端长度 + UTF-8 JSON。
// 传输：Unix domain socket（生产/Linux）或 127.0.0.1 TCP（Windows 开发机）。
package bridge

import (
	"context"
	"encoding/json"
	"fmt"
)

// ProtocolVersion 是握手版本。只在不兼容变更时递增。
const ProtocolVersion = 1

// 桥上的方法名。它们都是控制消息，不属于 LLM 请求链路。
const (
	MethodStatus            = "accountPriority.status"
	MethodListStrategies    = "accountPriority.listStrategies"
	MethodReplaceStrategies = "accountPriority.replaceStrategies"
	MethodPreview           = "accountPriority.preview"
	MethodPick              = "accountPriority.pick"
	// MethodReplaceAccounts 是 identity → Go 的只读账号/令牌快照下发。
	// 帧里含令牌，因此响应、日志与状态查询都不得回显快照内容。
	MethodReplaceAccounts = "accounts.replace"
	MethodAccountsStatus  = "accounts.status"
	MethodShutdown        = "shutdown"
)

// Request 是 TS → Go 的一次请求。
type Request struct {
	ID     string          `json:"id,omitempty"`
	Type   string          `json:"type"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Response 是 Go → TS 的请求结果。
type Response struct {
	ID     string     `json:"id"`
	Type   string     `json:"type"`
	OK     bool       `json:"ok"`
	Result any        `json:"result,omitempty"`
	Error  *ErrorBody `json:"error,omitempty"`
}

// Event 是 Go → TS 的单向通知（hello、配置已应用、即将退出等）。
type Event struct {
	Type  string `json:"type"`
	Event string `json:"event"`
	Data  any    `json:"data,omitempty"`
}

// ErrorBody 是稳定的错误载荷。
type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Error 让 handler 可以返回带稳定错误码的失败。
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Errorf 构造一个带稳定错误码的 handler 错误。
func Errorf(code string, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Handler 处理一条控制消息。params 原样是 JSON，由业务层自己解码。
// 控制消息不绑定客户端生命周期，所以 ctx 是服务级上下文，不是某个 LLM 请求。
type Handler interface {
	Handle(ctx context.Context, method string, params json.RawMessage) (any, error)
}

// HandlerFunc 让普通函数满足 Handler。
type HandlerFunc func(ctx context.Context, method string, params json.RawMessage) (any, error)

func (f HandlerFunc) Handle(ctx context.Context, method string, params json.RawMessage) (any, error) {
	return f(ctx, method, params)
}
