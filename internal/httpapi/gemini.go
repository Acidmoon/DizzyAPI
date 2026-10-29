package httpapi

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Gemini 入口。
//
// Gemini 的模型名在**路径**里（官方形状：
// POST /v1beta/models/{model}:generateContent 与
// POST /v1beta/models/{model}:streamGenerateContent?alt=sse），
// body 里没有 model 字段。所以这一段自己解析路径：
//
//   - ServeMux 的通配符不支持「通配 + 字面后缀」（`{model}:generateContent`
//     会被当成非法通配段），因此不能直接用 mux 的模式路由；
//   - 这里在 `/v1beta/models/` 前缀下自行切分「模型名 / 方法」。
//
// 路径里的模型名会被解码（客户端可能用 %2F 之类编码），并做长度与字符校验：
// 它会进入上游 URL，所以必须转义后再拼，不能让客户端把路径语义改掉。

// geminiPathPrefix 是 Gemini 入口的路径前缀（官方版本前缀）。
const geminiPathPrefix = "/v1beta/models/"

// geminiMethodGenerateContent 是 Gemini 的非流式方法名。
const geminiMethodGenerateContent = "generateContent"

// geminiMethodStreamGenerateContent 是 Gemini 的流式方法名。
const geminiMethodStreamGenerateContent = "streamGenerateContent"

// geminiMaxModelLength 是模型名长度上限（防超长路径）。
const geminiMaxModelLength = 256

// geminiModelPath 是从 Gemini 路径里解析出来的模型名与方法。
type geminiModelPath struct {
	model string
	// stream 为真表示这是流式方法（:streamGenerateContent）。
	stream bool
}

// parseGeminiModelPath 解析 Gemini 的请求路径。
//
// 形状：{prefix}{model}:{method}。模型名可能含百分号编码（先解码再校验）。
func parseGeminiModelPath(escapedPath string) (geminiModelPath, bool) {
	if !strings.HasPrefix(escapedPath, geminiPathPrefix) {
		return geminiModelPath{}, false
	}
	rest := strings.TrimPrefix(escapedPath, geminiPathPrefix)
	index := strings.LastIndex(rest, ":")
	if index <= 0 || index == len(rest)-1 {
		return geminiModelPath{}, false
	}
	rawModel := rest[:index]
	method := rest[index+1:]
	switch method {
	case geminiMethodGenerateContent, geminiMethodStreamGenerateContent:
	default:
		return geminiModelPath{}, false
	}
	model, err := url.PathUnescape(rawModel)
	if err != nil || model == "" || len(model) > geminiMaxModelLength {
		return geminiModelPath{}, false
	}
	// 模型名只允许字母 / 数字 / 点 / 横线 / 下划线 / 冒号（Gemini 的
	// "models/gemini-2.0-flash" 这类形状；带斜杠的路径穿越一律拒绝）。
	if strings.ContainsAny(model, "/\\?#\x00") {
		return geminiModelPath{}, false
	}
	return geminiModelPath{model: model, stream: method == geminiMethodStreamGenerateContent}, true
}

// handleGemini 处理 Gemini 的 LLM 入口。
//
// 请求体里没有 model：模型名来自路径。流式与非流式按方法名区分；流式端点必须带
// `alt=sse`，否则上游会返回 JSON 数组而不是 SSE——它在 transport 的方言里
// （StreamQuery）统一补，这里不碰客户端传来的 query。
func (s *Server) handleGemini(w http.ResponseWriter, r *http.Request) {
	if _, ok := parseGeminiModelPath(r.URL.EscapedPath()); !ok {
		writeErrorFor(w, contracts.ProtocolGemini, http.StatusNotFound, "NOT_FOUND", "不支持的 Gemini 路径")
		return
	}
	s.llmRouteHandler(llmRoute{
		protocol:       contracts.ProtocolGemini,
		path:           geminiPathPrefix + "{model}:generateContent",
		modelFromPath:  true,
		streamFromPath: true,
	}).ServeHTTP(w, r)
}
