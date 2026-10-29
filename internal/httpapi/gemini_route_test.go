package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/modules/keyauth"
)

// 本文件验证 Gemini 入口与「Gemini 作为上游」的端到端行为：
//   - 同协议直通：请求体逐字节不变、响应逐字节不变；
//   - 跨协议：Gemini 客户端对 OpenAI 上游、OpenAI 客户端对 Gemini 上游；
//   - 流式：Gemini 客户端经 OpenAI 上游拿到 SSE；
//   - 缺 codec：跨协议仍然 fail-closed（PROTOCOL_CODEC_UNAVAILABLE）。

const geminiRequestPath = "/v1beta/models/gemini-2.5-flash:generateContent"

const geminiResponseBody = `{"candidates":[{"content":{"role":"model","parts":[{"text":"hi from gemini"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8}}`

// 同协议直通：body 与响应都不得被改写。
func TestGeminiSameProtocolPassthrough(t *testing.T) {
	var (
		upstreamPath     string
		upstreamRawQuery string
		upstreamBody     string
		apiKey           string
		authorization    string
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamPath = r.URL.Path
		upstreamRawQuery = r.URL.RawQuery
		apiKey = r.Header.Get("x-goog-api-key")
		authorization = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		upstreamBody = string(raw)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, geminiResponseBody)
	}))
	defer upstream.Close()

	world := newGatewayWithAllCodecs(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1beta", accounts.Account{
		AccountID: "acc-1", Provider: "custom", Kind: "api_key",
		Token: "AIza-secret", Protocol: "gemini",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	body := `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"temperature":0.2}}`
	recorder := postPath(t, world.handler, geminiRequestPath, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if upstreamPath != "/v1beta/models/gemini-2.5-flash:generateContent" {
		t.Fatalf("上游路径不对：%s", upstreamPath)
	}
	if upstreamBody != body {
		t.Fatalf("同协议直通必须逐字节不变：\n得到 %s\n期望 %s", upstreamBody, body)
	}
	if strings.Contains(upstreamBody, `"model"`) {
		t.Fatalf("Gemini 上游 body 里不该出现 model 字段：%s", upstreamBody)
	}
	if apiKey != "AIza-secret" {
		t.Fatalf("Gemini 上游应走 x-goog-api-key 头：%q", apiKey)
	}
	if authorization != "" {
		t.Fatalf("不该把网关密钥当 Authorization 转给上游：%q", authorization)
	}
	if upstreamRawQuery != "" {
		t.Fatalf("非流式请求不该带 alt 参数：%q", upstreamRawQuery)
	}
	if recorder.Body.String() != geminiResponseBody {
		t.Fatalf("同协议响应必须逐字节不变：\n得到 %s", recorder.Body.String())
	}
}

// Gemini 客户端 → OpenAI 上游：模型名（来自路径）必须进渲染后的 body。
func TestGeminiClientOpenAIUpstream(t *testing.T) {
	var (
		upstreamPath string
		upstreamBody map[string]any
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &upstreamBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chatcmpl-1","object":"chat.completion","model":"gpt-5",
			"choices":[{"index":0,"message":{"role":"assistant","content":"hi from gpt"},"finish_reason":"stop"}],
			"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}`)
	}))
	defer upstream.Close()

	world := newGatewayWithAllCodecs(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key",
		Token: "sk-openai", Protocol: "openai-chat",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	body := `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"maxOutputTokens":16}}`
	recorder := postPath(t, world.handler, geminiRequestPath, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if upstreamPath != "/v1/chat/completions" {
		t.Fatalf("上游路径不对：%s", upstreamPath)
	}
	if upstreamBody["model"] != "gemini-2.5-flash" {
		t.Fatalf("Gemini 路径里的模型名没进上游 body：%v", upstreamBody)
	}
	messages, ok := upstreamBody["messages"].([]any)
	if !ok || len(messages) != 1 {
		t.Fatalf("contents 没转成 messages：%v", upstreamBody)
	}

	var converted map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &converted); err != nil {
		t.Fatalf("响应不是合法 JSON：%v", err)
	}
	candidates, ok := converted["candidates"].([]any)
	if !ok || len(candidates) != 1 {
		t.Fatalf("响应应是 Gemini 形状（candidates）：%v", converted)
	}
	if strings.Contains(recorder.Body.String(), "chatcmpl-1") && !strings.Contains(recorder.Body.String(), "candidates") {
		t.Fatal("响应泄漏了上游 OpenAI 形状")
	}
	if strings.Contains(recorder.Body.String(), "sk-openai") {
		t.Fatal("响应泄漏了上游令牌")
	}
}

