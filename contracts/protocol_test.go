package contracts

import (
	"encoding/json"
	"testing"
)

func TestRenderErrorOpenAIShape(t *testing.T) {
	cases := []struct {
		status int
		want   string
	}{
		{400, "invalid_request_error"},
		{401, "authentication_error"},
		{403, "authentication_error"},
		{404, "invalid_request_error"},
		{429, "rate_limit_error"},
		{500, "server_error"},
		{502, "server_error"},
	}
	for _, tc := range cases {
		body := RenderError(ProtocolOpenAIChat, tc.status, "CODE", "msg")
		var payload struct {
			Error struct {
				Message string `json:"message"`
				Type    string `json:"type"`
				Code    string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("状态 %d 不是合法 JSON：%v", tc.status, err)
		}
		if payload.Error.Type != tc.want || payload.Error.Code != "CODE" || payload.Error.Message != "msg" {
			t.Fatalf("状态 %d 渲染不对：%s", tc.status, body)
		}
	}
}

func TestRenderErrorEmptyProtocolMatchesOpenAI(t *testing.T) {
	empty := RenderError(Protocol(""), 400, "CODE", "msg")
	openai := RenderError(ProtocolOpenAIChat, 400, "CODE", "msg")
	if string(empty) != string(openai) {
		t.Fatalf("空协议必须与 openai-chat 同形状：%s vs %s", empty, openai)
	}
}

func TestRenderErrorAnthropicShape(t *testing.T) {
	cases := []struct {
		status int
		want   string
	}{
		{400, "invalid_request_error"},
		{401, "authentication_error"},
		{403, "permission_error"},
		{404, "not_found_error"},
		{429, "rate_limit_error"},
		{500, "api_error"},
		{503, "api_error"},
	}
	for _, tc := range cases {
		body := RenderError(ProtocolAnthropic, tc.status, "CODE", "msg")
		var payload struct {
			Type  string `json:"type"`
			Error struct {
				Type    string `json:"type"`
				Message string `json:"message"`
				Code    string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("状态 %d 不是合法 JSON：%v", tc.status, err)
		}
		if payload.Type != "error" || payload.Error.Type != tc.want || payload.Error.Message != "msg" {
			t.Fatalf("Anthropic 状态 %d 渲染不对：%s", tc.status, body)
		}
		if payload.Error.Code != "CODE" {
			t.Fatalf("Anthropic 状态 %d 的 error.code 应为 CODE：%s", tc.status, body)
		}
	}
}

func TestRenderErrorNormalizesOutOfRangeStatus(t *testing.T) {
	// 200 / 600 一律按 500 渲染。
	if got := string(RenderError(ProtocolOpenAIChat, 200, "CODE", "msg")); !contains(got, "server_error") {
		t.Fatalf("越界状态应按 500：%s", got)
	}
	if got := string(RenderError(ProtocolOpenAIChat, 600, "CODE", "msg")); !contains(got, "server_error") {
		t.Fatalf("越界状态应按 500：%s", got)
	}
}

// TestRenderErrorAnthropicCarriesStableCode 守住 owner 2026-10-29 拍板的 B 方案：
// anthropic 错误体在 `error` 对象里多一个 `code`，稳定码原样输出（英文、不本地化），
// 客户端因此能机器可读地区分网关拒因（闸门饱和 / 全冷却 / 无可用账号）。
func TestRenderErrorAnthropicCarriesStableCode(t *testing.T) {
	body := RenderError(ProtocolAnthropic, 503, CodeAllAccountsSaturated, "所有账号都已达到并发上限")
	var payload struct {
		Type  string `json:"type"`
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("不是合法 JSON：%v（%s）", err, body)
	}
	if payload.Error.Code != CodeAllAccountsSaturated {
		t.Fatalf("error.code 应为 %s，得到 %q：%s", CodeAllAccountsSaturated, payload.Error.Code, body)
	}
	// 回归：顶层形状与 error.type 映射一个都不能变，防止 code 放错层。
	if payload.Type != "error" || payload.Error.Type != "api_error" {
		t.Fatalf("顶层形状或 error.type 被改动了：%s", body)
	}
	// 回归：顶层不能出现 code（它只能待在 error 对象里）。
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("不是合法 JSON：%v", err)
	}
	if _, ok := raw["code"]; ok {
		t.Fatalf("code 不许出现在顶层：%s", body)
	}
	if len(raw) != 2 {
		t.Fatalf("顶层只允许 type / error 两个键：%s", body)
	}
}

// TestRenderErrorAnthropicOmitsEmptyCode：内部没有稳定码时不输出 `"code":""`，
// 老客户端看到的字节形状与改动前一致。
func TestRenderErrorAnthropicOmitsEmptyCode(t *testing.T) {
	body := RenderError(ProtocolAnthropic, 500, "", "网关内部错误")
	var payload struct {
		Error map[string]json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("不是合法 JSON：%v（%s）", err, body)
	}
	if _, ok := payload.Error["code"]; ok {
		t.Fatalf("空 code 不许输出该字段：%s", body)
	}
	if len(payload.Error) != 2 {
		t.Fatalf("error 对象只允许 type / message 两个键：%s", body)
	}
}

// TestRenderErrorOpenAIBytesUnchanged 逐字节守住 OpenAI 两个入口的错误体：
// B 方案只动 anthropic 分支，openai 分支一个字节都不能变（空 code 仍按老行为输出）。
func TestRenderErrorOpenAIBytesUnchanged(t *testing.T) {
	cases := []struct {
		status int
		code   string
		want   string
	}{
		{400, "CODE", `{"error":{"code":"CODE","message":"msg","type":"invalid_request_error"}}`},
		{401, "CODE", `{"error":{"code":"CODE","message":"msg","type":"authentication_error"}}`},
		{429, "UPSTREAM_QUOTA_EXHAUSTED", `{"error":{"code":"UPSTREAM_QUOTA_EXHAUSTED","message":"msg","type":"rate_limit_error"}}`},
		{503, CodeAllAccountsSaturated, `{"error":{"code":"ALL_ACCOUNTS_SATURATED","message":"msg","type":"server_error"}}`},
		{503, CodeAllAccountsCooling, `{"error":{"code":"ALL_ACCOUNTS_COOLING","message":"msg","type":"server_error"}}`},
		{500, "", `{"error":{"code":"","message":"msg","type":"server_error"}}`},
	}
	for _, tc := range cases {
		for _, protocol := range []Protocol{ProtocolOpenAIChat, ProtocolOpenAIResponses} {
			got := string(RenderError(protocol, tc.status, tc.code, "msg"))
			if got != tc.want {
				t.Fatalf("%s 状态 %d 错误体字节变了：\n得到 %s\n期望 %s", protocol, tc.status, got, tc.want)
			}
		}
	}
}

// TestRenderErrorGeminiKeepsOfficialShape：Gemini 官方 schema 的 `code` 是整数
// HTTP 状态、`status` 是 Google 枚举名；网关稳定码只以 `reason` 增量出现，
// 空码时不输出该键（老客户端看到的形状不变）。
func TestRenderErrorGeminiKeepsOfficialShape(t *testing.T) {
	body := RenderError(ProtocolGemini, 503, CodeAllAccountsSaturated, "msg")
	var payload struct {
		Error map[string]json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("不是合法 JSON：%v（%s）", err, body)
	}
	if got := string(payload.Error["code"]); got != "503" {
		t.Fatalf("error.code 必须是整数 HTTP 状态：%s", got)
	}
	if got := string(payload.Error["status"]); got != `"UNAVAILABLE"` {
		t.Fatalf("error.status 不对：%s", got)
	}
	if got := string(payload.Error["reason"]); got != `"`+CodeAllAccountsSaturated+`"` {
		t.Fatalf("error.reason 不对：%s", got)
	}
	if _, ok := payload.Error["type"]; ok {
		t.Fatalf("Gemini 错误体不该带 Anthropic 的 type 键：%s", body)
	}

	empty := RenderError(ProtocolGemini, 500, "", "msg")
	var plain struct {
		Error map[string]json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(empty, &plain); err != nil {
		t.Fatalf("不是合法 JSON：%v（%s）", err, empty)
	}
	if _, ok := plain.Error["reason"]; ok {
		t.Fatalf("空 code 不许输出 reason：%s", empty)
	}
	if len(plain.Error) != 3 {
		t.Fatalf("error 对象只允许 code / message / status 三个键：%s", empty)
	}
}

func TestProtocolIsOpenAI(t *testing.T) {
	if !ProtocolOpenAIChat.IsOpenAI() || !ProtocolOpenAIResponses.IsOpenAI() {
		t.Fatal("openai 族应报告 true")
	}
	if ProtocolAnthropic.IsOpenAI() || Protocol("").IsOpenAI() {
		t.Fatal("非 openai 协议应报告 false")
	}
}

func contains(haystack, needle string) bool {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return true
		}
	}
	return false
}
