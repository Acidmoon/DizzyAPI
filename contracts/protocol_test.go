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
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("状态 %d 不是合法 JSON：%v", tc.status, err)
		}
		if payload.Type != "error" || payload.Error.Type != tc.want || payload.Error.Message != "msg" {
			t.Fatalf("Anthropic 状态 %d 渲染不对：%s", tc.status, body)
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
