package main

import (
	"testing"
)

func TestParseGlobals(t *testing.T) {
	cases := []struct {
		name     string
		args     []string
		want     globalFlags
		wantRest []string
	}{
		{
			name:     "没有全局参数",
			args:     []string{"chat", "-m", "x"},
			want:     globalFlags{},
			wantRest: []string{"chat", "-m", "x"},
		},
		{
			name:     "全局参数在子命令前",
			args:     []string{"--json", "chat", "-m", "x"},
			want:     globalFlags{JSON: true},
			wantRest: []string{"chat", "-m", "x"},
		},
		{
			name:     "全局参数在子命令后",
			args:     []string{"chat", "--json"},
			want:     globalFlags{JSON: true},
			wantRest: []string{"chat"},
		},
		{
			name:     "空格分隔的 base",
			args:     []string{"--base", "http://127.0.0.1:7791", "health"},
			want:     globalFlags{Base: "http://127.0.0.1:7791"},
			wantRest: []string{"health"},
		},
		{
			name:     "等号分隔的 base",
			args:     []string{"--base=http://127.0.0.1:7791", "health"},
			want:     globalFlags{Base: "http://127.0.0.1:7791"},
			wantRest: []string{"health"},
		},
		{
			name:     "timeout 与 key 与 verbose",
			args:     []string{"--timeout", "5", "--key", "sk-test", "--verbose", "models"},
			want:     globalFlags{Timeout: 5, Key: "sk-test", Verbose: true},
			wantRest: []string{"models"},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			globals, rest, err := parseGlobals(testCase.args)
			if err != nil {
				t.Fatalf("解析失败：%v", err)
			}
			if globals != testCase.want {
				t.Fatalf("全局参数不一致：%+v != %+v", globals, testCase.want)
			}
			if len(rest) != len(testCase.wantRest) {
				t.Fatalf("剩余参数长度不一致：%v != %v", rest, testCase.wantRest)
			}
			for index := range rest {
				if rest[index] != testCase.wantRest[index] {
					t.Fatalf("剩余参数不一致：%v != %v", rest, testCase.wantRest)
				}
			}
		})
	}
}

func TestParseGlobalsMissingValue(t *testing.T) {
	_, _, err := parseGlobals([]string{"--base"})
	if err == nil {
		t.Fatal("缺少参数值必须明确失败")
	}
}

func TestParseGlobalsBadTimeout(t *testing.T) {
	for _, value := range []string{"0", "-1", "abc", "1.5", "99999"} {
		_, _, err := parseGlobals([]string{"--timeout", value})
		if err == nil {
			t.Fatalf("timeout %q 应被拒绝", value)
		}
	}
}

func TestLookupCommand(t *testing.T) {
	for _, name := range []string{"login", "logout", "whoami", "health", "chat", "models", "usage", "keys", "config", "admin"} {
		if _, ok := lookupCommand(name); !ok {
			t.Fatalf("缺少子命令 %q", name)
		}
	}
	if _, ok := lookupCommand("nope"); ok {
		t.Fatal("不存在的子命令不该被找到")
	}
}

// TestEveryCommandHasHelp 断言每个子命令都有说明与用法（owner 验收清单要求）。
func TestEveryCommandHasHelp(t *testing.T) {
	for _, item := range registry() {
		if item.Name == "" {
			t.Fatal("子命令必须有名字")
		}
		if item.Summary == "" {
			t.Fatalf("子命令 %q 缺少 Summary", item.Name)
		}
		if item.Usage == "" {
			t.Fatalf("子命令 %q 缺少 Usage", item.Name)
		}
		if item.Example == "" {
			t.Fatalf("子命令 %q 缺少 Example", item.Name)
		}
		if item.Run == nil {
			t.Fatalf("子命令 %q 缺少 Run", item.Name)
		}
	}
}

func TestParsePositiveInt(t *testing.T) {
	if value, err := parsePositiveInt("x", "30"); err != nil || value != 30 {
		t.Fatalf("解析 30 失败：%v %v", value, err)
	}
	for _, bad := range []string{"", "0", "-1", "abc", "1.0", "3601"} {
		if _, err := parsePositiveInt("x", bad); err == nil {
			t.Fatalf("%q 应被拒绝", bad)
		}
	}
}

// TestSplitFlag 断言 flag 名字拆分。
func TestSplitFlag(t *testing.T) {
	cases := []struct {
		argument  string
		wantName  string
		wantValue string
		wantHas   bool
	}{
		{"--base", "--base", "", false},
		{"--base=abc", "--base", "abc", true},
		{"--base=", "--base", "", true},
		{"-m", "-m", "", false},
		{"positional", "positional", "", false},
	}
	for _, testCase := range cases {
		name, value, has := splitFlag(testCase.argument)
		if name != testCase.wantName || value != testCase.wantValue || has != testCase.wantHas {
			t.Fatalf("%q 拆分结果不对：(%q, %q, %v)", testCase.argument, name, value, has)
		}
	}
}
