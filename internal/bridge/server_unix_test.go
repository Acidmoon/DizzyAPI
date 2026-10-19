//go:build !windows

package bridge

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestUnixSocketRoundTripAndCleanup(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "gatewayd.sock")
	server, err := NewServer("unix", socketPath, HandlerFunc(
		func(_ context.Context, method string, _ json.RawMessage) (any, error) {
			return method, nil
		},
	), Options{Hello: map[string]any{"protocolVersion": ProtocolVersion}})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	go server.Serve()

	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	t.Cleanup(func() { _ = conn.Close() })

	hello := readJSON[Event](t, conn)
	if hello.Event != "hello" {
		t.Fatalf("首帧应为 hello：%+v", hello)
	}
	response := sendRequest(t, conn, "1", "unix.echo", nil)
	if !response.OK || response.Result != "unix.echo" {
		t.Fatalf("响应不对：%+v", response)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := server.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(socketPath); !os.IsNotExist(err) {
		t.Fatalf("关闭后应删除 socket 文件，stat 返回 %v", err)
	}
}

func TestUnixRefusesToOverwriteRegularFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-a-socket")
	if err := os.WriteFile(path, []byte("keep me"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	_, err := NewServer("unix", path, HandlerFunc(
		func(_ context.Context, _ string, _ json.RawMessage) (any, error) { return true, nil },
	), Options{})
	if err == nil {
		t.Fatal("同名的普通文件不能被覆盖")
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil || string(data) != "keep me" {
		t.Fatalf("普通文件被破坏了：%q / %v", data, readErr)
	}
}
