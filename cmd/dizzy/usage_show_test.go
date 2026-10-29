package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// withSessionHome 把 DIZZY_HOME 指到临时目录，并写入指向 baseURL 的配置。
//
// withSession 为假时**不写凭据文件**，用来验「未登录」。
func withSessionHome(t *testing.T, baseURL string, withSession bool) {
	t.Helper()
	withHome(t)
	if err := SaveConfig(Config{Base: baseURL, TimeoutSeconds: 5}); err != nil {
		t.Fatalf("写配置失败：%v", err)
	}
	if withSession {
		if err := SaveCredentials(Credentials{Session: &Session{Token: "{{SECRET_pbmkvtqz}}", Email: "a@b.c"}}); err != nil {
			t.Fatalf("写凭据失败：%v", err)
		}
	}
}

// captureStdout 捕获一次调用的 stdout（CLI 的打印都直接写 os.Stdout）。
func captureStdout(t *testing.T, run func() error) (string, error) {
	t.Helper()
	original := os.Stdout
	file, err := os.CreateTemp(t.TempDir(), "stdout")
	if err != nil {
		t.Fatalf("建临时文件失败：%v", err)
	}
	defer file.Close()
	os.Stdout = file
	defer func() { os.Stdout = original }()

	runErr := run()
	os.Stdout = original

	raw, err := os.ReadFile(file.Name())
	if err != nil {
		t.Fatalf("读回 stdout 失败：%v", err)
	}
	return string(raw), runErr
}

// detailJSON 造一条 `GET /api/usage/:reqId` 的响应体。
func detailJSON(ttftMs string) string {
	return `{"record":{"id":7,"reqId":"req-1-1","userId":1,"apiKeyId":"k1",` +
		`"apiKeyName":"e2e-key","model":"fake-model","upstreamModel":"up-fake",` +
		`"protocol":"openai-chat","upstreamProtocol":"openai-chat","stream":false,` +
		`"status":200,"errorCode":null,"inputTokens":100,"outputTokens":50,` +
		`"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":7,"totalTokens":150,` +
		`"usagePresent":true,"usageComplete":true,"durationMs":12,"ttftMs":` + ttftMs + `,` +
		`"clientIp":"127.0.0.1","startedAt":"2026-10-29T13:00:00.000Z","costMicros":"570"}}`
}

// TestUsageShowPrintsDetail 覆盖「正常读」：走 /api/usage/<reqId>，会话 + 请求头齐全。
func TestUsageShowPrintsDetail(t *testing.T) {
	var gotPath string
	var gotRequestedWith string
	var gotCookie string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotRequestedWith = r.Header.Get("X-Requested-With")
		gotCookie = r.Header.Get("Cookie")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(detailJSON("null")))
	}))
	defer server.Close()
	withSessionHome(t, server.URL, true)

	stdout, err := captureStdout(t, func() error {
		return runUsageShow([]string{"req-1-1"}, globalFlags{})
	})
	if err != nil {
		t.Fatalf("正常读不该失败：%v", err)
	}
	if gotPath != "/api/usage/req-1-1" {
		t.Fatalf("路径不对：%q", gotPath)
	}
	if gotRequestedWith != apiRequestHeaderValue {
		t.Fatalf("缺 X-Requested-With：%q", gotRequestedWith)
	}
	if !strings.Contains(gotCookie, sessionCookieName+"=") {
		t.Fatalf("没带会话 cookie：%q", gotCookie)
	}
	for _, want := range []string{"req-1-1", "fake-model", "up-fake", "570", "0.00057", "e2e-key"} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("输出里应有 %q：\n%s", want, stdout)
		}
	}
	// 非流式没有首字延迟：必须显示「未采集」，不能显示 0 ms。
	if !strings.Contains(stdout, "—（未采集）") {
		t.Fatalf("ttftMs=null 应显示「—（未采集）」：\n%s", stdout)
	}
}

// TestUsageShowJSONKeepsServerFields 覆盖「--json 原样透传、额外字段不丢」。
func TestUsageShowJSONKeepsServerFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(detailJSON("42")))
	}))
	defer server.Close()
	withSessionHome(t, server.URL, true)

	stdout, err := captureStdout(t, func() error {
		return runUsageShow([]string{"req-1-1"}, globalFlags{JSON: true})
	})
	if err != nil {
		t.Fatalf("--json 不该失败：%v", err)
	}
	var parsed usageDetailResponse
	if err := json.Unmarshal([]byte(stdout), &parsed); err != nil {
		t.Fatalf("--json 输出不是合法 JSON：%v\n%s", err, stdout)
	}
	record := parsed.Record
	if record.ReqID != "req-1-1" || record.CostMicros != "570" {
		t.Fatalf("基础字段不对：%+v", record)
	}
	// 列表接口没有、详情接口才有的四个字段，一个都不许在 CLI 里丢。
	if record.ReasoningTokens != 7 {
		t.Fatalf("reasoningTokens 丢了：%d", record.ReasoningTokens)
	}
	if !record.UsagePresent || !record.UsageComplete {
		t.Fatalf("usagePresent / usageComplete 丢了：%+v", record)
	}
	if record.TtftMs == nil || *record.TtftMs != 42 {
		t.Fatalf("ttftMs 丢了：%v", record.TtftMs)
	}
}

// TestUsageShowNotFound 覆盖 404：给人话、退出码 6。
func TestUsageShowNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"USAGE_RECORD_NOT_FOUND","message":"没有这条用量记录"}}`))
	}))
	defer server.Close()
	withSessionHome(t, server.URL, true)

	_, err := captureStdout(t, func() error {
		return runUsageShow([]string{"req-does-not-exist"}, globalFlags{})
	})
	if err == nil {
		t.Fatal("404 应返回错误")
	}
	if code := exitCodeOf(err); code != exitNotFound {
		t.Fatalf("退出码应为 %d，得到 %d（%v）", exitNotFound, code, err)
	}
	if !strings.Contains(err.Error(), "没有这条用量记录") {
		t.Fatalf("应给人话「没有这条用量记录」，得到：%v", err)
	}
}

// TestUsageShowWithoutLogin 覆盖未登录：退出码 3。
func TestUsageShowWithoutLogin(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("未登录时不该发请求")
	}))
	defer server.Close()
	withSessionHome(t, server.URL, false)

	_, err := captureStdout(t, func() error {
		return runUsageShow([]string{"req-1-1"}, globalFlags{})
	})
	if err == nil {
		t.Fatal("未登录应返回错误")
	}
	if code := exitCodeOf(err); code != exitNotLoggedIn {
		t.Fatalf("退出码应为 %d，得到 %d（%v）", exitNotLoggedIn, code, err)
	}
	if !strings.Contains(err.Error(), "dizzy login") {
		t.Fatalf("应提示先登录：%v", err)
	}
}

// TestUsageShowRequiresRequestID 覆盖用法错误：缺 reqId 是退出码 2。
func TestUsageShowRequiresRequestID(t *testing.T) {
	withSessionHome(t, "http://127.0.0.1:1", true)

	_, err := captureStdout(t, func() error {
		return runUsageShow(nil, globalFlags{})
	})
	if err == nil {
		t.Fatal("缺 reqId 应返回错误")
	}
	if code := exitCodeOf(err); code != exitUsage {
		t.Fatalf("退出码应为 %d，得到 %d（%v）", exitUsage, code, err)
	}
}
