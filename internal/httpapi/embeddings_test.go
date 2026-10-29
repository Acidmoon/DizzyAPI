package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/modules/keyauth"
)

// POST /v1/embeddings：OpenAI 兼容、非流式、只有 OpenAI 兼容账号能处理。
// 它与 chat 同协议但路径不同，靠 contracts.Ctx.Operation 选上游路径。

const embeddingsResponseBody = `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.1,0.2]}],"model":"text-embedding-3-small","usage":{"prompt_tokens":8,"total_tokens":8}}`

type embeddingsUpstream struct {
	mu     sync.Mutex
	paths  []string
	bodies []string
}

func (u *embeddingsUpstream) record(r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	u.mu.Lock()
	defer u.mu.Unlock()
	u.paths = append(u.paths, r.URL.Path)
	u.bodies = append(u.bodies, string(raw))
}

func (u *embeddingsUpstream) last(t *testing.T) (string, string) {
	t.Helper()
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.paths) == 0 {
		t.Fatal("上游没有收到请求")
	}
	return u.paths[len(u.paths)-1], u.bodies[len(u.bodies)-1]
}

func (u *embeddingsUpstream) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.paths)
}

func newEmbeddingsUpstream(t *testing.T) (*embeddingsUpstream, *httptest.Server) {
	t.Helper()
	capture := &embeddingsUpstream{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.record(r)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, embeddingsResponseBody)
	}))
	t.Cleanup(server.Close)
	return capture, server
}

func TestEmbeddingsSingleAndArrayInput(t *testing.T) {
	capture, upstream := newEmbeddingsUpstream(t)
	world, sink := newUsageGateway(t, keyauth.Config{}, nil)
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "sk-emb",
		Protocol: "openai-chat", Priority: 1,
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	for _, body := range []string{
		`{"model":"text-embedding-3-small","input":"hello"}`,
		`{"model":"text-embedding-3-small","input":["a","b"]}`,
	} {
		recorder := postPath(t, world.handler, "/v1/embeddings", body)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s：期望 200，得到 %d：%s", body, recorder.Code, recorder.Body.String())
		}
		path, seenBody := capture.last(t)
		if path != "/v1/embeddings" {
			t.Fatalf("%s：上游路径 %q，期望 /v1/embeddings", body, path)
		}
		// 同协议直通：请求体逐字节不变。
		if seenBody != body {
			t.Fatalf("%s：请求体被改了：%q", body, seenBody)
		}
		// 响应也原样透传。
		if recorder.Body.String() != embeddingsResponseBody {
			t.Fatalf("%s：响应被改了：%s", body, recorder.Body.String())
		}
	}

	record := sink.all(t)
	if len(record) != 2 {
		t.Fatalf("期望 2 条用量记录，得到 %d", len(record))
	}
	for _, item := range record {
		if item.InputTokens != 8 || item.OutputTokens != 0 || item.CacheReadTokens != 0 || item.CacheWriteTokens != 0 {
			t.Fatalf("embeddings 四桶不符（只有 input）：%+v", item)
		}
		if item.TotalTokens != 8 {
			t.Fatalf("totalTokens = %d，期望 8", item.TotalTokens)
		}
		if item.Protocol != contracts.ProtocolOpenAIChat {
			t.Fatalf("客户端协议应为 openai-chat：%q", item.Protocol)
		}
		if item.Stream {
			t.Fatal("embeddings 不是流式请求")
		}
	}
}

// anthropic / gemini 账号没有 embeddings 端点：明确拒绝且不请求上游。
func TestEmbeddingsRejectsNonOpenAIAccounts(t *testing.T) {
	for _, protocol := range []string{"anthropic", "gemini"} {
		capture, upstream := newEmbeddingsUpstream(t)
		world, sink := newUsageGateway(t, keyauth.Config{}, nil)
		if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
			AccountID: "acc-1", Provider: "custom", Kind: "api_key", Token: "sk-x",
			Protocol: protocol, Priority: 1,
		})); err != nil {
			t.Fatalf("%s：Replace: %v", protocol, err)
		}

		recorder := postPath(t, world.handler, "/v1/embeddings",
			`{"model":"text-embedding-3-small","input":"hello"}`)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s：期望 400，得到 %d：%s", protocol, recorder.Code, recorder.Body.String())
		}
		if !strings.Contains(recorder.Body.String(), "MODEL_NOT_SUPPORTED") {
			t.Fatalf("%s：错误码不对：%s", protocol, recorder.Body.String())
		}
		if capture.count() != 0 {
			t.Fatalf("%s：不该请求上游，实际 %d 次", protocol, capture.count())
		}
		// 入口层就拒绝了（没进 engine），所以不产生用量记录——与其它 400 一致。
		if records := sink.all(t); len(records) != 0 {
			t.Fatalf("%s：入口拒绝不该留下用量记录：%+v", protocol, records)
		}
	}
}

