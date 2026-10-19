// Package transport 是 dispatch 相位的上游派发阶段。
//
// 它只接受「向某个上游、用某组凭据、发这个请求」这样的输入（D17）：
// 账号从 Ctx.AccountRoute.Picked 来，令牌从 CredentialSource 按账号 id 取。
// 它不感知号池、不选账号、不修改账号状态；失败只上报事实（D18）。
//
// 秘密边界：
//   - 只把令牌放进上游 Authorization 头；
//   - 不转发客户端的 Authorization；
//   - 上游错误正文会先按令牌脱敏、截断，再交给 engine；
//   - 任何日志都不包含令牌或请求体。
package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const (
	// ServiceName 是注册表里的服务名。
	ServiceName = "transport"
	// StageName 是描述符里的阶段名。
	StageName = "transport"

	DefaultRequestTimeoutMs = 120_000
	DefaultHeaderTimeoutMs  = 60_000
	DefaultMaxResponseBytes = int64(32 << 20)
	DefaultMaxErrorBytes    = int64(8 << 10)
	DefaultPath             = "/chat/completions"
)

// Config 是 transport 的运行参数。
type Config struct {
	// RequestTimeoutMs 只约束非流式请求；流式请求靠客户端取消与 HeaderTimeout。
	RequestTimeoutMs int
	// HeaderTimeoutMs 是等待上游响应头的上限。
	HeaderTimeoutMs int
	// MaxResponseBytes 是非流式响应体上限。
	MaxResponseBytes int64
	// MaxErrorBytes 是上游错误正文最多读取的字节数。
	MaxErrorBytes int64
	// Path 是追加在账号 baseUrl 后面的 OpenAI 兼容路径。
	Path string
	// UserAgent 为空时使用 gatewayd/0.1。
	UserAgent string
}

func (c Config) resolved() Config {
	if c.RequestTimeoutMs <= 0 {
		c.RequestTimeoutMs = DefaultRequestTimeoutMs
	}
	if c.HeaderTimeoutMs <= 0 {
		c.HeaderTimeoutMs = DefaultHeaderTimeoutMs
	}
	if c.MaxResponseBytes <= 0 {
		c.MaxResponseBytes = DefaultMaxResponseBytes
	}
	if c.MaxErrorBytes <= 0 {
		c.MaxErrorBytes = DefaultMaxErrorBytes
	}
	if c.Path == "" {
		c.Path = DefaultPath
	}
	if !strings.HasPrefix(c.Path, "/") {
		c.Path = "/" + c.Path
	}
	if c.UserAgent == "" {
		c.UserAgent = "gatewayd/0.1"
	}
	return c
}

// Stage 是 dispatch 相位的 HTTP 派发阶段。
type Stage struct {
	config Config
	source contracts.CredentialSource
	client *http.Client
}

