// Package httpapi 是 LLM 请求的 HTTP 入口（§2.4）。
//
// 它只做三件事：
//   - 解析 OpenAI 兼容的 /v1/chat/completions 请求；
//   - 把请求装进 contracts.Ctx，交给 engine 执行；
//   - 把 engine 的 Decision（含流式 Stream）写回客户端。
//
// 它不选账号、不转发、不读秘密；账号候选来自 internal/accounts 的内存快照。
// /healthz 是运行期探针，不暴露账号令牌或配置。
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

// Config 是 HTTP 入口的运行参数。
type Config struct {
	MaxBodyBytes int64
	Strategy     string
}

// Server 持有 HTTP handler 的依赖。构造后只读，可被并发使用。
type Server struct {
	engine   *engine.Engine
	accounts *accounts.Cache
	logger   *slog.Logger
	config   Config
	started  time.Time
	requests atomic.Uint64
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
		engine:   eng,
		accounts: cache,
		logger:   logger,
		config:   cfg,
		started:  time.Now().UTC(),
	}, nil
}

// Handler 返回带路由的 http.Handler。
//
// 每个 LLM 路由对应一个客户端协议：入口按路由写入 ctx.ClientProtocol，
// 协议转换阶段据此选择 codec。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/v1/chat/completions", s.llmHandler(contracts.ProtocolOpenAIChat, "/v1/chat/completions"))
	mux.HandleFunc("/v1/responses", s.llmHandler(contracts.ProtocolOpenAIResponses, "/v1/responses"))
	mux.HandleFunc("/v1/messages", s.llmHandler(contracts.ProtocolAnthropic, "/v1/messages"))
	return s.recover(mux)
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
