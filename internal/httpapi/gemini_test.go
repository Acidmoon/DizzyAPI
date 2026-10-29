package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/engine"
	"github.com/Acidmoon/DizzyAPI/modules/accountpriority"
	"github.com/Acidmoon/DizzyAPI/modules/transport"
)

// Gemini 入口：模型名在 URL 路径里，body 里没有 model 字段。

func TestParseGeminiModelPath(t *testing.T) {
	cases := []struct {
		path   string
		model  string
		stream bool
		ok     bool
	}{
		{"/v1beta/models/gemini-2.0-flash:generateContent", "gemini-2.0-flash", false, true},
		{"/v1beta/models/gemini-2.0-flash:streamGenerateContent", "gemini-2.0-flash", true, true},
		{"/v1beta/models/gemini-2.0-flash%3Afoo:generateContent", "gemini-2.0-flash:foo", false, true},
		// 官方 REST 形状 `{model=models/*}`：带一层 models/ 前缀也接受，归一成裸名。
		{"/v1beta/models/models/gemini-2.0-flash:generateContent", "gemini-2.0-flash", false, true},
		{"/v1beta/models/models/gemini-2.0-flash:streamGenerateContent", "gemini-2.0-flash", true, true},
		{"/v1beta/models/models%2Fgemini-2.0-flash:generateContent", "gemini-2.0-flash", false, true},
		// 不是 Gemini 形状的路径一律拒绝。
		{"/v1beta/models/gemini-2.0-flash", "", false, false},
		{"/v1beta/models/:generateContent", "", false, false},
		{"/v1beta/models/gemini:unknownMethod", "", false, false},
		{"/v1/chat/completions", "", false, false},
		// 只剥一层 models/：剥完仍带斜杠的继续拒绝。
		{"/v1beta/models/models/models/gemini:generateContent", "", false, false},
		{"/v1beta/models/models/a/b:generateContent", "", false, false},
		{"/v1beta/models/models/:generateContent", "", false, false},
		// 路径穿越必须被拒绝。
		{"/v1beta/models/a%2F..%2Fb:generateContent", "", false, false},
		{"/v1beta/models/models%2F..%2Fetc:generateContent", "", false, false},
		{"/v1beta/models/a%5Cb:generateContent", "", false, false},
		{"/v1beta/models/a%3Fb:generateContent", "", false, false},
		{"/v1beta/models/a%23b:generateContent", "", false, false},
	}
	for _, tc := range cases {
		parsed, ok := parseGeminiModelPath(tc.path)
		if ok != tc.ok {
			t.Fatalf("%s：解析结果 %v，期望 ok=%v", tc.path, ok, tc.ok)
		}
		if !ok {
			continue
		}
		if parsed.model != tc.model {
			t.Fatalf("%s：模型名 %q，期望 %q", tc.path, parsed.model, tc.model)
		}
		if parsed.stream != tc.stream {
			t.Fatalf("%s：stream %v，期望 %v", tc.path, parsed.stream, tc.stream)
		}
	}
}

// geminiGateway 组一个带真实 Gemini 上游的网关。
func geminiGateway(t *testing.T, upstreamURL string) http.Handler {
	t.Helper()
	cache := accounts.New()
	if _, err := cache.Replace(snapshot(upstreamURL, accounts.Account{
		AccountID: "acc-1",
		Provider:  "gemini",
		Kind:      "api_key",
		Token:     "sk-upstream",
		BaseURL:   upstreamURL + "/v1beta",
		Protocol:  string(contracts.ProtocolGemini),
	})); err != nil {
		t.Fatalf("accounts.Replace: %v", err)
	}
	registry := contracts.NewRegistry()
	if _, err := accountpriority.Register(registry, accountpriority.Config{}); err != nil {
		t.Fatalf("accountpriority.Register: %v", err)
	}
	if _, err := transport.Register(registry, transport.Config{RequestTimeoutMs: 5_000}, cache, nil); err != nil {
		t.Fatalf("transport.Register: %v", err)
	}
	requestEngine, err := engine.New(registry.Stages(), nil)
	if err != nil {
		t.Fatalf("engine.New: %v", err)
	}
	server, err := New(requestEngine, cache, nil, Config{})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	return server.Handler()
}

func postGemini(t *testing.T, handler http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// Gemini 请求体里没有 model：模型名必须来自路径，并进到上游 URL。
func TestGeminiEntryTakesModelFromPath(t *testing.T) {
	var seenPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}`))
	}))
	defer upstream.Close()

	handler := geminiGateway(t, upstream.URL)
	recorder := postGemini(t, handler,
		"/v1beta/models/gemini-2.0-flash:generateContent",
		`{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`)

	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if seenPath != "/v1beta/models/gemini-2.0-flash:generateContent" {
		t.Fatalf("上游路径不对：%s", seenPath)
	}
	// 同协议直通：响应体原样返回。
	if !strings.Contains(recorder.Body.String(), `"candidates"`) {
		t.Fatalf("响应体不对：%s", recorder.Body.String())
	}
}

func TestGeminiEntryRejectsUnknownPath(t *testing.T) {
	handler := geminiGateway(t, "http://127.0.0.1:1")
	recorder := postGemini(t, handler, "/v1beta/models/gemini-2.0-flash", `{"contents":[]}`)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("未知 Gemini 路径应 404，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
}

func TestGeminiEntryRejectsNonPost(t *testing.T) {
	handler := geminiGateway(t, "http://127.0.0.1:1")
	request := httptest.NewRequest(http.MethodGet, "/v1beta/models/gemini-2.0-flash:generateContent", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET 应 405，得到 %d", recorder.Code)
	}
}

// Gemini 的错误体形状：{"error":{"code","message","status"}}。
func TestGeminiErrorBodyShape(t *testing.T) {
	handler := geminiGateway(t, "http://127.0.0.1:1")
	recorder := postGemini(t, handler, "/v1beta/models/gemini-2.0-flash:generateContent", `{not json`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("期望 400，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Error struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Status  string `json:"status"`
			Reason  string `json:"reason"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("错误体不是 JSON：%v（%s）", err, recorder.Body.String())
	}
	// 官方语义：code 是整数 HTTP 状态，status 是 Google 枚举名。
	if payload.Error.Code != http.StatusBadRequest {
		t.Fatalf("error.code 应为整数 HTTP 状态：%d", payload.Error.Code)
	}
	if payload.Error.Status != "INVALID_ARGUMENT" {
		t.Fatalf("error.status 不对：%q", payload.Error.Status)
	}
	// 网关稳定码只增不改地放在 reason 里。
	if payload.Error.Reason != "INVALID_REQUEST" {
		t.Fatalf("error.reason 不对：%q", payload.Error.Reason)
	}
	if payload.Error.Message == "" {
		t.Fatal("error.message 不能为空")
	}
}