// New 构造阶段。source 是实现账号快照缓存的任意对象。
func New(cfg Config, source contracts.CredentialSource) (*Stage, error) {
	if source == nil {
		return nil, errors.New("transport: CredentialSource 不能为空")
	}
	cfg = cfg.resolved()
	base := http.DefaultTransport.(*http.Transport).Clone()
	base.ResponseHeaderTimeout = time.Duration(cfg.HeaderTimeoutMs) * time.Millisecond
	// 不跟随重定向：Authorization 不能被带到另一个主机。
	client := &http.Client{
		Transport: base,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return &Stage{config: cfg, source: source, client: client}, nil
}

// Register 把 transport 阶段挂到组合根上。
func Register(reg *contracts.Registry, cfg Config, source contracts.CredentialSource) (*Stage, error) {
	stage, err := New(cfg, source)
	if err != nil {
		return nil, err
	}
	reg.Service(ServiceName, stage)
	reg.Stage(stage)
	return stage, nil
}

func (s *Stage) Name() string           { return StageName }
func (s *Stage) Phase() contracts.Phase { return contracts.PhaseDispatch }
func (s *Stage) Required() bool         { return true }
func (s *Stage) NeedBody() bool         { return true }

// Run 向上游发一次请求。
//
// 2xx：返回 ActionRespond；流式响应用 Decision.Stream 交给 engine 原样透传。
// 非 2xx / 网络失败：返回 StageError；Retryable 表示 engine 可以换下一个账号。
func (s *Stage) Run(ctx *contracts.Ctx) (contracts.Decision, error) {
	if ctx == nil {
		return contracts.Decision{}, contracts.Errorf(http.StatusInternalServerError, "TRANSPORT_INVALID_REQUEST", "请求上下文为空")
	}
	if ctx.AccountRoute == nil || ctx.AccountRoute.Picked == nil {
		return contracts.Decision{}, retryableError(http.StatusServiceUnavailable, "ACCOUNT_UNAVAILABLE", "没有选中的账号")
	}
	accountID := ctx.AccountRoute.Picked.AccountID
	credential, ok := s.source.Credential(accountID)
	if !ok {
		return contracts.Decision{}, retryableError(http.StatusServiceUnavailable, "ACCOUNT_UNAVAILABLE", "账号没有可用凭据")
	}
	if ctx.Body == nil {
		return contracts.Decision{}, contracts.Errorf(http.StatusBadRequest, "REQUEST_BODY_REQUIRED", "请求体缺失")
	}
	body, err := ctx.Body.Bytes()
	if err != nil {
		return contracts.Decision{}, contracts.Errorf(http.StatusBadRequest, "REQUEST_BODY_INVALID", "请求体读取失败")
	}

	target, err := joinURL(credential.BaseURL, s.config.Path)
	if err != nil {
		return contracts.Decision{}, contracts.Errorf(http.StatusBadGateway, "UPSTREAM_URL_INVALID", "上游地址不合法")
	}

	requestContext := ctx.Context
	var cancel context.CancelFunc
	if !ctx.Meta.Stream {
		requestContext, cancel = context.WithTimeout(requestContext, time.Duration(s.config.RequestTimeoutMs)*time.Millisecond)
		defer cancel()
	}

	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return contracts.Decision{}, contracts.Errorf(http.StatusBadGateway, "UPSTREAM_REQUEST_FAILED", "构造上游请求失败")
	}
	request.Header.Set("Content-Type", "application/json")
	if ctx.Meta.Stream {
		request.Header.Set("Accept", "text/event-stream")
	} else {
		request.Header.Set("Accept", "application/json")
	}
	request.Header.Set("User-Agent", s.config.UserAgent)
	// 只放账号令牌；客户端的 Authorization（网关密钥）绝不外传。
	request.Header.Set("Authorization", "Bearer "+credential.AccessToken)

	response, err := s.client.Do(request)
	if err != nil {
		return contracts.Decision{}, s.networkError(ctx, err, credential.AccessToken)
	}

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		return contracts.Decision{}, s.upstreamError(response, credential.AccessToken)
	}

	headers := map[string]string{}
	if contentType := response.Header.Get("Content-Type"); contentType != "" {
		headers["Content-Type"] = contentType
	} else if ctx.Meta.Stream {
		headers["Content-Type"] = "text/event-stream"
	} else {
		headers["Content-Type"] = "application/json"
	}

	if ctx.Meta.Stream {
		return contracts.Decision{
			Action:  contracts.ActionRespond,
			Status:  response.StatusCode,
			Headers: headers,
			Stream:  response.Body,
		}, nil
	}

	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, s.config.MaxResponseBytes+1))
	if err != nil {
		return contracts.Decision{}, contracts.Errorf(http.StatusBadGateway, "UPSTREAM_READ_FAILED", "读取上游响应失败")
	}
	if int64(len(payload)) > s.config.MaxResponseBytes {
		return contracts.Decision{}, contracts.Errorf(http.StatusBadGateway, "UPSTREAM_RESPONSE_TOO_LARGE", "上游响应超过大小上限")
	}
	return contracts.Decision{
		Action:  contracts.ActionRespond,
		Status:  response.StatusCode,
		Headers: headers,
		Body:    payload,
	}, nil
}

