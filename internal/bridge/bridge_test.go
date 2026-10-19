package bridge

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestFrameRoundTrip(t *testing.T) {
	var buffer bytes.Buffer
	if err := writeFrame(&buffer, map[string]string{"hello": "world"}); err != nil {
		t.Fatalf("writeFrame: %v", err)
	}
	payload, err := readFrame(&buffer)
	if err != nil {
		t.Fatalf("readFrame: %v", err)
	}
	var decoded map[string]string
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded["hello"] != "world" {
		t.Fatalf("帧内容不对：%+v", decoded)
	}
}

func TestFrameRejectsOversize(t *testing.T) {
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], MaxFrameBytes+1)
	_, err := readFrame(bytes.NewReader(header[:]))
	if err == nil {
		t.Fatal("超限帧必须被拒绝")
	}
}

func startServer(t *testing.T, handler Handler, hello any) *Server {
	t.Helper()
	server, err := NewServer("tcp", "127.0.0.1:0", handler, Options{Hello: hello})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	go server.Serve()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Close(ctx)
	})
	return server
}

func dialServer(t *testing.T, server *Server) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", server.Address().String())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	if err := conn.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("SetDeadline: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func readJSON[T any](t *testing.T, conn net.Conn) T {
	t.Helper()
	payload, err := readFrame(conn)
	if err != nil {
		t.Fatalf("readFrame: %v", err)
	}
	var value T
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return value
}

func sendRequest(t *testing.T, conn net.Conn, id, method string, params any) Response {
	t.Helper()
	request := Request{ID: id, Type: "request", Method: method}
	if params != nil {
		raw, err := json.Marshal(params)
		if err != nil {
			t.Fatalf("marshal params: %v", err)
		}
		request.Params = raw
	}
	if err := writeFrame(conn, request); err != nil {
		t.Fatalf("writeFrame: %v", err)
	}
	return readJSON[Response](t, conn)
}

func TestHelloAndRequest(t *testing.T) {
	server := startServer(t, HandlerFunc(func(_ context.Context, method string, params json.RawMessage) (any, error) {
		return map[string]any{"method": method, "params": string(params)}, nil
	}), map[string]any{"protocolVersion": ProtocolVersion, "pid": 1234})

	conn := dialServer(t, server)
	hello := readJSON[Event](t, conn)
	if hello.Type != "event" || hello.Event != "hello" {
		t.Fatalf("首帧应为 hello，得到 %+v", hello)
	}

	response := sendRequest(t, conn, "req-1", "demo.echo", map[string]string{"x": "y"})
	if !response.OK || response.ID != "req-1" {
		t.Fatalf("响应不对：%+v", response)
	}
	result, ok := response.Result.(map[string]any)
	if !ok || result["method"] != "demo.echo" {
		t.Fatalf("结果不对：%+v", response.Result)
	}
}

func TestConcurrentRequestsOnOneConnection(t *testing.T) {
	const total = 8
	var arrived atomic.Int32
	release := make(chan struct{})
	var once sync.Once

	server := startServer(t, HandlerFunc(func(_ context.Context, method string, _ json.RawMessage) (any, error) {
		if arrived.Add(1) == total {
			once.Do(func() { close(release) })
		}
		select {
		case <-release:
		case <-time.After(2 * time.Second):
			return nil, errors.New("同连接请求没有并发处理")
		}
		return true, nil
	}), nil)

	conn := dialServer(t, server)
	for index := 0; index < total; index++ {
		request := Request{
			ID:     "req-" + string(rune('a'+index)),
			Type:   "request",
			Method: "slow",
		}
		if err := writeFrame(conn, request); err != nil {
			t.Fatalf("writeFrame: %v", err)
		}
	}

	seen := make(map[string]bool, total)
	for index := 0; index < total; index++ {
		response := readJSON[Response](t, conn)
		if !response.OK {
			t.Fatalf("请求失败：%+v", response)
		}
		seen[response.ID] = true
	}
	if len(seen) != total {
		t.Fatalf("响应 ID 不全：%+v", seen)
	}
}

func TestHandlerErrorCarriesCode(t *testing.T) {
	server := startServer(t, HandlerFunc(func(_ context.Context, method string, _ json.RawMessage) (any, error) {
		if method == "coded" {
			return nil, Errorf("TEST_FAILURE", "boom")
		}
		return nil, errors.New("plain")
	}), nil)
	conn := dialServer(t, server)

	coded := sendRequest(t, conn, "1", "coded", nil)
	if coded.OK || coded.Error == nil || coded.Error.Code != "TEST_FAILURE" {
		t.Fatalf("稳定错误码没有传出来：%+v", coded)
	}
	plain := sendRequest(t, conn, "2", "plain", nil)
	if plain.OK || plain.Error == nil || plain.Error.Code != "BRIDGE_INTERNAL" {
		t.Fatalf("普通错误应映射为内部错误：%+v", plain)
	}
}

func TestBadFramesAreRejected(t *testing.T) {
	server := startServer(t, HandlerFunc(func(_ context.Context, _ string, _ json.RawMessage) (any, error) {
		return true, nil
	}), nil)
	conn := dialServer(t, server)

	if err := writeFrame(conn, "not-an-object"); err != nil {
		t.Fatalf("writeFrame: %v", err)
	}
	invalid := readJSON[Response](t, conn)
	if invalid.OK || invalid.Error == nil || invalid.Error.Code != "BRIDGE_BAD_REQUEST" {
		t.Fatalf("坏 JSON 应被拒绝：%+v", invalid)
	}

	if err := writeFrame(conn, Request{ID: "x", Type: "event"}); err != nil {
		t.Fatalf("writeFrame: %v", err)
	}
	wrongType := readJSON[Response](t, conn)
	if wrongType.OK || wrongType.Error == nil || wrongType.Error.Code != "BRIDGE_BAD_REQUEST" {
		t.Fatalf("非 request 类型应被拒绝：%+v", wrongType)
	}

	if response := sendRequest(t, conn, "ok", "still.alive", nil); !response.OK {
		t.Fatalf("坏帧之后连接应继续可用：%+v", response)
	}
}

func TestCloseStopsAcceptingAndIsIdempotent(t *testing.T) {
	server, err := NewServer("tcp", "127.0.0.1:0", HandlerFunc(
		func(_ context.Context, _ string, _ json.RawMessage) (any, error) { return true, nil },
	), Options{})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	go server.Serve()
	address := server.Address().String()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := server.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := server.Close(ctx); err != nil {
		t.Fatalf("第二次 Close 应幂等：%v", err)
	}

	conn, err := net.DialTimeout("tcp", address, 200*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		t.Fatal("关闭后不应再接受连接")
	}
}

func TestTCPMustBeLoopback(t *testing.T) {
	_, err := NewServer("tcp", "0.0.0.0:0", HandlerFunc(
		func(_ context.Context, _ string, _ json.RawMessage) (any, error) { return true, nil },
	), Options{})
	if err == nil {
		t.Fatal("非回环 TCP 地址必须被拒绝")
	}
}
