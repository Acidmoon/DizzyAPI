package metrics_test

import (
	"strings"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/metrics"
)

// 指标必须能被 Prometheus 文本解析：HELP/TYPE 成对、标签来自固定枚举、
// 不含账号 / 用户 / 模型名这类高基数或敏感标签。

func render(t *testing.T, registry *metrics.Registry) string {
	t.Helper()
	output := string(registry.Render())
	if !strings.HasSuffix(output, "\n") {
		t.Fatalf("Prometheus 文本必须以换行结尾：%q", output)
	}
	return output
}

func TestRequestCounters(t *testing.T) {
	registry := metrics.New(metrics.Gauges{})
	registry.ObserveRequest(contracts.ProtocolOpenAIChat, 200, 1500*time.Millisecond)
	registry.ObserveRequest(contracts.ProtocolOpenAIChat, 200, 500*time.Millisecond)
	registry.ObserveRequest(contracts.ProtocolAnthropic, 429, 2*time.Second)
	registry.ObserveRequest(contracts.Protocol("bogus"), 500, time.Second)
	// 越界状态码按 500 计，不产生奇怪的标签。
	registry.ObserveRequest(contracts.ProtocolGemini, 0, time.Second)

	output := render(t, registry)
	for _, want := range []string{
		`dizzy_request_total{protocol="openai-chat",status="200"} 2`,
		`dizzy_request_total{protocol="anthropic",status="429"} 1`,
		`dizzy_request_total{protocol="other",status="500"} 1`,
		`dizzy_request_total{protocol="gemini",status="500"} 1`,
		"# TYPE dizzy_request_total counter",
		"# TYPE dizzy_request_duration_seconds summary",
		"dizzy_request_duration_seconds_count 5",
		"dizzy_request_duration_seconds_sum 6",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("缺少 %q：\n%s", want, output)
		}
	}
}

func TestUsageTokens(t *testing.T) {
	registry := metrics.New(metrics.Gauges{})
	registry.ObserveUsage(contracts.Usage{
		InputTokens:              70,
		OutputTokens:             20,
		CacheReadInputTokens:     30,
		CacheCreationInputTokens: 5,
	})
	output := render(t, registry)
	for _, want := range []string{
		`dizzy_tokens_total{bucket="input"} 70`,
		`dizzy_tokens_total{bucket="output"} 20`,
		`dizzy_tokens_total{bucket="cache_read"} 30`,
		`dizzy_tokens_total{bucket="cache_write"} 5`,
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("缺少 %q：\n%s", want, output)
		}
	}
}

func TestAttemptsAndFailuresUseFixedCodes(t *testing.T) {
	registry := metrics.New(metrics.Gauges{})
	registry.ObserveAttempts([]contracts.AccountAttempt{
		{AccountID: "acc-1", Status: 500, Code: "UPSTREAM_ERROR"},
		{AccountID: "acc-1", Status: 503, Code: "UPSTREAM_TIMEOUT"},
		// 未登记的码落到 other，不污染标签基数。
		{AccountID: "acc-2", Status: 400, Code: "SOMETHING_NEW"},
		{AccountID: "acc-2", Status: 200},
	})
	output := render(t, registry)
	for _, want := range []string{
		"dizzy_upstream_attempt_total 4",
		`dizzy_upstream_failure_total{code="UPSTREAM_ERROR"} 1`,
		`dizzy_upstream_failure_total{code="UPSTREAM_TIMEOUT"} 1`,
		`dizzy_upstream_failure_total{code="other"} 1`,
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("缺少 %q：\n%s", want, output)
		}
	}
	// 账号 id 绝不能成为标签。
	if strings.Contains(output, "acc-1") || strings.Contains(output, "acc-2") {
		t.Fatalf("指标里出现了账号 id：\n%s", output)
	}
	if strings.Contains(output, `code="SOMETHING_NEW"`) {
		t.Fatalf("未登记的失败码不该原样出现：\n%s", output)
	}
}

func TestGaugesAreOptional(t *testing.T) {
	empty := render(t, metrics.New(metrics.Gauges{}))
	if strings.Contains(empty, "dizzy_inflight_active") {
		t.Fatalf("没有注入运行时就不该输出该 gauge：\n%s", empty)
	}

	registry := metrics.New(metrics.Gauges{
		InflightActive:          func() int { return 3 },
		AccountsCooling:         func() int { return 2 },
		UsageRingDropped:        func() int64 { return 7 },
		UsageRingGap:            func() int64 { return 1 },
		QuotaSnapshotAgeSeconds: func() float64 { return 2.5 },
	})
	output := render(t, registry)
	for _, want := range []string{
		"dizzy_inflight_active 3",
		"dizzy_accounts_cooling 2",
		"dizzy_usage_ring_dropped 7",
		"dizzy_usage_ring_gap 1",
		"dizzy_quota_snapshot_age_seconds 2.5",
		"# TYPE dizzy_inflight_active gauge",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("缺少 %q：\n%s", want, output)
		}
	}
}

// 空累加器也要输出合法文本（计数为 0），不能让 scrape 拿到空响应。
func TestEmptyRegistryRendersValidText(t *testing.T) {
	output := render(t, metrics.New(metrics.Gauges{}))
	for _, want := range []string{
		"# HELP dizzy_request_total",
		"dizzy_request_duration_seconds_count 0",
		"dizzy_upstream_attempt_total 0",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("缺少 %q：\n%s", want, output)
		}
	}
}

func TestNilRegistryIsSafe(t *testing.T) {
	var registry *metrics.Registry
	registry.ObserveRequest(contracts.ProtocolOpenAIChat, 200, time.Second)
	registry.ObserveUsage(contracts.Usage{InputTokens: 1})
	registry.ObserveAttempts([]contracts.AccountAttempt{{Code: "X"}})
	if registry.Render() != nil {
		t.Fatal("nil 累加器不该产出文本")
	}
}