func (s *Stage) networkError(ctx *contracts.Ctx, err error, token string) error {
	if ctx.Context != nil && ctx.Context.Err() != nil {
		if errors.Is(ctx.Context.Err(), context.DeadlineExceeded) {
			return retryableError(http.StatusGatewayTimeout, "UPSTREAM_TIMEOUT", "上游请求超时")
		}
		return contracts.Errorf(499, "CLIENT_CANCELED", "客户端已断开")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return retryableError(http.StatusGatewayTimeout, "UPSTREAM_TIMEOUT", "上游请求超时")
	}
	var timeout interface{ Timeout() bool }
	if errors.As(err, &timeout) && timeout.Timeout() {
		return retryableError(http.StatusGatewayTimeout, "UPSTREAM_TIMEOUT", "上游请求超时")
	}
	message := sanitize(err.Error(), token)
	return retryableError(http.StatusBadGateway, "UPSTREAM_UNAVAILABLE", "上游不可用：%s", truncate(message, 512))
}

func (s *Stage) upstreamError(response *http.Response, token string) error {
	payload, _ := io.ReadAll(io.LimitReader(response.Body, s.config.MaxErrorBytes))
	message := sanitize(upstreamMessage(payload), token)

	switch {
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		// 不把上游的认证错误正文透给客户端：它可能回显账号或令牌。
		return retryableError(http.StatusBadGateway, "UPSTREAM_AUTH_FAILED", "上游拒绝了该账号的凭据")
	case response.StatusCode == http.StatusTooManyRequests:
		return retryableError(http.StatusTooManyRequests, "UPSTREAM_RATE_LIMITED", "上游限流：%s", message)
	case response.StatusCode == http.StatusNotFound:
		return contracts.Errorf(http.StatusNotFound, "UPSTREAM_NOT_FOUND", "上游资源不存在")
	case response.StatusCode >= 500:
		return retryableError(http.StatusBadGateway, "UPSTREAM_ERROR", "上游错误：%s", message)
	case response.StatusCode >= 400:
		return contracts.Errorf(response.StatusCode, "UPSTREAM_INVALID_REQUEST", "上游拒绝了请求：%s", message)
	default:
		return contracts.Errorf(http.StatusBadGateway, "UPSTREAM_REJECTED", "上游返回了非预期状态 %d", response.StatusCode)
	}
}

func retryableError(status int, code, format string, args ...any) *contracts.StageError {
	return &contracts.StageError{
		Status:    status,
		Code:      code,
		Message:   fmt.Sprintf(format, args...),
		Retryable: true,
	}
}

func joinURL(baseURL, path string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("invalid base url")
	}
	trimmedPath := strings.TrimRight(parsed.Path, "/")
	if strings.HasSuffix(strings.ToLower(trimmedPath), strings.ToLower(path)) {
		parsed.Path = trimmedPath
	} else {
		parsed.Path = trimmedPath + path
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

// upstreamMessage 优先取 OpenAI 风格的 error.message，取不到再退回截断后的原文。
func upstreamMessage(payload []byte) string {
	var envelope struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(payload, &envelope); err == nil {
		if envelope.Error.Message != "" {
			return envelope.Error.Message
		}
		if envelope.Message != "" {
			return envelope.Message
		}
	}
	return truncate(strings.TrimSpace(string(payload)), 512)
}

func sanitize(text, token string) string {
	if token != "" {
		text = strings.ReplaceAll(text, token, "[redacted]")
	}
	return text
}

func truncate(text string, max int) string {
	if len(text) <= max {
		return text
	}
	return fmt.Sprintf("%s…（已截断）", text[:max])
}