// OpenAI 客户端 → Gemini 上游：路径带模型与方法名，鉴权走 x-goog-api-key，
// body 里没有 model 字段。
func TestOpenAIClientGeminiUpstream(t *testing.T) {
	var (
		upstreamPath  string
		upstreamBody  map[string]any
		apiKey        string
		authorization string
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamPath = r.URL.Path
		apiKey = r.Header.Get("x-goog-api-key")
		authorization = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &upstreamBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, geminiResponseBody)
	}))
	defer upstream.Close()

	world := newGatewayWithAllCodecs(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1beta", accounts.Account{
		AccountID: "acc-1", Provider: "custom", Kind: "api_key",
		Token: "AIza-secret", Protocol: "gemini",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	body := `{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":16}`
	recorder := postPath(t, world.handler, "/v1/chat/completions", body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if upstreamPath != "/v1beta/models/gemini-2.5-flash:generateContent" {
		t.Fatalf("上游路径不对：%s", upstreamPath)
	}
	if apiKey != "AIza-secret" || authorization != "" {
		t.Fatalf("Gemini 上游鉴权不对：apiKey=%q auth=%q", apiKey, authorization)
	}
	if _, ok := upstreamBody["model"]; ok {
		t.Fatalf("Gemini 上游 body 不该有 model：%v", upstreamBody)
	}
	if _, ok := upstreamBody["contents"]; !ok {
		t.Fatalf("messages 没转成 contents：%v", upstreamBody)
	}

	var converted map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &converted); err != nil {
		t.Fatalf("响应不是合法 JSON：%v", err)
	}
	choices, ok := converted["choices"].([]any)
	if !ok || len(choices) != 1 {
		t.Fatalf("响应应是 OpenAI chat 形状（choices）：%v", converted)
	}
	if _, ok := converted["usage"].(map[string]any); !ok {
		t.Fatalf("响应缺 usage：%v", converted)
	}
}

// Gemini 客户端流式 → OpenAI 上游：客户端看到 Gemini 的 SSE 帧。
func TestGeminiClientStreamingOpenAIUpstream(t *testing.T) {
	var upstreamPath, upstreamRawQuery string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamPath = r.URL.Path
		upstreamRawQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		for _, chunk := range []string{
			`data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hel"}}]}`,
			`data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}`,
			`data: [DONE]`,
		} {
			_, _ = io.WriteString(w, chunk+"\n\n")
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	defer upstream.Close()

	world := newGatewayWithAllCodecs(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key",
		Token: "sk-openai", Protocol: "openai-chat",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	body := `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`
	recorder := postPath(t, world.handler, "/v1beta/models/gemini-2.5-flash:streamGenerateContent", body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if upstreamPath != "/v1/chat/completions" {
		t.Fatalf("上游路径不对：%s", upstreamPath)
	}
	// 上游是 OpenAI，流式不该带 alt=sse（那是 Gemini 的参数）。
	if upstreamRawQuery != "" {
		t.Fatalf("OpenAI 上游不该带 alt 参数：%q", upstreamRawQuery)
	}
	text := recorder.Body.String()
	if !strings.Contains(text, "candidates") {
		t.Fatalf("流式响应不是 Gemini 形状：\n%s", text)
	}
	if !strings.Contains(text, "hel") || !strings.Contains(text, "lo") {
		t.Fatalf("流里丢了正文：\n%s", text)
	}
	if strings.Contains(text, "[DONE]") {
		t.Fatalf("Gemini 流里不该出现 OpenAI 的 [DONE]：\n%s", text)
	}
}

// Gemini 客户端流式 → Gemini 上游：换成流式方法名并补 alt=sse。
func TestGeminiClientStreamingGeminiUpstream(t *testing.T) {
	var upstreamPath, upstreamRawQuery string
	frames := "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"hi\"}]}}]}\n\n"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamPath = r.URL.Path
		upstreamRawQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, frames)
	}))
	defer upstream.Close()

	world := newGatewayWithAllCodecs(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1beta", accounts.Account{
		AccountID: "acc-1", Provider: "custom", Kind: "api_key",
		Token: "AIza-secret", Protocol: "gemini",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	body := `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`
	recorder := postPath(t, world.handler, "/v1beta/models/gemini-2.5-flash:streamGenerateContent", body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if upstreamPath != "/v1beta/models/gemini-2.5-flash:streamGenerateContent" {
		t.Fatalf("流式方法名没换：%s", upstreamPath)
	}
	if upstreamRawQuery != "alt=sse" {
		t.Fatalf("流式请求必须带 alt=sse：%q", upstreamRawQuery)
	}
	if recorder.Body.String() != frames {
		t.Fatalf("同协议流式响应必须逐字节不变：\n得到 %s", recorder.Body.String())
	}
}

// 官方 REST 形状：客户端路径带 `models/` 前缀（官方 SDK 默认就这么拼），
// 上游 URL 必须只有一层 `models/`；body 与非流式路径仍逐字节直通。
func TestGeminiEntryAcceptsModelsPrefix(t *testing.T) {
	var upstreamPath, upstreamBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		upstreamBody = string(raw)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, geminiResponseBody)
	}))
	defer upstream.Close()

	world := newGatewayWithAllCodecs(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1beta", accounts.Account{
		AccountID: "acc-1", Provider: "custom", Kind: "api_key",
		Token: "AIza-secret", Protocol: "gemini",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	body := `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`
	for _, path := range []string{
		"/v1beta/models/models/gemini-2.5-flash:generateContent",
		"/v1beta/models/models%2Fgemini-2.5-flash:generateContent",
		"/v1beta/models/gemini-2.5-flash:generateContent",
	} {
		recorder := postPath(t, world.handler, path, body)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s：期望 200，得到 %d：%s", path, recorder.Code, recorder.Body.String())
		}
		if upstreamPath != "/v1beta/models/gemini-2.5-flash:generateContent" {
			t.Fatalf("%s：上游路径 %q，期望只有一层 models/", path, upstreamPath)
		}
		if upstreamBody != body {
			t.Fatalf("%s：同协议直通必须逐字节不变：%s", path, upstreamBody)
		}
		if recorder.Body.String() != geminiResponseBody {
			t.Fatalf("%s：响应必须逐字节不变：%s", path, recorder.Body.String())
		}
	}
}

