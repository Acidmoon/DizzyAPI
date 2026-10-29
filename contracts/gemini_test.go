package contracts_test

import (
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Gemini 模型名归一：官方 REST 形状是 `{model=models/*}`，客户端也可能传裸名。
// 两种都接受，内部统一成裸名；只剥一层，剥完仍非法就明确失败。

func TestNormalizeGeminiModelName(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
		ok   bool
	}{
		{"裸名", "gemini-2.0-flash", "gemini-2.0-flash", true},
		{"官方形状带 models/", "models/gemini-2.0-flash", "gemini-2.0-flash", true},
		{"首尾空白", "  models/gemini-2.0-flash \t", "gemini-2.0-flash", true},
		{"点与冒号合法", "gemini-2.5-flash:latest", "gemini-2.5-flash:latest", true},
		{"长度上限内", strings.Repeat("a", contracts.GeminiMaxModelNameLength), strings.Repeat("a", contracts.GeminiMaxModelNameLength), true},

		{"空串", "", "", false},
		{"只有 models/", "models/", "", false},
		{"只剥一层", "models/models/x", "", false},
		{"剥完仍带斜杠", "models/a/b", "", false},
		{"裸名带斜杠", "a/b", "", false},
		{"反斜杠", "a\\b", "", false},
		{"问号", "a?b", "", false},
		{"井号", "a#b", "", false},
		{"NUL", "a\x00b", "", false},
		{"超长", strings.Repeat("a", contracts.GeminiMaxModelNameLength+1), "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := contracts.NormalizeGeminiModelName(tc.raw)
			if tc.ok {
				if err != nil {
					t.Fatalf("应接受 %q，得到错误 %v", tc.raw, err)
				}
				if got != tc.want {
					t.Fatalf("归一结果 %q，期望 %q", got, tc.want)
				}
				return
			}
			if err == nil {
				t.Fatalf("应拒绝 %q，得到 %q", tc.raw, got)
			}
			if got != "" {
				t.Fatalf("拒绝时不该返回模型名：%q", got)
			}
		})
	}
}

func TestNormalizeGeminiModelNameRejectsTraversal(t *testing.T) {
	// 路径穿越与双层前缀是这里唯一的重点：拼进 URL 前必须挡住。
	for _, raw := range []string{"a/../b", "models/models/x", "models/models/models/x"} {
		if got, err := contracts.NormalizeGeminiModelName(raw); err == nil {
			t.Fatalf("%q 必须被拒绝，得到 %q", raw, got)
		}
	}
}
