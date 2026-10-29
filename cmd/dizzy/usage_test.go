package main

import "testing"

// TestCountCSVRowsStripsBOM 断言数行时能吃掉服务端 CSV 开头的 BOM。
//
// 服务端导出是 `\ufeff` + 表头（packages/api/src/http.ts:3613），不剥 BOM 的话
// 表头首字段会变成 "\ufefftime"；行数本身不受影响，但这是「解析前先归一」的契约。
func TestCountCSVRowsStripsBOM(t *testing.T) {
	content := "\ufefftime,model,cost_micros\r\n" +
		"2026-10-29T12:00:00Z,deepseek-flash,570\r\n" +
		"2026-10-29T12:00:01Z,deepseek-flash,570\r\n"
	if got := countCSVRows(content); got != 2 {
		t.Fatalf("数据行数应为 2，得到 %d", got)
	}
}

// TestCountCSVRowsKeepsFormulaPrefix 断言带防公式注入前导 `'` 的单元格照常数出来。
//
// 服务端会给 `= + - @` 开头的单元格加前导 `'`（packages/api/src/http.ts:3645），
// 含引号的再按 RFC 4180 转义成 `""` 并整体加引号。CLI 只数行、不还原单元格值
// （CSV 原样透传给 Excel），所以这里断言的是「加了这两个装饰也不会把一行拆坏」。
func TestCountCSVRowsKeepsFormulaPrefix(t *testing.T) {
	// 第 1 行是简单公式前缀；第 2 行是「带引号的公式」——服务端真实输出形如
	// `"'=HYPERLINK(""http://x"")"`（外层引号 + 内部引号翻倍）。
	content := "\ufefftime,model,cost_micros\r\n" +
		"2026-10-29T12:00:00Z,'=1+1,570\r\n" +
		"2026-10-29T12:00:01Z,\"'=HYPERLINK(\"\"http://x\"\")\",570\r\n" +
		"2026-10-29T12:00:02Z,deepseek-flash,570\r\n"
	if got := countCSVRows(content); got != 3 {
		t.Fatalf("数据行数应为 3，得到 %d", got)
	}
}

// TestCountCSVRowsHeaderOnly 断言只有表头时是 0 行（不是 -1）。
func TestCountCSVRowsHeaderOnly(t *testing.T) {
	if got := countCSVRows("\ufefftime,model,cost_micros\r\n"); got != 0 {
		t.Fatalf("只有表头时应为 0 行，得到 %d", got)
	}
}

// TestStripBOM 断言只剥开头那一个 BOM，别的不动。
func TestStripBOM(t *testing.T) {
	cases := map[string]string{
		"\ufeffabc": "abc",
		"abc":       "abc",
		"a\ufeffbc": "a\ufeffbc",
		"":          "",
	}
	for input, want := range cases {
		if got := stripBOM(input); got != want {
			t.Fatalf("stripBOM(%q) = %q，应为 %q", input, got, want)
		}
	}
}