func TestEmbeddingsRejectsInvalidInput(t *testing.T) {
	capture, upstream := newEmbeddingsUpstream(t)
	world, _ := newUsageGateway(t, keyauth.Config{}, nil)
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "sk-emb", Priority: 1,
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	bigList := `{"model":"m","input":[` + strings.Repeat(`"a",`, 2048) + `"a"]}`
	bigText := `{"model":"m","input":"` + strings.Repeat("a", embeddingsMaxInputChars+1) + `"}`

	cases := []struct {
		name   string
		body   string
		status int
		code   string
	}{
		{"缺 model", `{"input":"hi"}`, http.StatusBadRequest, "INVALID_REQUEST"},
		{"缺 input", `{"model":"m"}`, http.StatusBadRequest, "INVALID_REQUEST"},
		{"input 为 null", `{"model":"m","input":null}`, http.StatusBadRequest, "INVALID_REQUEST"},
		{"空字符串", `{"model":"m","input":""}`, http.StatusBadRequest, "INVALID_REQUEST"},
		{"空数组", `{"model":"m","input":[]}`, http.StatusBadRequest, "INVALID_REQUEST"},
		{"数组里有空串", `{"model":"m","input":["a",""]}`, http.StatusBadRequest, "INVALID_REQUEST"},
		{"数字", `{"model":"m","input":1}`, http.StatusBadRequest, "INVALID_REQUEST"},
		{"对象", `{"model":"m","input":{"a":1}}`, http.StatusBadRequest, "INVALID_REQUEST"},
		{"流式", `{"model":"m","input":"hi","stream":true}`, http.StatusBadRequest, "INVALID_REQUEST"},
		{"条数超限", bigList, http.StatusRequestEntityTooLarge, "INPUT_TOO_LARGE"},
		{"文本超限", bigText, http.StatusRequestEntityTooLarge, "INPUT_TOO_LARGE"},
	}
	for _, tc := range cases {
		recorder := postPath(t, world.handler, "/v1/embeddings", tc.body)
		if recorder.Code != tc.status {
			t.Fatalf("%s：期望 %d，得到 %d：%s", tc.name, tc.status, recorder.Code, recorder.Body.String())
		}
		if !strings.Contains(recorder.Body.String(), tc.code) {
			t.Fatalf("%s：期望错误码 %s，得到 %s", tc.name, tc.code, recorder.Body.String())
		}
	}
	if capture.count() != 0 {
		t.Fatalf("非法请求不该打到上游，实际 %d 次", capture.count())
	}
}

// failover 仍然生效：一个账号 5xx 后换另一个，两次都打 /v1/embeddings。
func TestEmbeddingsFailover(t *testing.T) {
	var mu sync.Mutex
	seen := make([]string, 0, 2)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.URL.Path+" "+r.Header.Get("Authorization"))
		attempt := len(seen)
		mu.Unlock()
		// 第一次尝试失败（5xx 可重试），第二次成功；账号排序由打分决定，不在这里断言。
		if attempt == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, `{"error":{"message":"boom"}}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, embeddingsResponseBody)
	}))
	defer upstream.Close()

	world, sink := newUsageGateway(t, keyauth.Config{}, nil)
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1",
		accounts.Account{
			AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "sk-first",
			Protocol: "openai-chat", Priority: 1,
		},
		accounts.Account{
			AccountID: "acc-2", Provider: "openai", Kind: "api_key", Token: "sk-second",
			Protocol: "openai-chat", Priority: 2,
		},
	)); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postPath(t, world.handler, "/v1/embeddings", `{"model":"m","input":"hi"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 {
		t.Fatalf("期望两次尝试，实际 %d：%v", len(seen), seen)
	}
	for _, item := range seen {
		if !strings.HasPrefix(item, "/v1/embeddings ") {
			t.Fatalf("failover 也必须打 /v1/embeddings：%v", seen)
		}
	}
	if seen[0] == seen[1] {
		t.Fatalf("failover 应该换账号：%v", seen)
	}
	if record := sink.single(t); record.Attempts != 2 {
		t.Fatalf("attempts = %d，期望 2", record.Attempts)
	}
}

// 响应必须是 OpenAI 的 embeddings 形状（不是 chat 的 choices）。
func TestEmbeddingsResponseShape(t *testing.T) {
	_, upstream := newEmbeddingsUpstream(t)
	world, _ := newUsageGateway(t, keyauth.Config{}, nil)
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "sk-emb", Priority: 1,
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	recorder := postPath(t, world.handler, "/v1/embeddings", `{"model":"m","input":"hi"}`)
	var payload struct {
		Object string `json:"object"`
		Data   []struct {
			Object    string    `json:"object"`
			Index     int       `json:"index"`
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是合法 JSON：%v", err)
	}
	if payload.Object != "list" || len(payload.Data) != 1 || payload.Data[0].Object != "embedding" {
		t.Fatalf("响应形状不对：%+v", payload)
	}
	if len(payload.Data[0].Embedding) != 2 {
		t.Fatalf("embedding 向量不对：%+v", payload.Data[0])
	}
}
