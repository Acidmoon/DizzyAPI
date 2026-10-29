// Package httpapi 是 LLM 请求的 HTTP 入口（§2.4）。
//
// 它只做三件事：
//   - 解析 OpenAI 兼容的 /v1/chat/completions 请求；
//   - 把请求装进 contracts.Ctx，交给 engine 执行；
//   - 把 engine 的 Decision（含流式 Stream）写回客户端。
//
// 它不选账号、不转发、不读秘密；账号候选来自 internal/accounts 的内存快照。
// /healthz 是运行期探针，/v1/models 列出对外模型名，二者都不暴露账号令牌或配置。
package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/engine"
	"github.com/Acidmoon/DizzyAPI/internal/usageprobe"
)

const (
	// DefaultMaxBodyBytes 是请求体上限（32 MiB）。
	DefaultMaxBodyBytes = int64(32 << 20)
	// DefaultStrategy 为空表示使用 Go 侧的默认策略组。
	DefaultStrategy = ""
)

// Authorizer 校验 LLM 入口的 Bearer key。它由 keyauth 实现，复用与 LLM 请求
// 完全一致的判定（动态快照 / 静态 key / 占位 / 空快照 fail-closed）。
//
// 定义在这里是为了让 httpapi 不 import keyauth 的实现包（AGENTS.md §2.3）：
// 组合根把 keyauth.Stage 作为这个接口传进来。
type Authorizer interface {
	Authorize(headers http.Header) (*contracts.APIKey, error)
}

// UsageProbe 从响应字节里提取 usage。它由 internal/usageprobe 实现；
// 在这里声明是为了让 httpapi 不依赖具体实现（与 Authorizer 同构）。
type UsageProbe interface {
	Extract(protocol contracts.Protocol, body []byte) (contracts.Usage, bool)
	Watch(protocol contracts.Protocol, r io.Reader) (io.Reader, func() (contracts.Usage, bool, string))
}

// Config 是 HTTP 入口的运行参数。
type Config struct {
	MaxBodyBytes int64
	Strategy     string
	// Authorizer 用于 GET /v1/models 的鉴权。为空时该路由 fail-closed（503）。
	Authorizer Authorizer
	// UsageSink 接收已完成的 LLM 请求用量；为空时不记录（也不影响现有行为）。
	UsageSink contracts.UsageSink
	// UsageProbe 从响应里提取 usage；为空时记录里的 token 全为 0。
	UsageProbe UsageProbe
	// RecordStreamUsage 为 true 时，openai-chat 流式请求会被注入
	// stream_options.include_usage=true（响应体才带 usage）。false 时一个字节都不改。
	RecordStreamUsage bool
	// TrustedProxyHops 是 X-Forwarded-For 从右往左的第几跳可信代理；
	// <=0 按 1 处理。
	TrustedProxyHops int
}

// Server 持有 HTTP handler 的依赖。构造后只读，可被并发使用。
type Server struct {
	engine     *engine.Engine
	accounts   *accounts.Cache
	logger     *slog.Logger
	config     Config
	authorizer Authorizer
	usageSink  contracts.UsageSink
	usageProbe UsageProbe
	started    time.Time
	requests   atomic.Uint64
}

// New 构造 HTTP handler。
func New(eng *engine.Engine, cache *accounts.Cache, logger *slog.Logger, cfg Config) (*Server, error) {
	if eng == nil {
		return nil, errors.New("httpapi: engine 不能为空")
	}
	if cache == nil {
		return nil, errors.New("httpapi: 账号缓存不能为空")
	}
	if logger == nil {
		logger = slog.Default()
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = DefaultMaxBodyBytes
	}
	return &Server{
		engine:     eng,
		accounts:   cache,
		logger:     logger,
		config:     cfg,
		authorizer: cfg.Authorizer,
		usageSink:  cfg.UsageSink,
		usageProbe: cfg.UsageProbe,
		started:    time.Now().UTC(),
	}, nil
}

