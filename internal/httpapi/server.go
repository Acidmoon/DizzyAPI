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
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/engine"
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

// Config 是 HTTP 入口的运行参数。
type Config struct {
	MaxBodyBytes int64
	Strategy     string
	// Authorizer 用于 GET /v1/models 的鉴权。为空时该路由 fail-closed（503）。
	Authorizer Authorizer
}

// Server 持有 HTTP handler 的依赖。构造后只读，可被并发使用。
type Server struct {
	engine     *engine.Engine
	accounts   *accounts.Cache
	logger     *slog.Logger
	config     Config
	authorizer Authorizer
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
// 「读体 → 探针 → 构造 Ctx → 交给 engine」流程，只是协议不同。
func (s *Server) llmHandler(protocol contracts.Protocol, path string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorFor(w, protocol, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "只支持 POST "+path)
			return
		}

		body, err := s.readBody(w, r, protocol)
		if err != nil {
			return
		}
		var probe struct {
			Model  string `json:"model"`
			Stream bool   `json:"stream"`
		}
		if err := json.Unmarshal(body, &probe); err != nil {
			writeErrorFor(w, protocol, http.StatusBadRequest, "INVALID_REQUEST", "请求体必须是合法 JSON")
			return
		}
		if probe.Model == "" {
			writeErrorFor(w, protocol, http.StatusBadRequest, "INVALID_REQUEST", "缺少 model")
			return
		}

		requestID := s.nextRequestID()
		ctx := &contracts.Ctx{
			Context: r.Context(),
			ReqID:   requestID,
			Meta: contracts.RequestMeta{
				Model:    probe.Model,
				Stream:   probe.Stream,
				Strategy: s.config.Strategy,
			},
			Headers:           r.Header.Clone(),
			Body:              contracts.BytesBody(body),
			AccountCandidates: s.accounts.Candidates(),
			ClientProtocol:    protocol,
		}

		started := time.Now()
		decision := s.engine.Run(ctx)
		if r.Context().Err() != nil {
			// 客户端已经断开；不再写响应。
			s.closeStream(decision)
			return
		}
		status := decision.Status
		if status == 0 {
			status = http.StatusOK
		}
		s.writeDecision(w, decision)
		s.logger.Info("LLM 请求完成",
			"reqId", requestID,
			"model", probe.Model,
			"protocol", string(protocol),
			"stream", probe.Stream,
			"status", status,
			"durationMs", time.Since(started).Milliseconds(),
			"attempts", len(ctx.Attempts),
		)
	}
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
