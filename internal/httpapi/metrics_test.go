package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/metrics"
	"github.com/Acidmoon/DizzyAPI/modules/keyauth"
)

// GET /metrics：Prometheus 文本格式，只在开启时存在；内容不含秘密 / 账号 id。

func getMetrics(t *testing.T, handler http.Handler) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestMetricsDisabledByDefault(t *testing.T) {
	world, _ := newUsageGateway(t, keyauth.Config{}, nil)
	recorder := getMetrics(t, world.handler)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("默认关闭时 /metrics 应 404，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
}

func TestMetricsExplicitlyDisabledReturns404(t *testing.T) {
	world, _ := newUsageGateway(t, keyauth.Config{}, func(cfg *Config) {
		cfg.Metrics = metrics.New(metrics.Gauges{})
		cfg.MetricsEnabled = false
	})
	if recorder := getMetrics(t, world.handler); recorder.Code != http.StatusNotFound {
		t.Fatalf("关闭时 /metrics 应 404，得到 %d", recorder.Code)
	}
}

func TestMetricsMethodNotAllowed(t *testing.T) {
	world, _ := newUsageGateway(t, keyauth.Config{}, func(cfg *Config) {
		cfg.Metrics = metrics.New(metrics.Gauges{})
		cfg.MetricsEnabled = true
	})
	request := httptest.NewRequest(http.MethodPost, "/metrics", strings.NewReader(""))
	recorder := httptest.NewRecorder()
	world.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /metrics 应 405，得到 %d", recorder.Code)
	}
}

func TestMetricsRendersRequestCounters(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"c1","model":"gpt-test","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":30}}}`)
	}))
	defer upstream.Close()

	world, _ := newUsageGateway(t, keyauth.Config{}, func(cfg *Config) {
		cfg.Metrics = metrics.New(metrics.Gauges{
			InflightActive:          func() int { return 3 },
			AccountsCooling:         func() int { return 1 },
			UsageRingDropped:        func() int64 { return 5 },
			UsageRingGap:            func() int64 { return 2 },
			QuotaSnapshotAgeSeconds: func() float64 { return 1.5 },
		})
		cfg.MetricsEnabled = true
	})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "sk-metrics-secret",
		Protocol: "openai-chat", Priority: 1,
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postPath(t, world.handler, "/v1/chat/completions",
		`{"model":"gpt-test","messages":[{"role":"user","content":"hi"}]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}

	scrape := getMetrics(t, world.handler)
	if scrape.Code != http.StatusOK {
		t.Fatalf("/metrics 期望 200，得到 %d", scrape.Code)
	}
	if contentType := scrape.Header().Get("Content-Type"); !strings.Contains(contentType, "text/plain") {
		t.Fatalf("Content-Type 应为 Prometheus 文本：%q", contentType)
	}
	body := scrape.Body.String()
	for _, want := range []string{
		"# HELP dizzy_request_total",
		"# TYPE dizzy_request_total counter",
		`dizzy_request_total{protocol="openai-chat",status="200"} 1`,
		"dizzy_request_duration_seconds_count 1",
		`dizzy_tokens_total{bucket="input"} 70`,
		`dizzy_tokens_total{bucket="output"} 20`,
		`dizzy_tokens_total{bucket="cache_read"} 30`,
		"dizzy_upstream_attempt_total 1",
		"dizzy_inflight_active 3",
		"dizzy_accounts_cooling 1",
		"dizzy_usage_ring_dropped 5",
		"dizzy_usage_ring_gap 2",
		"dizzy_quota_snapshot_age_seconds 1.5",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("指标缺少 %q：\n%s", want, body)
		}
	}
	// 绝不含秘密 / 账号 id / 模型名 / IP。
	for _, forbidden := range []string{"sk-metrics-secret", "acc-1", "gpt-test", "127.0.0.1"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("指标里出现了不该有的值 %q：\n%s", forbidden, body)
		}
	}
}

// 失败的请求也要计数（状态码进标签），但失败码来自固定枚举。
func TestMetricsCountsFailures(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, `{"error":{"message":"boom"}}`)
	}))
	defer upstream.Close()

	world, _ := newUsageGateway(t, keyauth.Config{}, func(cfg *Config) {
		cfg.Metrics = metrics.New(metrics.Gauges{})
		cfg.MetricsEnabled = true
	})
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "sk-x",
		Protocol: "openai-chat", Priority: 1,
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	postPath(t, world.handler, "/v1/chat/completions",
		`{"model":"gpt-test","messages":[{"role":"user","content":"hi"}]}`)
	body := getMetrics(t, world.handler).Body.String()
	if !strings.Contains(body, `dizzy_request_total{protocol="openai-chat",status="502"} 1`) {
		t.Fatalf("失败请求没有被计数：\n%s", body)
	}
	if !strings.Contains(body, `dizzy_upstream_failure_total{code="UPSTREAM_ERROR"} 1`) {
		t.Fatalf("上游失败码没有计数：\n%s", body)
	}
}