// Handler 返回带路由的 http.Handler。
//
// 每个 LLM 路由对应一个客户端协议：入口按路由写入 ctx.ClientProtocol，
// 协议转换阶段据此选择 codec。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/v1/models", s.handleModels)
	mux.HandleFunc("/v1/chat/completions", s.llmHandler(contracts.ProtocolOpenAIChat, "/v1/chat/completions"))
	mux.HandleFunc("/v1/responses", s.llmHandler(contracts.ProtocolOpenAIResponses, "/v1/responses"))
	mux.HandleFunc("/v1/messages", s.llmHandler(contracts.ProtocolAnthropic, "/v1/messages"))
	// Gemini 的模型名在路径里（/v1beta/models/{model}:generateContent），
	// ServeMux 的通配符不支持「通配 + 字面后缀」，所以这一段自己解析路径。
	mux.HandleFunc("/v1beta/models/", s.handleGemini)
	return s.recover(mux)
}

// handleModels 返回当前可用的对外模型名（OpenAI /v1/models 形状）。
//
// 鉴权与 LLM 入口完全一致（复用 Authorizer，即 keyauth 的同一套判定）。
// 只暴露模型名，绝不泄漏账号 id、baseUrl、令牌或账号数量。
func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeErrorFor(w, contracts.Protocol(""), http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "只支持 GET /v1/models")
		return
	}
	if s.authorizer == nil {
		// 没装配鉴权器就不放行（fail-closed），而不是默默暴露模型名。
		writeErrorFor(w, contracts.Protocol(""), http.StatusServiceUnavailable, "MODELS_UNAVAILABLE", "模型列表暂不可用")
		return
	}
	if _, err := s.authorizer.Authorize(r.Header); err != nil {
		writeAuthorizeError(w, err)
		return
	}

	models := s.accounts.Models()
	created := s.started.Unix()
	data := make([]map[string]any, 0, len(models))
	for _, model := range models {
		data = append(data, map[string]any{
			"id":       model,
			"object":   "model",
			"created":  created,
			"owned_by": "dizzyapi",
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"object": "list",
		"data":   data,
	})
}

// writeAuthorizeError 把 Authorizer 返回的错误按入口协议形状渲染。
// keyauth 返回的是 *contracts.StageError；未知错误一律 500，不伪装成 401。
func writeAuthorizeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	code := "GATEWAY_INTERNAL"
	message := "网关内部错误"

	var stageErr *contracts.StageError
	var publicErr contracts.PublicError
	switch {
	case errors.As(err, &stageErr):
		status, code, message = stageErr.Status, stageErr.Code, stageErr.Message
	case errors.As(err, &publicErr):
		status, code, message = publicErr.HTTPStatus(), publicErr.ErrorCode(), publicErr.PublicMessage()
	}
	if status < 400 || status > 599 {
		status = http.StatusInternalServerError
	}
	writeErrorFor(w, contracts.Protocol(""), status, code, message)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeErrorFor(w, contracts.Protocol(""), http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "只支持 GET /healthz")
		return
	}
	state := s.accounts.State()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"accounts":  state.Accounts,
		"revision":  state.Revision,
		"requests":  s.requests.Load(),
		"uptimeSec": int64(time.Since(s.started).Seconds()),
		"startedAt": s.started.Format(time.RFC3339),
	})
}

// llmHandler 构造某个客户端协议的路由处理器。三个协议共用同一套
// 「读体 → 探针 → 构造 Ctx → 交给 engine → 写响应 → 记录用量」流程，只是协议不同。
func (s *Server) llmHandler(protocol contracts.Protocol, path string) http.HandlerFunc {
	return s.llmRouteHandler(llmRoute{protocol: protocol, path: path})
}

