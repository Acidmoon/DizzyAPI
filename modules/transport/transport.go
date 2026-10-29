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

// AuthStyle 是上游鉴权头的写法。URL 与鉴权头本来就是 transport 的职责。
type AuthStyle uint8

const (
	// AuthBearer 写 Authorization: Bearer <token>（OpenAI 兼容）。
	AuthBearer AuthStyle = iota
	// AuthXAPIKey 写 x-api-key: <token>（Anthropic）。
	AuthXAPIKey
	// AuthXGoogAPIKey 写 x-goog-api-key: <token>（Google Gemini）。
	AuthXGoogAPIKey
)

// modelPlaceholder 是方言路径里的模型名占位符。
const modelPlaceholder = "{model}"

// Dialect 是一种上游协议的方言：路径后缀、鉴权方式与固定附加头。
//
// 路径约定：baseUrl 自带版本前缀（openai 默认 https://api.openai.com/v1），
// 这里的 Path 是版本之后的后缀（如 /chat/completions、/messages）。
//
// Path 里可以带 `{model}` 占位（Gemini 的模型名在路径里）：
// 渲染时用请求的模型名替换它，并按路径段做转义。
type Dialect struct {
	Path         string
	Auth         AuthStyle
	ExtraHeaders map[string]string
	// StreamPath 是流式请求用的路径（空 = 与 Path 相同）。
	//
	// Gemini 的流式端点是另一个方法名（:streamGenerateContent），路径随流式
	// 变化时用它。
	StreamPath string
	// StreamQuery 是流式请求追加的查询串（不含 ?）。Gemini 用 alt=sse 决定
	// 返回 SSE 还是 JSON 数组。
	StreamQuery string
}

// DefaultDialects 是内置方言表。调用方可在 Config.Dialects 覆盖单个协议。
var DefaultDialects = map[contracts.Protocol]Dialect{
	contracts.ProtocolOpenAIChat: {
		Path: "/chat/completions",
		Auth: AuthBearer,
	},
	contracts.ProtocolOpenAIResponses: {
		Path: "/responses",
		Auth: AuthBearer,
	},
	contracts.ProtocolAnthropic: {
		Path: "/messages",
		Auth: AuthXAPIKey,
		ExtraHeaders: map[string]string{
			"anthropic-version": "2023-06-01",
		},
	},
	// Gemini：模型名在路径里（models/{model}:generateContent），鉴权用
	// `x-goog-api-key` 头（官方 REST 约定，密钥只在 query 里也常见，但 query
	// 会进日志与代理记录，头更安全）。
	contracts.ProtocolGemini: {
		Path:        "/models/{model}:generateContent",
		StreamPath:  "/models/{model}:streamGenerateContent",
		StreamQuery: "alt=sse",
		Auth:        AuthXGoogAPIKey,
	},
}

// LimitRecorder 是「上游限流 / 额度耗尽」的回报面。
//
// 由组合根注入（internal/accountruntime），transport 只做事实回报：
// 该账号在接下来一段时间不应再被选中。可为 nil（不记录冷却）。
type LimitRecorder interface {
	RecordLimit(accountID string)
}

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
	// Path 是协议未知时的回退路径（追加在账号 baseUrl 后面）。
	Path string
	// Dialects 按协议覆盖方言表；为空（或某协议缺失）时用 DefaultDialects。
	Dialects map[contracts.Protocol]Dialect
	// UserAgent 为空时使用 gatewayd/0.1。
	UserAgent string
	// LimitRecorder 在 429 / 额度耗尽时记录短期冷却；nil = 不记录。
	LimitRecorder LimitRecorder
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
	c.Dialects = mergedDialects(c.Dialects)
	return c
}

// mergedDialects 在内置方言表之上叠加调用方覆盖，返回一份新表。
func mergedDialects(overrides map[contracts.Protocol]Dialect) map[contracts.Protocol]Dialect {
	merged := make(map[contracts.Protocol]Dialect, len(DefaultDialects)+len(overrides))
	for protocol, dialect := range DefaultDialects {
		merged[protocol] = dialect
	}
	for protocol, dialect := range overrides {
		if dialect.Path == "" {
			continue
		}
		if !strings.HasPrefix(dialect.Path, "/") {
			dialect.Path = "/" + dialect.Path
		}
		merged[protocol] = dialect
	}
	return merged
}

// Stage 是 dispatch 相位的 HTTP 派发阶段。
type Stage struct {
	config     Config
	source     contracts.CredentialSource
	transcoder contracts.ResponseTranscoder
	client     *http.Client
}

// New 构造阶段。source 是实现账号快照缓存的任意对象；transcoder 可为 nil
// （无转换时上游响应原样透传）。
func New(cfg Config, source contracts.CredentialSource, transcoder contracts.ResponseTranscoder) (*Stage, error) {
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
	return &Stage{config: cfg, source: source, transcoder: transcoder, client: client}, nil
}

