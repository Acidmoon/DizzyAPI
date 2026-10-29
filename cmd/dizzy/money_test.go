package main

import (
	"testing"
)

// TestFormatMicros 断言整数微元 → 元的渲染。
//
// 全程整数运算，不出现浮点（AGENTS.md §2.4.3）。
func TestFormatMicros(t *testing.T) {
	cases := []struct {
		micros string
		want   string
	}{
		{"0", "0 元"},
		{"1000000", "1 元"},
		{"1500000", "1.5 元"},
		{"1234567", "1.234567 元"},
		{"1", "0.000001 元"},
		{"123", "0.000123 元"},
		{"100000000", "100 元"},
		// 超出 float64 精确整数范围的金额：仍然精确。
		{"9007199254740993", "9007199254.740993 元"},
		// 负余额（后付费允许）：不能显示成正数。
		{"-1000000", "-1 元"},
		{"-500000", "-0.5 元"},
		// 解析不了就原样返回并标注单位，**不静默当 0**。
		{"abc", "abc 微元"},
		{"", " 微元"},
	}
	for _, testCase := range cases {
		t.Run(testCase.micros, func(t *testing.T) {
			got := formatMicros(testCase.micros)
			if got != testCase.want {
				t.Fatalf("formatMicros(%q) = %q，期望 %q", testCase.micros, got, testCase.want)
			}
		})
	}
}

func TestAddMicros(t *testing.T) {
	cases := []struct {
		left  string
		right string
		want  string
	}{
		{"0", "0", "0"},
		{"1000000", "500000", "1500000"},
		{"123456789", "1", "123456790"},
		// 负数相加。
		{"-100", "100", "0"},
		{"-100", "-50", "-150"},
		// 任一边坏掉就原样返回左边（不静默当 0 —— 那是账目错误）。
		{"abc", "100", "abc"},
		{"100", "abc", "100"},
	}
	for _, testCase := range cases {
		got := addMicros(testCase.left, testCase.right)
		if got != testCase.want {
			t.Fatalf("addMicros(%q, %q) = %q，期望 %q",
				testCase.left, testCase.right, got, testCase.want)
		}
	}
}

// TestAddMicrosNoFloatLoss 断言大额累加不丢精度（float64 会）。
func TestAddMicrosNoFloatLoss(t *testing.T) {
	// float64 在 2^53 之后无法表示相邻整数。
	left := "9007199254740993"
	right := "1"
	want := "9007199254740994"
	if got := addMicros(left, right); got != want {
		t.Fatalf("大额累加丢精度：%q != %q", got, want)
	}
}

// TestTrimFraction 断言小数尾零处理。
func TestTrimFraction(t *testing.T) {
	cases := map[string]string{
		"1.000000": "1",
		"1.500000": "1.5",
		"1.234567": "1.234567",
		"10":       "10",
		"0.000001": "0.000001",
	}
	for input, want := range cases {
		if got := trimFraction(input); got != want {
			t.Fatalf("trimFraction(%q) = %q，期望 %q", input, got, want)
		}
	}
}

func TestNetInputExcludesCache(t *testing.T) {
	// OpenAI 的 prompt_tokens **含**缓存；网关记账的 input **不含**缓存。
	usage := &chatUsage{
		PromptTokens: 100,
		PromptTokensDetails: &struct {
			CachedTokens int `json:"cached_tokens"`
		}{CachedTokens: 30},
	}
	if got := usage.netInput(); got != 70 {
		t.Fatalf("净输入应为 70，得到 %d", got)
	}
	if got := usage.cacheRead(); got != 30 {
		t.Fatalf("缓存读应为 30，得到 %d", got)
	}

	// 没有 prompt_tokens_details 时 cacheRead 是 0，netInput 就是 prompt_tokens。
	bare := &chatUsage{PromptTokens: 50}
	if got := bare.cacheRead(); got != 0 {
		t.Fatalf("没有 details 时缓存读应为 0，得到 %d", got)
	}
	if got := bare.netInput(); got != 50 {
		t.Fatalf("净输入应为 50，得到 %d", got)
	}

	// nil 不能 panic。
	var nilUsage *chatUsage
	if got := nilUsage.netInput(); got != 0 {
		t.Fatalf("nil 的净输入应为 0，得到 %d", got)
	}
}

func TestGroupByKey(t *testing.T) {
	rows := []usageRow{
		{APIKeyName: "alpha", TotalTokens: 10, InputTokens: 5, OutputTokens: 5, CostMicros: "100"},
		{APIKeyName: "alpha", TotalTokens: 20, InputTokens: 10, OutputTokens: 10, CostMicros: "200"},
		{APIKeyName: "beta", TotalTokens: 5, InputTokens: 2, OutputTokens: 3, CostMicros: "50"},
		// 没有名字的用 id 兜底。
		{APIKeyID: "key-123", TotalTokens: 1, CostMicros: "1"},
		// 连 id 都没有：给一个人话占位。
		{TotalTokens: 2, CostMicros: "2"},
	}
	groups := groupByKey(rows)
	if len(groups) != 4 {
		t.Fatalf("应有 4 组，得到 %d", len(groups))
	}
	if groups[0].name != "alpha" {
		t.Fatalf("第一组应为 alpha，得到 %q", groups[0].name)
	}
	if groups[0].totals.Requests != 2 {
		t.Fatalf("alpha 应有 2 条请求，得到 %d", groups[0].totals.Requests)
	}
	if groups[0].totals.Tokens != 30 {
		t.Fatalf("alpha 应有 30 token，得到 %d", groups[0].totals.Tokens)
	}
	if groups[0].totals.CostMicros != "300" {
		t.Fatalf("alpha 费用应为 300 微元，得到 %q", groups[0].totals.CostMicros)
	}
	if groups[2].name != "key-123" {
		t.Fatalf("无名字时应用 id 兜底，得到 %q", groups[2].name)
	}
	if groups[3].name != "（无 key）" {
		t.Fatalf("无 id 时应给占位，得到 %q", groups[3].name)
	}
}
