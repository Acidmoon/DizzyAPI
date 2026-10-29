// 手工端到端实测夹具：起真 gatewayd + 假上游 + 推账号 / key 快照，
// 然后用 bin/dizzy 打一条真请求。
//
// 它不是 `go test` 的一部分（用例不 mock 网络，见方案 §3 第 5 批验收），
// 而是给「dizzy 到底能不能打通网关」这件事留一个可复跑的证据。
//
// 用法（在仓库根，先 pnpm build:all）：
//
//	go build -o bin/fake-upstream.exe ./cmd/dizzy/testdata/fake-upstream
//	go build -o bin/e2e.exe ./cmd/dizzy/testdata/e2e
//	.\bin\e2e.exe
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// e2eAPIKey 是这次实测用的 Bearer key。
//
// **它不是真 key**：前缀刻意不用 sk- 形状，值也只是本地假上游认得的随机串；
// 它只用来算 sha256 推给 gatewayd 的 key 快照。
const e2eAPIKey = "e2e-local-test-key"

func main() {
	gatewaydPath := flag.String("gatewayd", "./bin/gatewayd.exe", "gatewayd 二进制路径")
	dizzyPath := flag.String("dizzy", "./bin/dizzy.exe", "dizzy 二进制路径")
	upstreamPath := flag.String("upstream", "./bin/fake-upstream.exe", "假上游二进制路径")
	keep := flag.Bool("keep", false, "结束后不清理临时目录")
	flag.Parse()

	if err := run(*gatewaydPath, *dizzyPath, *upstreamPath, *keep); err != nil {
		fmt.Fprintf(os.Stderr, "\ne2e 失败：%v\n", err)
		os.Exit(1)
	}
	fmt.Println("\n✅ 端到端实测通过")
}