// Register 把 transport 阶段挂到组合根上。
func Register(reg *contracts.Registry, cfg Config, source contracts.CredentialSource, transcoder contracts.ResponseTranscoder) (*Stage, error) {
	stage, err := New(cfg, source, transcoder)
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

	// 请求体：转换阶段写过 Upstream 就用转换后的字节；否则用客户端原始字节。
	body, err := requestBody(ctx)
	if err != nil {
		return contracts.Decision{}, err
	}

	// 上游协议决定方言（路径 + 鉴权）。转换阶段写的协议优先；
	// 否则用账号声明的协议；再否则回退到 Config.Path + Bearer（今天的行为）。
	upstreamProtocol := contracts.Protocol(credential.Protocol)
	if ctx.Upstream != nil {
		upstreamProtocol = ctx.Upstream.Protocol
	}
	dialect, known := s.config.Dialects[upstreamProtocol]
	if !known {
		dialect = Dialect{Path: s.config.Path, Auth: AuthBearer}
	}

	target, err := joinURL(credential.BaseURL, dialectPath(dialect, upstreamModelOf(ctx)))
	if err != nil {
		return contracts.Decision{}, contracts.Errorf(http.StatusBadGateway, "UPSTREAM_URL_INVALID", "上游地址不合法")
	}
	if ctx.Meta.Stream {
		target = applyStreamTarget(target, dialect, upstreamModelOf(ctx))
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
	applyAuth(request, dialect, credential.AccessToken)

	response, err := s.client.Do(request)
	if err != nil {
		return contracts.Decision{}, s.networkError(ctx, err, credential.AccessToken)
	}

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		payload, _ := io.ReadAll(io.LimitReader(response.Body, s.config.MaxErrorBytes))
		// 429 与明确的额度耗尽：该账号短期不可用。回报给运行时记冷却（纯内存，
		// 不落盘、不回写 TS），并把错误标成可重试，让 engine 换下一个账号。
		limitHit := shouldCoolDown(response.StatusCode, payload)
		if limitHit && s.config.LimitRecorder != nil {
			s.config.LimitRecorder.RecordLimit(accountID)
		}
		return contracts.Decision{}, upstreamError(response.StatusCode, payload, credential.AccessToken, limitHit)
	}

	headers := map[string]string{}
	if contentType := response.Header.Get("Content-Type"); contentType != "" {
		headers["Content-Type"] = contentType
	} else if ctx.Meta.Stream {
		headers["Content-Type"] = "text/event-stream"
	} else {
		headers["Content-Type"] = "application/json"
	}

	// 需要转换时：把上游响应交给 transcoder，由它返回客户端协议的响应。
	transcode := ctx.Upstream != nil && s.transcoder != nil

	if ctx.Meta.Stream {
		if transcode {
			// 成功时 transcoder 接管并关闭 response.Body；失败时由这里关闭。
			decision, transcodeErr := s.transcoder.TranscodeResponse(ctx, contracts.UpstreamResponse{
				Status:  response.StatusCode,
				Headers: headers,
				Stream:  response.Body,
			})
			if transcodeErr != nil {
				response.Body.Close()
			}
			return decision, transcodeErr
		}
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
	if transcode {
		return s.transcoder.TranscodeResponse(ctx, contracts.UpstreamResponse{
			Status:  response.StatusCode,
			Headers: headers,
			Body:    payload,
		})
	}
	return contracts.Decision{
		Action:  contracts.ActionRespond,
		Status:  response.StatusCode,
		Headers: headers,
		Body:    payload,
	}, nil
}

// requestBody 选择要发给上游的字节，优先级：
// 协议转换结果（Upstream）> 模型映射结果（MappedBody）> 客户端原始字节（Body）。
func requestBody(ctx *contracts.Ctx) ([]byte, error) {
	if ctx.Upstream != nil {
		return ctx.Upstream.Body, nil
	}
	if ctx.MappedBody != nil {
		return ctx.MappedBody, nil
	}
	if ctx.Body == nil {
		return nil, contracts.Errorf(http.StatusBadRequest, "REQUEST_BODY_REQUIRED", "请求体缺失")
	}
	body, err := ctx.Body.Bytes()
	if err != nil {
		return nil, contracts.Errorf(http.StatusBadRequest, "REQUEST_BODY_INVALID", "请求体读取失败")
	}
	return body, nil
}

// applyAuth 按方言写鉴权头。客户端的 Authorization 永不转发。
func applyAuth(request *http.Request, dialect Dialect, token string) {
	switch dialect.Auth {
	case AuthXAPIKey:
		request.Header.Set("x-api-key", token)
	case AuthXGoogAPIKey:
		request.Header.Set("x-goog-api-key", token)
	default:
		request.Header.Set("Authorization", "Bearer "+token)
	}
	for name, value := range dialect.ExtraHeaders {
		if value == "" {
			continue
		}
		request.Header.Set(name, value)
	}
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

func upstreamError(status int, payload []byte, token string, limitHit bool) error {
	message := sanitize(upstreamMessage(payload), token)

	// 限流 / 额度耗尽：都按「可重试 + 429」渲染，让 engine 换账号，
	// 客户端看到的是统一的「上游限流」，不会拿到账号级细节。
	if limitHit {
		if status == http.StatusTooManyRequests {
			return retryableError(http.StatusTooManyRequests, "UPSTREAM_RATE_LIMITED", "上游限流：%s", message)
		}
		return retryableError(http.StatusTooManyRequests, "UPSTREAM_QUOTA_EXHAUSTED", "上游账号额度不足：%s", message)
	}

	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		// 不把上游的认证错误正文透给客户端：它可能回显账号或令牌。
		return retryableError(http.StatusBadGateway, "UPSTREAM_AUTH_FAILED", "上游拒绝了该账号的凭据")
	case status == http.StatusNotFound:
		return contracts.Errorf(http.StatusNotFound, "UPSTREAM_NOT_FOUND", "上游资源不存在")
	case status >= 500:
		return retryableError(http.StatusBadGateway, "UPSTREAM_ERROR", "上游错误：%s", message)
	case status >= 400:
		return contracts.Errorf(status, "UPSTREAM_INVALID_REQUEST", "上游拒绝了请求：%s", message)
	default:
		return contracts.Errorf(http.StatusBadGateway, "UPSTREAM_REJECTED", "上游返回了非预期状态 %d", status)
	}
}

// quotaMarkers 是上游「额度耗尽」错误正文里的已知标记（小写匹配）。
//
// 各家写法不同（OpenAI 的 insufficient_quota、Anthropic 的 credit balance 等），
// 这里只做保守识别：命中才冷却，认不出来就按普通错误处理（fail-open 到换账号，
// 不会误伤正常账号）。
var quotaMarkers = []string{
	"insufficient_quota",
	"quota_exceeded",
	"exceeded your current quota",
	"billing_hard_limit",
	"credit balance is too low",
	"余额不足",
	"额度不足",
	"额度已用尽",
}

// shouldCoolDown 判断这次上游失败是否意味着「该账号短期不可用」：
// 429 一律冷却；402（Payment Required）与正文命中额度标记的 400/403 也冷却。
func shouldCoolDown(status int, payload []byte) bool {
	if status == http.StatusTooManyRequests || status == http.StatusPaymentRequired {
		return true
	}
	if status != http.StatusBadRequest && status != http.StatusForbidden {
		return false
	}
	text := strings.ToLower(string(payload))
	for _, marker := range quotaMarkers {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
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

// upstreamModelOf 返回要发给上游的模型名。
//
// 有模型映射时用映射后的名字（Ctx.UpstreamModel，由模型映射阶段写入），
// 否则用客户端请求的模型名。Gemini 的模型名在路径里，靠它拼 URL。
func upstreamModelOf(ctx *contracts.Ctx) string {
	if ctx == nil {
		return ""
	}
	if ctx.UpstreamModel != "" {
		return ctx.UpstreamModel
	}
	return ctx.Meta.Model
}

// dialectPath 渲染方言路径：把 `{model}` 占位换成请求的模型名。
//
// Gemini 的模型名在路径里（models/{model}:generateContent）。模型名来自客户端，
// 所以必须转义（否则可能带 `/`、`:` 之类改变路径语义）；转义后仍保留 Gemini
// 需要的字面冒号（`generateContent` 前的那个分隔冒号不是占位的一部分）。
func dialectPath(dialect Dialect, model string) string {
	path := dialect.Path
	if !strings.Contains(path, modelPlaceholder) {
		return path
	}
	replaced := strings.ReplaceAll(path, modelPlaceholder, url.PathEscape(strings.TrimSpace(model)))
	// PathEscape 会把字面冒号也转义掉（%3A）；Gemini 的方法分隔冒号必须是字面量。
	replaced = strings.ReplaceAll(replaced, "%3A", ":")
	return replaced
}

// applyStreamTarget 把流式请求的 URL 换成方言的流式路径并补上查询串。
//
// Gemini 的流式端点是另一个方法名（:streamGenerateContent），且必须带
// alt=sse 才返回 SSE。其它协议的流式与非流式路径相同，查询串为空。
func applyStreamTarget(target string, dialect Dialect, model string) string {
	if dialect.StreamPath == "" && dialect.StreamQuery == "" {
		return target
	}
	parsed, err := url.Parse(target)
	if err != nil {
		return target
	}
	if dialect.StreamPath != "" {
		trimmed := strings.TrimRight(parsed.Path, "/")
		// 去掉非流式的方法后缀（:generateContent），再接上流式方法名。
		nonStream := dialectPath(Dialect{Path: dialect.Path}, model)
		trimmed = strings.TrimSuffix(trimmed, nonStream)
		parsed.Path = trimmed + dialectPath(Dialect{Path: dialect.StreamPath}, model)
	}
	if dialect.StreamQuery != "" {
		query := parsed.Query()
		for _, pair := range strings.Split(dialect.StreamQuery, "&") {
			name, value, _ := strings.Cut(pair, "=")
			if name == "" {
				continue
			}
			if query.Get(name) == "" {
				query.Set(name, value)
			}
		}
		parsed.RawQuery = query.Encode()
	}
	return parsed.String()
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
