package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
)

// Options 是控制桥的运行参数。
type Options struct {
	// MaxConnections 同时允许的连接数。
	MaxConnections int
	// MaxConcurrentHandlers 单个服务同时处理的请求数上限。
	MaxConcurrentHandlers int
	// Hello 会在每个连接建立时作为 event=hello 发给对端。
	Hello any
	// Logger 为空时使用 slog.Default()。
	Logger *slog.Logger
}

// Server 是控制桥的服务端。它只处理控制消息，不承载 LLM 请求。
type Server struct {
	network  string
	address  string
	listener net.Listener
	handler  Handler
	options  Options
	logger   *slog.Logger

	ctx    context.Context
	cancel context.CancelFunc

	closing atomic.Bool
	connsMu sync.Mutex
	conns   map[net.Conn]*connState

	wg   sync.WaitGroup
	sem  chan struct{}
	once sync.Once
}

type connState struct {
	conn    net.Conn
	writeMu sync.Mutex
}

// NewServer 立即监听。Unix 传输会先清理同名残留 socket；
// TCP 只允许回环地址，避免把控制面暴露到局域网。
func NewServer(network, address string, handler Handler, options Options) (*Server, error) {
	if handler == nil {
		return nil, errors.New("bridge: handler 不能为空")
	}
	if network != "unix" && network != "tcp" {
		return nil, fmt.Errorf("bridge: 不支持的传输 %q（只能是 unix 或 tcp）", network)
	}
	if options.MaxConnections <= 0 {
		options.MaxConnections = 8
	}
	if options.MaxConcurrentHandlers <= 0 {
		options.MaxConcurrentHandlers = 16
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}

	if network == "unix" {
		if err := prepareUnixSocket(address); err != nil {
			return nil, err
		}
	} else {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return nil, fmt.Errorf("bridge: TCP 地址 %q 不合法：%w", address, err)
		}
		if host != "127.0.0.1" && host != "::1" && host != "localhost" {
			return nil, fmt.Errorf("bridge: TCP 传输只允许回环地址，收到 %q", host)
		}
	}

	listener, err := net.Listen(network, address)
	if err != nil {
		return nil, fmt.Errorf("bridge: 监听 %s %s 失败：%w", network, address, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	return &Server{
		network:  network,
		address:  address,
		listener: listener,
		handler:  handler,
		options:  options,
		logger:   logger,
		ctx:      ctx,
		cancel:   cancel,
		conns:    make(map[net.Conn]*connState),
		sem:      make(chan struct{}, options.MaxConcurrentHandlers),
	}, nil
}

// Network 返回实际使用的传输名。
func (s *Server) Network() string {
	return s.network
}

// Address 返回实际监听地址（TCP :0 时是系统分配的端口）。
func (s *Server) Address() net.Addr {
	return s.listener.Addr()
}

// Serve 阻塞接受连接。关闭用 Close。
func (s *Server) Serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			if s.closing.Load() {
				return
			}
			s.logger.Warn("控制桥接受连接失败", "error", err)
			continue
		}
		state, ok := s.register(conn)
		if !ok {
			_ = conn.Close()
			continue
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.handleConn(state)
		}()
	}
}

func (s *Server) register(conn net.Conn) (*connState, bool) {
	s.connsMu.Lock()
	defer s.connsMu.Unlock()
	if s.closing.Load() || len(s.conns) >= s.options.MaxConnections {
		return nil, false
	}
	state := &connState{conn: conn}
	s.conns[conn] = state
	return state, true
}

func (s *Server) dropConn(state *connState) {
	s.connsMu.Lock()
	delete(s.conns, state.conn)
	s.connsMu.Unlock()
	_ = state.conn.Close()
}

func (s *Server) handleConn(state *connState) {
	defer s.dropConn(state)

	if s.options.Hello != nil {
		if err := s.write(state, Event{Type: "event", Event: "hello", Data: s.options.Hello}); err != nil {
			return
		}
	}

	for {
		payload, err := readFrame(state.conn)
		if err != nil {
			return
		}
		var request Request
		if err := json.Unmarshal(payload, &request); err != nil {
			_ = s.write(state, Response{
				Type: "response",
				OK:   false,
				Error: &ErrorBody{
					Code:    "BRIDGE_BAD_REQUEST",
					Message: "帧不是合法的 JSON 请求：" + err.Error(),
				},
			})
			continue
		}
		if request.Type != "request" {
			_ = s.write(state, Response{
				ID:   request.ID,
				Type: "response",
				OK:   false,
				Error: &ErrorBody{
					Code:    "BRIDGE_BAD_REQUEST",
					Message: "只接受 type=request 的控制消息",
				},
			})
			continue
		}

		select {
		case s.sem <- struct{}{}:
		case <-s.ctx.Done():
			return
		}
		s.wg.Add(1)
		go func(request Request) {
			defer s.wg.Done()
			defer func() { <-s.sem }()
			response := s.dispatch(request)
			if err := s.write(state, response); err != nil {
				_ = state.conn.Close()
			}
		}(request)
	}
}

func (s *Server) dispatch(request Request) Response {
	response := Response{ID: request.ID, Type: "response"}
	result, err := s.handler.Handle(s.ctx, request.Method, request.Params)
	if err != nil {
		code := "BRIDGE_INTERNAL"
		message := err.Error()
		var typed *Error
		if errors.As(err, &typed) {
			code = typed.Code
			message = typed.Message
		}
		response.Error = &ErrorBody{Code: code, Message: message}
		return response
	}
	response.OK = true
	response.Result = result
	return response
}

func (s *Server) write(state *connState, value any) error {
	state.writeMu.Lock()
	defer state.writeMu.Unlock()
	return writeFrame(state.conn, value)
}

// Close 停止监听、断开全部连接，并等待在途 handler 结束。
// 超时返回 ctx.Err()，但资源仍会被回收。
func (s *Server) Close(ctx context.Context) error {
	s.once.Do(func() {
		s.closing.Store(true)
		s.cancel()
		_ = s.listener.Close()
		if s.network == "unix" {
			// 先摘掉 socket 文件，防止关闭期间还有新连接进来；
			// 即使下面的等待超时，文件也不会残留。
			_ = os.Remove(s.address)
		}

		s.connsMu.Lock()
		for _, state := range s.conns {
			_ = state.conn.Close()
		}
		s.connsMu.Unlock()
	})

	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func prepareUnixSocket(path string) error {
	if path == "" {
		return errors.New("bridge: unix 传输必须提供 socket 路径")
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return fmt.Errorf("bridge: 创建 socket 目录失败：%w", err)
	}
	info, err := os.Stat(path)
	switch {
	case err == nil:
		if info.Mode()&os.ModeSocket == 0 {
			return fmt.Errorf("bridge: %s 已存在且不是 socket，拒绝覆盖", path)
		}
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("bridge: 清理残留 socket 失败：%w", err)
		}
	case os.IsNotExist(err):
	default:
		return fmt.Errorf("bridge: 检查 socket 路径失败：%w", err)
	}
	return nil
}
