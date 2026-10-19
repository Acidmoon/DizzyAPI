// gatewayd 是 Go 数据面的组合根（AGENTS.md D4）。
//
// 当前只有账号优先级模块与最小控制桥。它证明了两件事：
//   - 模块可以被注册表装配、可以按阶段调用；
//   - cordis（TS）可以通过控制桥拉起它、下发策略、查询排序、优雅停止。
//
// LLM 请求链路尚未实现：本进程现在不监听任何模型请求端口。
// 桥只承载控制消息，不承载 LLM 请求（AGENTS.md D3 / §2.3）。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/Acidmoon/DizzyAPI/internal/bridge"
	"github.com/Acidmoon/DizzyAPI/modules/accountpriority"
)

type handler struct {
	service  *accountpriority.Service
	logger   *slog.Logger
	shutdown chan struct{}
	stopOnce sync.Once
}

func (h *handler) Handle(_ context.Context, method string, params json.RawMessage) (any, error) {
	switch method {
	case bridge.MethodStatus:
		return h.service.Status(), nil

	case bridge.MethodListStrategies:
		return h.service.Strategies(), nil

	case bridge.MethodReplaceStrategies:
		var config accountpriority.Config
		if err := decodeParams(params, &config); err != nil {
			return nil, bridge.Errorf("BRIDGE_BAD_REQUEST", "策略参数不合法：%v", err)
		}
		revision, err := h.service.Replace(config)
		if err != nil {
			return nil, mapModuleError(err)
		}
		applied := h.service.Strategies()
		h.logger.Info("策略已更新", "revision", revision, "strategies", len(applied.Strategies))
		return map[string]any{
			"revision":        revision,
			"strategies":      len(applied.Strategies),
			"defaultStrategy": applied.DefaultStrategy,
		}, nil

	case bridge.MethodPreview:
		var request accountpriority.ScoreRequest
		if err := decodeParams(params, &request); err != nil {
			return nil, bridge.Errorf("BRIDGE_BAD_REQUEST", "打分参数不合法：%v", err)
		}
		result, err := h.service.Score(request)
		if err != nil {
			return nil, mapModuleError(err)
		}
		return result, nil

	case bridge.MethodPick:
		var request accountpriority.ScoreRequest
		if err := decodeParams(params, &request); err != nil {
			return nil, bridge.Errorf("BRIDGE_BAD_REQUEST", "选择参数不合法：%v", err)
		}
		picked, err := h.service.Pick(request)
		if err != nil {
			return nil, mapModuleError(err)
		}
		return picked, nil

	case bridge.MethodShutdown:
		// 先让响应写完，再关闭进程。TS 不依赖这个 ack，但排障时能看到它。
		h.stopOnce.Do(func() {
			go func() {
				time.Sleep(100 * time.Millisecond)
				close(h.shutdown)
			}()
		})
		return map[string]bool{"ok": true}, nil

	default:
		return nil, bridge.Errorf("BRIDGE_METHOD_NOT_FOUND", "未知方法：%s", method)
	}
}

func mapModuleError(err error) error {
	var typed *accountpriority.Error
	if errors.As(err, &typed) {
		return bridge.Errorf(string(typed.Code), "%s", typed.Message)
	}
	return bridge.Errorf("ACCOUNT_PRIORITY_INTERNAL", "%v", err)
}

func decodeParams(raw json.RawMessage, target any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = []byte("{}")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("参数末尾有多余内容")
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "gatewayd: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	transport := flag.String("transport", "auto", "控制桥传输：auto / unix / tcp")
	socket := flag.String("socket", "", "unix socket 路径（unix 传输必填）")
	listen := flag.String("listen", "127.0.0.1:0", "TCP 监听地址（只允许回环）")
	logFormat := flag.String("log-format", "text", "日志格式：text / json")
	flag.Parse()

	logger := newLogger(*logFormat)

	network := *transport
	if network == "auto" {
		if runtime.GOOS == "windows" {
			network = "tcp"
		} else {
			network = "unix"
		}
	}
	address := *listen
	if network == "unix" {
		if *socket == "" {
			return errors.New("unix 传输必须提供 -socket")
		}
		address = *socket
	}

	service, err := accountpriority.New(accountpriority.Config{})
	if err != nil {
		return fmt.Errorf("初始化账号优先级模块失败：%w", err)
	}

	stop := make(chan struct{})
	control := &handler{
		service:  service,
		logger:   logger,
		shutdown: stop,
	}

	status := service.Status()
	hello := map[string]any{
		"protocolVersion": bridge.ProtocolVersion,
		"pid":             os.Getpid(),
		"service":         accountpriority.ServiceName,
		"revision":        status.Revision,
		"defaultStrategy": status.DefaultStrategy,
		"strategies":      status.Strategies,
	}

	server, err := bridge.NewServer(network, address, control, bridge.Options{
		Hello:  hello,
		Logger: logger,
	})
	if err != nil {
		return err
	}
	logger.Info("gatewayd 已启动",
		"transport", network,
		"address", server.Address().String(),
		"revision", status.Revision,
	)

	// cordis 用这一行拿到实际地址（TCP :0 时端口是系统分配的）。
	ready, err := json.Marshal(map[string]any{
		"type":            "ready",
		"transport":       network,
		"address":         server.Address().String(),
		"pid":             os.Getpid(),
		"protocolVersion": bridge.ProtocolVersion,
	})
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintln(os.Stdout, string(ready)); err != nil {
		return fmt.Errorf("写 ready 行失败：%w", err)
	}

	go server.Serve()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	select {
	case signalValue := <-signals:
		logger.Info("收到退出信号", "signal", signalValue.String())
	case <-stop:
		logger.Info("收到控制桥的 shutdown")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Close(ctx); err != nil {
		return fmt.Errorf("关闭控制桥失败：%w", err)
	}
	logger.Info("gatewayd 已退出")
	return nil
}

func newLogger(format string) *slog.Logger {
	options := &slog.HandlerOptions{Level: slog.LevelInfo}
	if format == "json" {
		return slog.New(slog.NewJSONHandler(os.Stderr, options))
	}
	return slog.New(slog.NewTextHandler(os.Stderr, options))
}
