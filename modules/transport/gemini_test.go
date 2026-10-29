package transport

import (
	"context"
	"errors"
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

// 模型名来自客户端，归一失败必须明确拒绝（不能静默拼成奇怪的路径）。
func TestGeminiDialectRejectsInvalidModelName(t *testing.T) {
	stage := geminiStage(t, httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("非法模型名不该到达上游：%s", r.URL.Path)
	})), Config{})

	for _, model := range []string{"a/../b?x=1", "a/b", "models/models/x", "a\\b", "a#b", ""} {
		ctx := geminiRequest(false)
		ctx.Meta.Model = model
		_, err := stage.Run(ctx)
		var stageErr *contracts.StageError
		if !errors.As(err, &stageErr) {
			t.Fatalf("模型名 %q 应明确失败，得到 %v", model, err)
		}
		if stageErr.Code != "UPSTREAM_URL_INVALID" || stageErr.Status != http.StatusBadGateway {
			t.Fatalf("模型名 %q 的错误码 = %q / %d", model, stageErr.Code, stageErr.Status)
		}
	}
}

// 客户端传 `models/x`（官方 REST 形状）与传裸名 `x`，上游 URL 都只有一层 models/。
func TestGeminiDialectAcceptsModelsPrefix(t *testing.T) {
	for _, model := range []string{"gemini-2.0-flash", "models/gemini-2.0-flash"} {
		var seenPath string
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			seenPath = r.URL.Path
			_, _ = w.Write([]byte(`{"candidates":[]}`))
		}))
		stage := geminiStage(t, upstream, Config{})
		ctx := geminiRequest(false)
		ctx.Meta.Model = model
		if _, err := stage.Run(ctx); err != nil {
			t.Fatalf("%q：Run: %v", model, err)
		}
		if seenPath != "/v1beta/models/gemini-2.0-flash:generateContent" {
			t.Fatalf("%q：上游路径 %s，期望只有一层 models/", model, seenPath)
		}
		upstream.Close()
	}
}

// 流式 + 带前缀：方法名与 alt=sse 仍正确。
func TestGeminiDialectModelsPrefixWithStream(t *testing.T) {
	var seenPath, seenQuery string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {}\n\n"))
	}))
	defer upstream.Close()

	stage := geminiStage(t, upstream, Config{})
	ctx := geminiRequest(true)
	ctx.Meta.Model = "models/gemini-2.0-flash"
	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if seenPath != "/v1beta/models/gemini-2.0-flash:streamGenerateContent" {
		t.Fatalf("流式路径不对：%s", seenPath)
	}
	if !strings.Contains(seenQuery, "alt=sse") {
		t.Fatalf("流式请求必须带 alt=sse：%s", seenQuery)
	}
}

// modelMap 映射出来的上游名带 models/ 前缀时，也只拼一层。
func TestGeminiDialectNormalizesMappedModelName(t *testing.T) {
	var seenPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		_, _ = w.Write([]byte(`{"candidates":[]}`))
	}))
	defer upstream.Close()

	stage := geminiStage(t, upstream, Config{})
	ctx := geminiRequest(false)
	ctx.UpstreamModel = "models/gemini-2.5-pro"
	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if seenPath != "/v1beta/models/gemini-2.5-pro:generateContent" {
		t.Fatalf("映射后的模型名应归一成一层 models/：%s", seenPath)
	}
}

// 非法模型名不许拼出路径：归一失败即明确失败。
func TestRenderDialectPathRejectsUnsafeModel(t *testing.T) {
	if _, err := renderDialectPath("/models/{model}:generateContent", "a/../b"); err == nil {
		t.Fatal("路径穿越必须被拒绝")
	}
	if _, err := renderDialectPath("/models/{model}:generateContent", "models/models/x"); err == nil {
		t.Fatal("双层 models/ 必须被拒绝")
	}
}

func TestRenderDialectPathReplacesModelPlaceholder(t *testing.T) {
	got, err := renderDialectPath("/models/{model}:generateContent", "gemini-2.0-flash")
	if err != nil {
		t.Fatalf("renderDialectPath: %v", err)
	}
	if got != "/models/gemini-2.0-flash:generateContent" {
		t.Fatalf("renderDialectPath = %q", got)
	}
	// 官方形状：剥掉一层后只补一层。
	prefixed, err := renderDialectPath("/models/{model}:generateContent", "models/gemini-2.0-flash")
	if err != nil {
		t.Fatalf("renderDialectPath: %v", err)
	}
	if prefixed != "/models/gemini-2.0-flash:generateContent" {
		t.Fatalf("带前缀的模型名应归一：%q", prefixed)
	}
	// 没有占位的方言原样返回。
	if got, err := renderDialectPath("/chat/completions", "m"); err != nil || got != "/chat/completions" {
		t.Fatalf("无占位的路径不该被改：%q %v", got, err)
	}
}