// llmRoute 描述一个 LLM 入口路由。
type llmRoute struct {
	protocol contracts.Protocol
	// path 是错误消息里用的路径说明。
	path string
	// modelFromPath 为真时模型名从 URL 路径里取（Gemini：模型在路径里，
	// body 里没有 model 字段）。
	modelFromPath bool
	// streamFromPath 为真时是否流式由路径后缀决定（Gemini 的
	// :streamGenerateContent）。
	streamFromPath bool
}

// llmRouteHandler 是四个协议共用的入口处理流程。
func (s *Server) llmRouteHandler(route llmRoute) http.HandlerFunc {
	protocol := route.protocol
	path := route.path
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorFor(w, protocol, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "只支持 POST "+path)
			return
		}

		body, err := s.readBody(w, r, protocol)
		if err != nil {
			return
		}
		var envelope struct {
			Model  string `json:"model"`
			Stream bool   `json:"stream"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			writeErrorFor(w, protocol, http.StatusBadRequest, "INVALID_REQUEST", "请求体必须是合法 JSON")
			return
		}
		model := envelope.Model
		stream := envelope.Stream
		if route.modelFromPath {
			// Gemini：模型名与流式标记都在路径里，body 里没有这两个字段。
			parsed, ok := parseGeminiModelPath(r.URL.EscapedPath())
			if !ok {
				writeErrorFor(w, protocol, http.StatusNotFound, "NOT_FOUND", "不支持的 Gemini 路径")
				return
			}
			model = parsed.model
			if route.streamFromPath {
				stream = parsed.stream
			}
		}
		if model == "" {
			writeErrorFor(w, protocol, http.StatusBadRequest, "INVALID_REQUEST", "缺少 model")
			return
		}
		// openai-chat 流式请求默认不带 usage。只有显式开启时才改写请求体：
		// 关闭时 body 必须与客户端发来的字节逐字节相同（回归约束）。
		if s.config.RecordStreamUsage && protocol == contracts.ProtocolOpenAIChat && stream {
			body = injectStreamUsage(body)
		}

		requestID := s.nextRequestID()
		ctx := &contracts.Ctx{
			Context: r.Context(),
			ReqID:   requestID,
			Meta: contracts.RequestMeta{
				Model:    model,
				Stream:   stream,
				Strategy: s.config.Strategy,
			},
			Headers:           r.Header.Clone(),
			Body:              contracts.BytesBody(body),
			AccountCandidates: s.accounts.Candidates(),
			ClientProtocol:    protocol,
			ClientIP:          s.clientIP(r),
		}

		// 并发槽位必须等响应（含整个流）真正写完才释放；engine 在失败转移 / panic
		// 出口会调用同一个 release，所以它是幂等的，这里重复调用安全。
		defer func() {
			if ctx.ReleaseInFlight != nil {
				ctx.ReleaseInFlight()
			}
		}()

		started := time.Now()
		decision := s.engine.Run(ctx)
		if r.Context().Err() != nil {
			// 客户端已经断开；不再写响应，但仍要留下一条「未完成」的用量记录。
			s.closeStream(decision)
			s.recordUsage(ctx, decision, started, usageSample{})
			return
		}
		status := decision.Status
		if status == 0 {
			status = http.StatusOK
		}

		// 流式：在字节透传的同时喂给 probe；非流式：直接从最终响应体提取。
		var tracked *trackedReadCloser
		var settle func() (contracts.Usage, bool, string)
		if decision.Stream != nil {
			tracked = &trackedReadCloser{Reader: decision.Stream, Closer: decision.Stream}
			if s.usageProbe != nil {
				wrapped, settleFn := s.usageProbe.Watch(ctx.ClientProtocol, decision.Stream)
				tracked.Reader = wrapped
				settle = settleFn
			}
			decision.Stream = tracked
		}

		s.writeDecision(w, decision)

		sample := usageSample{}
		switch {
		case settle != nil:
			sample.usage, sample.present, sample.errorCode = settle()
			sample.complete = tracked.eof.Load()
		case decision.Stream == nil:
			// 非流式响应已经整段读完（无论是否带 usage），完整性没有疑问。
			sample.complete = true
			if s.usageProbe != nil {
				sample.usage, sample.present = s.usageProbe.Extract(ctx.ClientProtocol, decision.Body)
			}
		}
		tokens := s.recordUsage(ctx, decision, started, sample)

		s.logger.Info("LLM 请求完成",
			"reqId", requestID,
			"model", model,
			"protocol", string(protocol),
			"stream", stream,
			"status", status,
			"durationMs", time.Since(started).Milliseconds(),
			// Attempts 记录的是 dispatch 阶段执行次数（一次请求每个阶段一条），
			// 日志与用量都要的是「试了几个账号」，所以按 AccountID 去重。
			"attempts", attemptedAccounts(ctx.Attempts),
			"tokens", tokens,
		)
	}
}

// usageSample 是一次请求的用量采集结果。
type usageSample struct {
	usage     contracts.Usage
	present   bool
	complete  bool
	errorCode string
}

// trackedReadCloser 记录流是否读到 EOF。copyStream 因客户端断开提前返回时
// eof 为 false，用量记录据此把 UsageComplete 写成 false。
type trackedReadCloser struct {
	io.Reader
	io.Closer
	eof atomic.Bool
}

func (t *trackedReadCloser) Read(p []byte) (int, error) {
	read, err := t.Reader.Read(p)
	if errors.Is(err, io.EOF) {
		t.eof.Store(true)
	}
	return read, err
}

// recordUsage 组装并提交一条用量记录，返回 totalTokens（仅用于日志）。
//
// ctx.Key 为空说明请求没有通过 key-auth（401 / 缺失 key），按约定不记录：
// 未鉴权的调用不属于任何用户，也不是可计费事实。
func (s *Server) recordUsage(ctx *contracts.Ctx, decision contracts.Decision, started time.Time, sample usageSample) int {
	if s.usageSink == nil || ctx == nil || ctx.Key == nil {
		return 0
	}

	upstream := s.upstreamProtocol(ctx)
	usage := usageprobe.Normalize(sample.usage, upstream)
	errorCode := ctx.ErrorCode
	if errorCode == "" {
		errorCode = sample.errorCode
	}
	status := decision.Status
	if status == 0 {
		status = http.StatusOK
	}

	profile := ctx.Profile
	if profile == "" {
		profile = ctx.Key.Profile
	}
	keyID := ctx.Key.KeyID
	if keyID == "" {
		keyID = ctx.Key.ID
	}
	accountID := ""
	if ctx.AccountRoute != nil && ctx.AccountRoute.Picked != nil {
		accountID = ctx.AccountRoute.Picked.AccountID
	}

	record := contracts.UsageRecord{
		RequestID:        ctx.ReqID,
		UserID:           ctx.Key.UserID,
		KeyID:            keyID,
		KeyName:          ctx.Key.Name,
		Profile:          profile,
		AccountID:        accountID,
		Model:            ctx.Meta.Model,
		UpstreamModel:    ctx.UpstreamModel,
		Protocol:         ctx.ClientProtocol,
		UpstreamProtocol: upstream,
		Stream:           ctx.Meta.Stream,
		Status:           status,
		ErrorCode:        errorCode,
		InputTokens:      usage.InputTokens,
		OutputTokens:     usage.OutputTokens,
		CacheReadTokens:  usage.CacheReadInputTokens,
		CacheWriteTokens: usage.CacheCreationInputTokens,
		ReasoningTokens:  usage.ReasoningTokens,
		TotalTokens:      usageprobe.TotalTokens(usage),
		UsagePresent:     sample.present,
		UsageComplete:    sample.complete,
		DurationMs:       time.Since(started).Milliseconds(),
		ClientIP:         ctx.ClientIP,
		Attempts:         attemptedAccounts(ctx.Attempts),
		StartedAt:        started.UTC(),
	}
	s.usageSink.Append(record)
	return record.TotalTokens
}

// attemptedAccounts 数的是「被试过的账号数」，不是 dispatch 阶段的执行次数。
//
// engine 在每个 attempt 里按阶段各追加一条 AccountAttempt（转换 / 映射 / 转发），
// 直接取 len 会在装配了 N 个 dispatch 阶段时把 1 个账号记成 N 次。
func attemptedAccounts(attempts []contracts.AccountAttempt) int {
	if len(attempts) == 0 {
		return 0
	}
	seen := make(map[string]struct{}, len(attempts))
	for _, attempt := range attempts {
		if attempt.AccountID != "" {
			seen[attempt.AccountID] = struct{}{}
		}
	}
	if len(seen) == 0 {
		return 1
	}
	return len(seen)
}

// upstreamProtocol 依次取：转换后的上游协议 → 选中账号声明的协议 → 客户端协议。
func (s *Server) upstreamProtocol(ctx *contracts.Ctx) contracts.Protocol {
	if ctx.Upstream != nil && ctx.Upstream.Protocol != "" {
		return ctx.Upstream.Protocol
	}
	if ctx.AccountRoute != nil && ctx.AccountRoute.Picked != nil {
		if credential, ok := s.accounts.Credential(ctx.AccountRoute.Picked.AccountID); ok {
			if protocol := contracts.Protocol(credential.Protocol); protocol != "" {
				return protocol
			}
		}
	}
	return ctx.ClientProtocol
}

// clientIP 解析客户端地址：X-Forwarded-For 右起第 hops 跳 → X-Real-IP → RemoteAddr。
//
// 取值是不可信输入：长度上限 64，只允许字母 / 数字 / 点 / 冒号；不合法就换下一个来源。
func (s *Server) clientIP(r *http.Request) string {
	hops := s.config.TrustedProxyHops
	if hops <= 0 {
		hops = 1
	}
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		candidates := make([]string, 0, len(parts))
		for _, part := range parts {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				candidates = append(candidates, trimmed)
			}
		}
		if len(candidates) >= hops {
			if ip := sanitizeIP(candidates[len(candidates)-hops]); ip != "" {
				return ip
			}
		}
	}
	if ip := sanitizeIP(r.Header.Get("X-Real-IP")); ip != "" {
		return ip
	}
	host := r.RemoteAddr
	if parsed, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		host = parsed
	}
	return sanitizeIP(host)
}

func sanitizeIP(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(value); err == nil {
		value = host
	}
	value = strings.TrimPrefix(value, "[")
	value = strings.TrimSuffix(value, "]")
	if value == "" || len(value) > 64 {
		return ""
	}
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9',
			r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r == '.', r == ':':
		default:
			return ""
		}
	}
	return value
}

// injectStreamUsage 给 openai-chat 流式请求补 stream_options.include_usage=true。
//
// 只在缺失时改写；已经显式给出 include_usage（包括 false）时不动。body 不是对象、
// stream 不是 true、或 stream_options 不是对象时原样返回——绝不为了采集破坏请求。
func injectStreamUsage(body []byte) []byte {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil || fields == nil {
		return body
	}
	var stream bool
	rawStream, exists := fields["stream"]
	if !exists || json.Unmarshal(rawStream, &stream) != nil || !stream {
		return body
	}
	var options map[string]json.RawMessage
	if rawOptions, exists := fields["stream_options"]; exists {
		if err := json.Unmarshal(rawOptions, &options); err != nil {
			return body
		}
	}
	if options == nil {
		options = map[string]json.RawMessage{}
	}
	if _, exists := options["include_usage"]; exists {
		return body
	}
	options["include_usage"] = json.RawMessage("true")
	encodedOptions, err := marshalNoEscape(options)
	if err != nil {
		return body
	}
	fields["stream_options"] = encodedOptions
	encoded, err := marshalNoEscape(fields)
	if err != nil {
		return body
	}
	return encoded
}

// marshalNoEscape 序列化时不转义 < > &，让未改动的字段值保持原样。
func marshalNoEscape(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}

func (s *Server) readBody(w http.ResponseWriter, r *http.Request, protocol contracts.Protocol) ([]byte, error) {
	if r.ContentLength > s.config.MaxBodyBytes {
		writeErrorFor(w, protocol, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "请求体超过大小上限")
		return nil, errors.New("body too large")
	}
	reader := http.MaxBytesReader(w, r.Body, s.config.MaxBodyBytes)
	body, err := io.ReadAll(reader)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeErrorFor(w, protocol, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "请求体超过大小上限")
		} else {
			writeErrorFor(w, protocol, http.StatusBadRequest, "REQUEST_BODY_INVALID", "读取请求体失败")
		}
		return nil, err
	}
	return body, nil
}

func (s *Server) writeDecision(w http.ResponseWriter, decision contracts.Decision) {
	if decision.Stream != nil {
		defer decision.Stream.Close()
	}
	for name, value := range decision.Headers {
		w.Header().Set(name, value)
	}
	status := decision.Status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)

	if decision.Stream != nil {
		s.copyStream(w, decision.Stream)
		return
	}
	if len(decision.Body) > 0 {
		_, _ = w.Write(decision.Body)
	}
}

// copyStream 原样透传 SSE / 上游字节，并尽量每块 flush，
// 让首字延迟不被网关缓冲放大。
func (s *Server) copyStream(w http.ResponseWriter, stream io.Reader) {
	flusher, _ := w.(http.Flusher)
	buffer := make([]byte, 32<<10)
	for {
		read, err := stream.Read(buffer)
		if read > 0 {
			if _, writeErr := w.Write(buffer[:read]); writeErr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				s.logger.Debug("上游流读取结束", "error", err)
			}
			return
		}
	}
}

func (s *Server) closeStream(decision contracts.Decision) {
	if decision.Stream != nil {
		_ = decision.Stream.Close()
	}
}

func (s *Server) nextRequestID() string {
	return fmt.Sprintf("req-%d-%d", time.Now().UnixNano(), s.requests.Add(1))
}

func (s *Server) recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				s.logger.Error("HTTP 入口 panic", "error", fmt.Sprintf("%v", recovered))
				writeErrorFor(w, protocolForPath(r.URL.Path), http.StatusInternalServerError, "GATEWAY_INTERNAL", "网关内部错误")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// protocolForPath 由路由路径推断客户端协议（仅用于 panic 兜底这类无 Ctx 的场景）。
func protocolForPath(path string) contracts.Protocol {
	switch path {
	case "/v1/responses":
		return contracts.ProtocolOpenAIResponses
	case "/v1/messages":
		return contracts.ProtocolAnthropic
	case "/v1/chat/completions":
		return contracts.ProtocolOpenAIChat
	default:
		if strings.HasPrefix(path, geminiPathPrefix) {
			return contracts.ProtocolGemini
		}
		return contracts.Protocol("")
	}
}

// writeErrorFor 按协议渲染并写出错误体。
//
// 空协议与 openai-* 走 OpenAI 兼容形状（与今天逐字节一致）；
// anthropic 走 Anthropic 错误形状。状态码与错误码语义由调用方决定。
func writeErrorFor(w http.ResponseWriter, protocol contracts.Protocol, status int, code, message string) {
	writeRawJSON(w, status, contracts.RenderError(protocol, status, code, message))
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	payload, err := json.Marshal(value)
	if err != nil {
		payload = []byte(`{"error":{"message":"网关内部错误","type":"server_error","code":"GATEWAY_INTERNAL"}}`)
		status = http.StatusInternalServerError
	}
	writeRawJSON(w, status, payload)
}

// writeRawJSON 写出已经序列化好的 JSON 体（错误体由 contracts.RenderError 产出）。
func writeRawJSON(w http.ResponseWriter, status int, payload []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}
