// Package metrics 收集 gatewayd 的请求级指标，并以 Prometheus 文本格式导出。
//
// 设计约束（AGENTS.md §2.4）：
//   - **热路径只做原子加法**：请求结束后按协议 / 状态码各 +1，不拼字符串、不拿锁；
//     文本渲染只在 scrape 时做。
//   - **标签值来自固定枚举**：协议名、失败码、token 桶都是编译期常量，
//     未知值统一落到 `other`。绝不用账号 id / 用户 id / IP / 模型名做标签
//     （基数会爆，而且账号与用户信息不该出现在运维面）。
//   - 不含秘密：指标里只有计数与聚合值。
//
// 它不被 modules/* import：httpapi 通过自己声明的接口消费本包（组合根注入），
// 这样模块边界不破，测试也能用假实现。
package metrics

import (
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const (
	// statusSlots 覆盖 0..599 的状态码；越界的按 500 计。
	statusSlots = 600
	// tokenBucketCount 是四桶数量（input / output / cache_read / cache_write）。
	tokenBucketCount = 4
)

// protocolLabels 是客户端协议的固定枚举（顺序即数组下标）。
var protocolLabels = [...]string{
	string(contracts.ProtocolOpenAIChat),
	string(contracts.ProtocolOpenAIResponses),
	string(contracts.ProtocolAnthropic),
	string(contracts.ProtocolGemini),
	"other",
}

// tokenLabels 是 token 桶的固定枚举。
var tokenLabels = [tokenBucketCount]string{"input", "output", "cache_read", "cache_write"}

// failureCodes 是上游失败码的固定枚举（顺序即数组下标）。
//
// 值来自 modules/transport 与 httpapi 的稳定 code；不在表里的落到 `other`，
// 这样新错误码不会污染标签基数。
var failureCodes = [...]string{
	"ACCOUNT_UNAVAILABLE",
	"CLIENT_CANCELED",
	"MODEL_NOT_SUPPORTED",
	"UPSTREAM_AUTH_FAILED",
	"UPSTREAM_ERROR",
	"UPSTREAM_INVALID_REQUEST",
	"UPSTREAM_NOT_FOUND",
	"UPSTREAM_QUOTA_EXHAUSTED",
	"UPSTREAM_RATE_LIMITED",
	"UPSTREAM_READ_FAILED",
	"UPSTREAM_REJECTED",
	"UPSTREAM_REQUEST_FAILED",
	"UPSTREAM_RESPONSE_TOO_LARGE",
	"UPSTREAM_TIMEOUT",
	"UPSTREAM_UNAVAILABLE",
	"UPSTREAM_URL_INVALID",
	"other",
}

// Gauges 是 scrape 时现算的聚合值。函数可为 nil（该项不输出）。
//
// 全部是「全站聚合的整数 / 秒数」：没有账号级、用户级明细。
type Gauges struct {
	// InflightActive 是当前所有账号的活跃请求数（accountruntime 汇总）。
	InflightActive func() int
	// AccountsCooling 是当前处于冷却期的账号数（accountruntime 汇总）。
	AccountsCooling func() int
	// UsageRingDropped 是 Go 侧用量环形缓冲累计丢弃条数。
	UsageRingDropped func() int64
	// UsageRingGap 是其中「没被任何 reader 取走就被覆盖」的真丢条数。
	UsageRingGap func() int64
	// QuotaSnapshotAgeSeconds 是余额快照距上次成功替换的秒数。
	QuotaSnapshotAgeSeconds func() float64
}

// Registry 是指标累加器。构造后并发安全。
type Registry struct {
	requests   [len(protocolLabels)][statusSlots]atomic.Uint64
	durationNs atomic.Uint64
	durationN  atomic.Uint64
	tokens     [tokenBucketCount]atomic.Uint64
	attempts   atomic.Uint64
	failures   [len(failureCodes)]atomic.Uint64
	gauges     Gauges
}

// New 构造累加器。gauges 里的函数可为 nil。
func New(gauges Gauges) *Registry {
	return &Registry{gauges: gauges}
}

// ObserveRequest 记一次 LLM 请求（协议 + 状态码 + 总耗时）。
func (r *Registry) ObserveRequest(protocol contracts.Protocol, status int, duration time.Duration) {
	if r == nil {
		return
	}
	if status < 100 || status >= statusSlots {
		// 真实 HTTP 状态码都 ≥ 100；0 / 越界值统一归到 500，避免出现 status="0" 这种标签。
		status = 500
	}
	r.requests[protocolIndex(protocol)][status].Add(1)
	r.durationNs.Add(uint64(duration.Nanoseconds()))
	r.durationN.Add(1)
}

// ObserveUsage 记一次请求的 token 四桶（已按上游协议归一化）。
func (r *Registry) ObserveUsage(usage contracts.Usage) {
	if r == nil {
		return
	}
	add := func(index int, value int) {
		if value > 0 {
			r.tokens[index].Add(uint64(value))
		}
	}
	add(0, usage.InputTokens)
	add(1, usage.OutputTokens)
	add(2, usage.CacheReadInputTokens)
	add(3, usage.CacheCreationInputTokens)
}

// ObserveAttempts 记本轮请求的上游尝试次数与失败码分布。
//
// 每个 AccountAttempt 是一次上游尝试：成功条目没有 Code，失败条目带稳定码。
func (r *Registry) ObserveAttempts(attempts []contracts.AccountAttempt) {
	if r == nil {
		return
	}
	for _, attempt := range attempts {
		r.attempts.Add(1)
		if attempt.Code == "" {
			continue
		}
		r.failures[failureIndex(attempt.Code)].Add(1)
	}
}

// Render 输出 Prometheus 文本格式（version 0.0.4）。只在 scrape 时调用。
func (r *Registry) Render() []byte {
	if r == nil {
		return nil
	}
	var builder strings.Builder

	builder.WriteString("# HELP dizzy_request_total LLM 请求数，按客户端协议与状态码分。\n")
	builder.WriteString("# TYPE dizzy_request_total counter\n")
	for index, protocol := range protocolLabels {
		for status := 100; status < statusSlots; status++ {
			count := r.requests[index][status].Load()
			if count == 0 {
				continue
			}
			fmt.Fprintf(&builder, "dizzy_request_total{protocol=%q,status=%q} %d\n",
				protocol, strconv.Itoa(status), count)
		}
	}

	builder.WriteString("# HELP dizzy_request_duration_seconds LLM 请求总耗时（秒）。\n")
	builder.WriteString("# TYPE dizzy_request_duration_seconds summary\n")
	fmt.Fprintf(&builder, "dizzy_request_duration_seconds_sum %s\n", secondsText(r.durationNs.Load()))
	fmt.Fprintf(&builder, "dizzy_request_duration_seconds_count %d\n", r.durationN.Load())

	builder.WriteString("# HELP dizzy_tokens_total 记账用 token 四桶（input 已按上游协议扣除缓存命中）。\n")
	builder.WriteString("# TYPE dizzy_tokens_total counter\n")
	for index, bucket := range tokenLabels {
		fmt.Fprintf(&builder, "dizzy_tokens_total{bucket=%q} %d\n", bucket, r.tokens[index].Load())
	}

	builder.WriteString("# HELP dizzy_upstream_attempt_total 上游尝试总数（每个账号一次尝试计一次）。\n")
	builder.WriteString("# TYPE dizzy_upstream_attempt_total counter\n")
	fmt.Fprintf(&builder, "dizzy_upstream_attempt_total %d\n", r.attempts.Load())

	builder.WriteString("# HELP dizzy_upstream_failure_total 上游尝试失败数，按稳定错误码分。\n")
	builder.WriteString("# TYPE dizzy_upstream_failure_total counter\n")
	for index, code := range failureCodes {
		fmt.Fprintf(&builder, "dizzy_upstream_failure_total{code=%q} %d\n", code, r.failures[index].Load())
	}

	r.renderGauges(&builder)
	return []byte(builder.String())
}

func (r *Registry) renderGauges(builder *strings.Builder) {
	writeGauge := func(name, help string, value func() float64) {
		if value == nil {
			return
		}
		fmt.Fprintf(builder, "# HELP %s %s\n", name, help)
		fmt.Fprintf(builder, "# TYPE %s gauge\n", name)
		fmt.Fprintf(builder, "%s %s\n", name, numberText(value()))
	}

	if r.gauges.InflightActive != nil {
		writeGauge("dizzy_inflight_active", "当前活跃的上游请求数（全站聚合）。",
			func() float64 { return float64(r.gauges.InflightActive()) })
	}
	if r.gauges.AccountsCooling != nil {
		writeGauge("dizzy_accounts_cooling", "当前处于冷却期的账号数（全站聚合）。",
			func() float64 { return float64(r.gauges.AccountsCooling()) })
	}
	if r.gauges.UsageRingDropped != nil {
		writeGauge("dizzy_usage_ring_dropped", "用量环形缓冲累计丢弃条数。",
			func() float64 { return float64(r.gauges.UsageRingDropped()) })
	}
	if r.gauges.UsageRingGap != nil {
		writeGauge("dizzy_usage_ring_gap", "用量环形缓冲累计真丢条数（未被任何 reader 取走就被覆盖）。",
			func() float64 { return float64(r.gauges.UsageRingGap()) })
	}
	if r.gauges.QuotaSnapshotAgeSeconds != nil {
		writeGauge("dizzy_quota_snapshot_age_seconds", "余额快照距上次成功替换的秒数。",
			func() float64 { return r.gauges.QuotaSnapshotAgeSeconds() })
	}
}

// protocolIndex 把客户端协议映射到固定枚举下标；未知值落 other。
func protocolIndex(protocol contracts.Protocol) int {
	for index, label := range protocolLabels {
		if label == string(protocol) {
			return index
		}
	}
	return len(protocolLabels) - 1
}

// failureIndex 把失败码映射到固定枚举下标；未知值落 other。
func failureIndex(code string) int {
	for index, label := range failureCodes {
		if label == code {
			return index
		}
	}
	return len(failureCodes) - 1
}

// secondsText 把纳秒渲染成秒（Prometheus 用浮点秒）。
func secondsText(nanoseconds uint64) string {
	return numberText(float64(nanoseconds) / float64(time.Second))
}

// numberText 用最短往返表示渲染浮点：整数不带小数点，避免出现 1.000000e+06 这种噪声。
func numberText(value float64) string {
	return strconv.FormatFloat(value, 'g', -1, 64)
}