func run(gatewaydPath, dizzyPath, upstreamPath string, keep bool) error {
	// 临时目录放**工作区内**：这台机器上，从工作区启动的进程写 C 盘用户目录会被
	// 环境限制拒绝（同一个二进制从别处启动就能写），放工作区可避开这个噪音。
	tempRoot, err := os.MkdirTemp("", "dz-e2e-*")
	if err != nil {
		// 退回到工作区内的 .e2e-tmp（一定可写）。
		if mkErr := os.MkdirAll(".e2e-tmp", 0o755); mkErr != nil {
			return fmt.Errorf("建临时目录失败（%v / %v）", err, mkErr)
		}
		tempRoot, err = os.MkdirTemp(".e2e-tmp", "run-*")
		if err != nil {
			return fmt.Errorf("建临时目录失败：%w", err)
		}
	}
	if !keep {
		defer os.RemoveAll(tempRoot)
	}
	absoluteTemp, absErr := filepath.Abs(tempRoot)
	if absErr == nil {
		tempRoot = absoluteTemp
	}
	fmt.Printf("临时 home：%s\n", tempRoot)

	// 1) 起假上游。
	upstreamAddr, err := freeAddr()
	if err != nil {
		return err
	}
	upstream := exec.Command(upstreamPath, "-addr", upstreamAddr)
	upstream.Stderr = os.Stderr
	if err := upstream.Start(); err != nil {
		return fmt.Errorf("启动假上游失败：%w", err)
	}
	defer kill(upstream)
	if err := waitTCP(upstreamAddr, 5*time.Second); err != nil {
		return fmt.Errorf("假上游没起来：%w", err)
	}
	fmt.Printf("假上游：http://%s\n", upstreamAddr)

	// 2) 起真 gatewayd（控制桥走回环 TCP，Windows 上 AF_UNIX 用不了）。
	bridgeAddr, err := freeAddr()
	if err != nil {
		return err
	}
	httpAddr, err := freeAddr()
	if err != nil {
		return err
	}
	gatewayd := exec.Command(gatewaydPath,
		"-transport", "tcp",
		"-listen", bridgeAddr,
		"-http-listen", httpAddr,
	)
	var gatewayOut bytes.Buffer
	gatewayd.Stdout = &gatewayOut
	gatewayd.Stderr = os.Stderr
	if err := gatewayd.Start(); err != nil {
		return fmt.Errorf("启动 gatewayd 失败：%w", err)
	}
	defer kill(gatewayd)

	if _, err := readReadyLine(&gatewayOut, gatewayd, 15*time.Second); err != nil {
		return err
	}
	fmt.Printf("gatewayd：http://%s（桥 %s）\n", httpAddr, bridgeAddr)

	// 3) 推账号与 key 快照。
	conn, err := net.Dial("tcp", bridgeAddr)
	if err != nil {
		return fmt.Errorf("连控制桥失败：%w", err)
	}
	defer conn.Close()

	if _, err := bridgeCall(conn, "accounts.replace", map[string]any{
		"version": 1,
		"accounts": []any{map[string]any{
			"accountId": "acct-fake-1",
			"provider":  "custom",
			"kind":      "api_key",
			"baseUrl":   "http://" + upstreamAddr + "/v1",
			"token":     "fake-upstream-token",
			"protocol":  "openai-chat",
			"models":    []string{"fake-model"},
		}},
	}); err != nil {
		return fmt.Errorf("推账号快照失败：%w", err)
	}
	fmt.Println("已推账号快照：acct-fake-1 → 假上游 /v1")

	if _, err := bridgeCall(conn, "keys.replace", map[string]any{
		"version":    1,
		"generation": 1,
		"keys": []any{map[string]any{
			"keyId":   "key-fake-1",
			"userId":  1,
			"keyHash": sha256Hex(e2eAPIKey),
			"profile": "default",
			"name":    "e2e",
		}},
	}); err != nil {
		return fmt.Errorf("推 key 快照失败：%w", err)
	}
	fmt.Println("已推 key 快照：1 个")

	dizzy := func(key string, args ...string) (int, error) {
		return runDizzy(dizzyPath, tempRoot, httpAddr, key, args...)
	}

	// 4) 逐条验证。
	steps := []struct {
		title    string
		key      string
		wantCode int
		args     []string
	}{
		{"dizzy models（Bearer key）", e2eAPIKey, 0, []string{"models"}},
		{"dizzy chat（非流式）", e2eAPIKey, 0, []string{"chat", "-m", "fake-model", "你好，端到端实测"}},
		{"dizzy chat --stream", e2eAPIKey, 0, []string{"chat", "-m", "fake-model", "--stream", "流式测试"}},
		{"dizzy chat --json", e2eAPIKey, 0, []string{"chat", "-m", "fake-model", "--json", "JSON 测试"}},
		{"dizzy chat（坏 key）", "wrong-key-here", 4, []string{"chat", "-m", "fake-model", "x"}},
		{"dizzy health（只有数据面）", e2eAPIKey, 1, []string{"health"}},
		{"dizzy usage（无会话）", e2eAPIKey, 3, []string{"usage"}},
	}
	for _, step := range steps {
		fmt.Printf("\n--- %s ---\n", step.title)
		code, err := dizzy(step.key, step.args...)
		if err != nil {
			return err
		}
		if code != step.wantCode {
			return fmt.Errorf("%s：退出码应为 %d，得到 %d", step.title, step.wantCode, code)
		}
		fmt.Printf("（退出码 %d，符合预期）\n", code)
	}

	// 5) 验证 --json 输出是合法 JSON（agent 要能解析）。
	fmt.Printf("\n--- 校验 --json 输出是合法 JSON ---\n")
	output, err := captureDizzy(dizzyPath, tempRoot, httpAddr, e2eAPIKey, "chat", "-m", "fake-model", "--json", "解析测试")
	if err != nil {
		return err
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(output), &parsed); err != nil {
		return fmt.Errorf("--json 输出不是合法 JSON：%v\n输出：%s", err, output)
	}
	if parsed["content"] == nil {
		return fmt.Errorf("--json 输出缺少 content 字段：%s", output)
	}
	usage, ok := parsed["usage"].(map[string]any)
	if !ok {
		return fmt.Errorf("--json 输出缺少 usage：%s", output)
	}
	if usage["prompt_tokens"] != float64(100) {
		return fmt.Errorf("usage.prompt_tokens 应为 100，得到 %v", usage["prompt_tokens"])
	}
	if usage["completion_tokens"] != float64(50) {
		return fmt.Errorf("usage.completion_tokens 应为 50，得到 %v", usage["completion_tokens"])
	}
	fmt.Printf("JSON 合法，token 正确（输入 100 / 输出 50）\n")
	return nil
}

