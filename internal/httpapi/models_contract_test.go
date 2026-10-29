package httpapi

// /v1/models 的契约守卫。
//
// 为什么单独一个文件：它是**产品面刻意不动**的那条路由。`/api/models`（TS 侧）才是
// 带价格与可用性的目录；`/v1/models` 是 LLM 入口，给客户端做模型发现用，
// 既有形状（OpenAI 的 `{object:"list", data:[{id,object,created,owned_by}]}`）必须
// 保持不变——多一个键就是契约变更，要先过 owner。
//
// 这条用例钉住「键集合」而不是整段字节：`created` 是进程启动时间，逐字节比较会随
// 运行时间漂移；键集合变了才是真的契约变了。

import (
	"encoding/json"
	"net/http"
	"sort"
	"testing"

	"github.com/Acidmoon/DizzyAPI/modules/keyauth"
)

func TestModelsContractHasNoExtraKeys(t *testing.T) {
	world := newGateway(t, "http://127.0.0.1:1", keyauth.Config{})
	if _, err := world.accounts.Replace(snapshot("http://127.0.0.1:1",
		modelsWith("acc-1", "b-model", "a-model"),
	)); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := getModels(t, world.handler, "gateway-key")
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}

	var top map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &top); err != nil {
		t.Fatalf("响应不是 JSON 对象：%v", err)
	}
	if got := sortedKeys(top); !equalStrings(got, []string{"data", "object"}) {
		t.Fatalf("顶层键被改动：%v（只允许 data / object）", got)
	}

	var data []map[string]json.RawMessage
	if err := json.Unmarshal(top["data"], &data); err != nil {
		t.Fatalf("data 不是数组：%v", err)
	}
	if len(data) != 2 {
		t.Fatalf("期望 2 条模型，得到 %d", len(data))
	}
	for _, entry := range data {
		if got := sortedKeys(entry); !equalStrings(got, []string{"created", "id", "object", "owned_by"}) {
			t.Fatalf("模型条目键被改动：%v（只允许 created / id / object / owned_by）", got)
		}
	}

	// 排序稳定（字典序），客户端做 diff 时不会误判。
	var ids []string
	for _, entry := range data {
		var id string
		if err := json.Unmarshal(entry["id"], &id); err != nil {
			t.Fatalf("id 不是字符串：%v", err)
		}
		ids = append(ids, id)
	}
	if !sort.StringsAreSorted(ids) {
		t.Fatalf("模型名应稳定排序：%v", ids)
	}
}

func sortedKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}