// 带 models/ 前缀 + 流式：方法名与 alt=sse 仍正确，上游仍只有一层 models/。
func TestGeminiEntryModelsPrefixWithStream(t *testing.T) {
	var upstreamPath, upstreamRawQuery string
	frames := "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"hi\"}]}}]}\n\n"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamPath = r.URL.Path
		upstreamRawQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, frames)
	}))
	defer upstream.Close()

	world := newGatewayWithAllCodecs(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1beta", accounts.Account{
		AccountID: "acc-1", Provider: "custom", Kind: "api_key",
		Token: "AIza-secret", Protocol: "gemini",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postPath(t, world.handler,
		"/v1beta/models/models/gemini-2.5-flash:streamGenerateContent", `{"contents":[]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if upstreamPath != "/v1beta/models/gemini-2.5-flash:streamGenerateContent" {
		t.Fatalf("上游流式路径不对：%s", upstreamPath)
	}
	if upstreamRawQuery != "alt=sse" {
		t.Fatalf("流式请求必须带 alt=sse：%q", upstreamRawQuery)
	}
}

// 非法路径（双层前缀、剥完仍带斜杠）→ 404，不是 500，也不该打到上游。
func TestGeminiEntryRejectsUnsafePaths(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("非法路径不该到达上游：%s", r.URL.Path)
	}))
	defer upstream.Close()

	world := newGatewayWithAllCodecs(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1beta", accounts.Account{
		AccountID: "acc-1", Provider: "custom", Kind: "api_key",
		Token: "AIza-secret", Protocol: "gemini",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	for _, path := range []string{
		"/v1beta/models/models/models/gemini:generateContent",
		"/v1beta/models/models/a/b:generateContent",
		"/v1beta/models/a%2F..%2Fb:generateContent",
		"/v1beta/models/models%2F..%2Fetc:generateContent",
		"/v1beta/models/a%5Cb:generateContent",
	} {
		recorder := postPath(t, world.handler, path, `{"contents":[]}`)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s：期望 404，得到 %d：%s", path, recorder.Code, recorder.Body.String())
		}
	}
}

// 带 models/ 前缀的 Gemini 客户端 → OpenAI 上游：渲染进 body 的模型名是裸名。
func TestGeminiEntryPrefixCrossProtocolUsesBareModel(t *testing.T) {
	var upstreamBody map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &upstreamBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chatcmpl-1","object":"chat.completion","model":"gpt-5",
			"choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],
			"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer upstream.Close()

	world := newGatewayWithAllCodecs(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key",
		Token: "sk-openai", Protocol: "openai-chat",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	body := `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`
	recorder := postPath(t, world.handler, "/v1beta/models/models/gemini-2.5-flash:generateContent", body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if upstreamBody["model"] != "gemini-2.5-flash" {
		t.Fatalf("渲染进上游 body 的模型名应是裸名：%v", upstreamBody["model"])
	}
}

// 跨协议但缺 codec：仍然 fail-closed（加 Gemini codec 不能顺带放开别的协议）。
func TestGeminiCrossProtocolWithoutCodecFailsClosed(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("不应到达上游")
	}))
	defer upstream.Close()

	// 只注册 chat codec：没有 gemini codec。
	world := newGatewayWithConversion(t, upstream.URL, keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1beta", accounts.Account{
		AccountID: "acc-1", Provider: "custom", Kind: "api_key",
		Token: "AIza-secret", Protocol: "gemini",
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postPath(t, world.handler, "/v1/chat/completions", `{"model":"gpt-4","messages":[]}`)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("期望 502，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "PROTOCOL_CODEC_UNAVAILABLE") {
		t.Fatalf("错误码不对：%s", recorder.Body.String())
	}
}