// runDizzy 跑一条 dizzy 命令，输出透到当前终端。
func runDizzy(dizzyPath, home, httpAddr, key string, args ...string) (int, error) {
	command := dizzyCommand(dizzyPath, home, httpAddr, key, args...)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	err := command.Run()
	return exitCodeOf(err)
}

// captureDizzy 跑 dizzy 并把 stdout 抓回来。
func captureDizzy(dizzyPath, home, httpAddr, key string, args ...string) (string, error) {
	command := dizzyCommand(dizzyPath, home, httpAddr, key, args...)
	var stdout bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		code, _ := exitCodeOf(err)
		return stdout.String(), fmt.Errorf("dizzy %s 退出码 %d", strings.Join(args, " "), code)
	}
	return stdout.String(), nil
}

// dizzyCommand 构造一条 dizzy 命令。
func dizzyCommand(dizzyPath, home, httpAddr, key string, args ...string) *exec.Cmd {
	full := append([]string{"--base", "http://" + httpAddr}, args...)
	command := exec.Command(dizzyPath, full...)
	command.Env = append(os.Environ(),
		"DIZZY_HOME="+home,
		"DIZZYAPI_KEY="+key,
	)
	return command
}

// exitCodeOf 把 exec 错误折成退出码。
func exitCodeOf(err error) (int, error) {
	if err == nil {
		return 0, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	return 1, err
}

// kill 尽力杀掉子进程。
func kill(command *exec.Cmd) {
	if command.Process != nil {
		_ = command.Process.Kill()
	}
}

// freeAddr 要一个空闲的回环地址。
func freeAddr() (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	defer listener.Close()
	return listener.Addr().String(), nil
}

// waitTCP 等一个地址可连。
func waitTCP(addr string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			conn.Close()
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("等待 %s 超时", addr)
}

// readReadyLine 从 gatewayd 的 stdout 里读 ready JSON 行。
func readReadyLine(buffer *bytes.Buffer, command *exec.Cmd, timeout time.Duration) (map[string]any, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		text := buffer.String()
		if index := strings.IndexByte(text, '\n'); index >= 0 {
			var ready map[string]any
			if err := json.Unmarshal([]byte(text[:index]), &ready); err == nil && ready["type"] == "ready" {
				return ready, nil
			}
		}
		if command.ProcessState != nil && command.ProcessState.Exited() {
			return nil, fmt.Errorf("gatewayd 提前退出；stdout=%q", text)
		}
		time.Sleep(50 * time.Millisecond)
	}
	return nil, fmt.Errorf("等 gatewayd ready 行超时；已收到 %q", buffer.String())
}

// bridgeCall 发一条控制桥请求并读响应（跳过 hello 之类的事件帧）。
func bridgeCall(conn net.Conn, method string, params any) (map[string]any, error) {
	payload, err := json.Marshal(map[string]any{
		"id": "e2e-1", "type": "request", "method": method, "params": params,
	})
	if err != nil {
		return nil, err
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := conn.Write(header[:]); err != nil {
		return nil, err
	}
	if _, err := conn.Write(payload); err != nil {
		return nil, err
	}

	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	for {
		frame, err := readFrame(conn)
		if err != nil {
			return nil, err
		}
		var envelope map[string]any
		if err := json.Unmarshal(frame, &envelope); err != nil {
			return nil, err
		}
		if envelope["type"] == "event" {
			continue
		}
		if ok, _ := envelope["ok"].(bool); !ok {
			raw, _ := json.Marshal(envelope["error"])
			return nil, fmt.Errorf("%s 失败：%s", method, raw)
		}
		result, _ := envelope["result"].(map[string]any)
		return result, nil
	}
}

// readFrame 读一个长度前缀帧。
func readFrame(reader io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return nil, err
	}
	payload := make([]byte, binary.BigEndian.Uint32(header[:]))
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

// sha256Hex 算 sha256 的十六进制（key 快照只要哈希）。
func sha256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}
