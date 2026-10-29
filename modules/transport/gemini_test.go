package transport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Gemini 方言：模型名在路径里、鉴权用 x-goog-api-key、流式是另一个方法名。

func geminiStage(t *testing.T, upstream *httptest.Server, cfg Config) *Stage {
	t.Helper()
	stage, err := New(cfg, staticSource{
		"acc-1": {
			AccountID:   "acc-1",
			Provider:    "gemini",
			Kind:        "api_key",
			BaseURL:     upstream.URL + "/v1beta",
			AccessToken: "sk-gemini",
			Protocol:    string(contracts.ProtocolGemini),
		},
	}, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return stage
}

func geminiRequest(stream bool) *contracts.Ctx {
	return &contracts.Ctx{
		Context: context.Background(),
		ReqID:   "req-gemini",
		Meta:    contracts.RequestMeta{Model: "gemini-2.0-flash", Stream: stream},
		Body:    contracts.BytesBody([]byte(`{"contents":[]}`)),
		AccountRoute: &contracts.AccountRoute{
			Picked: &contracts.ScoredAccount{AccountID: "acc-1"},
		},
	}
}

func TestGeminiDialectBuildsModelPathAndHeader(t *testing.T) {
	var seenPath, seenAPIKey, seenAuthorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenAPIKey = r.Header.Get("x-goog-api-key")
		seenAuthorization = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"candidates":[]}`))
	}))
	defer upstream.Close()

	stage := geminiStage(t, upstream, Config{})
	if _, err := stage.Run(geminiRequest(false)); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if seenPath != "/v1beta/models/gemini-2.0-flash:generateContent" {
		t.Fatalf("上游路径不对：%s", seenPath)
	}
	if seenAPIKey != "sk-gemini" {
		t.Fatalf("x-goog-api-key 不对：%s", seenAPIKey)
	}
	// 客户端的 Authorization（网关密钥）绝不外传。
	if seenAuthorization != "" {
		t.Fatalf("客户端的 Authorization 不许外传：%s", seenAuthorization)
	}
}

func TestGeminiDialectUsesStreamMethodAndQuery(t *testing.T) {
	var seenPath, seenQuery string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {}\n\n"))
	}))
	defer upstream.Close()

	stage := geminiStage(t, upstream, Config{})
	if _, err := stage.Run(geminiRequest(true)); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if seenPath != "/v1beta/models/gemini-2.0-flash:streamGenerateContent" {
		t.Fatalf("流式路径不对：%s", seenPath)
	}
	if !strings.Contains(seenQuery, "alt=sse") {
		t.Fatalf("流式请求必须带 alt=sse：%s", seenQuery)
	}
}

// 模型映射命中时，路径里要用**映射后**的上游模型名。
func TestGeminiDialectUsesMappedModelName(t *testing.T) {
	var seenPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		_, _ = w.Write([]byte(`{"candidates":[]}`))
	}))
	defer upstream.Close()

	stage := geminiStage(t, upstream, Config{})
	ctx := geminiRequest(false)
	ctx.UpstreamModel = "gemini-2.5-pro"
	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if seenPath != "/v1beta/models/gemini-2.5-pro:generateContent" {
		t.Fatalf("映射后的模型名应进路径：%s", seenPath)
	}
}

// 模型名来自客户端，必须转义：不能让它改变路径语义。
func TestGeminiDialectEscapesModelName(t *testing.T) {
	var seenPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.EscapedPath()
		_, _ = w.Write([]byte(`{"candidates":[]}`))
	}))
	defer upstream.Close()

	stage := geminiStage(t, upstream, Config{})
	ctx := geminiRequest(false)
	ctx.Meta.Model = "a/../b?x=1"
	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if strings.Contains(seenPath, "/../") {
		t.Fatalf("模型名不许带路径穿越：%s", seenPath)
	}
	if strings.Contains(seenPath, "?") {
		t.Fatalf("模型名不许带查询串：%s", seenPath)
	}
}

func TestDialectPathReplacesModelPlaceholder(t *testing.T) {
	dialect := DefaultDialects[contracts.ProtocolGemini]
	got := dialectPath(dialect, "gemini-2.0-flash")
	want := "/models/gemini-2.0-flash:generateContent"
	if got != want {
		t.Fatalf("dialectPath = %q，期望 %q", got, want)
	}
	// 没有占位的方言原样返回。
	if got := dialectPath(Dialect{Path: "/chat/completions"}, "m"); got != "/chat/completions" {
		t.Fatalf("无占位的路径不该被改：%q", got)
	}
}
