package transport

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// 客户端指纹（client mask）的护栏。
//
// 这一组用例要证明三件事，缺一件这个功能就不该上线：
//  1. **真的改了头**：假上游在服务端亲眼看到 `x-opencode-session`（不是「我们以为写了」）；
//  2. **模板语义对**：`{{session}}` 同账号同对话稳定、不同账号不同；`{{uuid}}` 两次不同；
//  3. **保护名单有效**：档案写 `Authorization` / `Accept` / `Host` 也顶不掉网关自己写的值。

// newMaskStage 构造一个带客户端指纹的 transport 阶段。假上游地址由调用方给。
func newMaskStage(t *testing.T, baseURL, token string, credential contracts.AccountCredential) *Stage {
	t.Helper()
	credential.AccountID = "acc-1"
	credential.Provider = "openai"
	credential.Kind = "api_key"
	credential.BaseURL = baseURL
	credential.AccessToken = token
	stage, err := New(Config{}, staticSource{"acc-1": credential}, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return stage
}

// maskCtx 是一份带「首条 user 消息」的请求上下文（session 就是按它算的）。
func maskCtx(text string) *contracts.Ctx {
	ctx := requestContext(false)
	ctx.Body = contracts.BytesBody([]byte(
		`{"model":"gpt-test","messages":[{"role":"user","content":"` + text + `"}]}`,
	))
	return ctx
}

func TestClientMaskHeadersReachUpstream(t *testing.T) {
	var seenSession string
	var seenClient string
	var seenAgent string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenSession = r.Header.Get("x-opencode-session")
		seenClient = r.Header.Get("x-opencode-client")
		seenAgent = r.Header.Get("User-Agent")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[]}`))
	}))
	defer upstream.Close()

	stage := newMaskStage(t, upstream.URL, "sk-account-token", contracts.AccountCredential{
		ClientUserAgent: "opencode/0.4.2 (cli; linux x64)",
		ClientHeaders: []contracts.AccountHeader{
			{Name: "x-opencode-session", Value: contracts.PlaceholderSession},
			{Name: "x-opencode-client", Value: "cli"},
		},
	})

	if _, err := stage.Run(maskCtx("请把这段代码改成 Go")); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if seenSession == "" {
		t.Fatal("上游没收到 x-opencode-session —— 这就是 owner 撞到的那个 400")
	}
	if len(seenSession) != 32 {
		t.Fatalf("session id 形状不对：%q", seenSession)
	}
	if seenClient != "cli" {
		t.Fatalf("静态头值没贴上去：%q", seenClient)
	}
	if seenAgent != "opencode/0.4.2 (cli; linux x64)" {
		t.Fatalf("UA 没被档案覆盖：%q", seenAgent)
	}
}

func TestClientMaskSessionIsStableAndScoped(t *testing.T) {
	sessions := make([]string, 0, 3)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sessions = append(sessions, r.Header.Get("x-opencode-session"))
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	credential := contracts.AccountCredential{
		ClientHeaders: []contracts.AccountHeader{
			{Name: "x-opencode-session", Value: contracts.PlaceholderSession},
		},
	}
	stage := newMaskStage(t, upstream.URL, "sk-token", credential)

	// 同一段对话（首条用户消息一样）两次请求 → 同一个 session。
	for i := 0; i < 2; i++ {
		if _, err := stage.Run(maskCtx("同一段对话")); err != nil {
			t.Fatalf("Run: %v", err)
		}
	}
	// 换一段对话 → 换 session。
	if _, err := stage.Run(maskCtx("另一段对话")); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(sessions) != 3 {
		t.Fatalf("期望 3 次请求，实际 %d", len(sessions))
	}
	if sessions[0] != sessions[1] {
		t.Fatalf("同一段对话的 session 应该稳定：%q vs %q", sessions[0], sessions[1])
	}
	if sessions[2] == sessions[0] {
		t.Fatalf("不同对话不该共用 session：%q", sessions[2])
	}

	// 换账号（同样的对话）→ 必须不同：session 是按「账号 + 首条消息」算的。
	if got, want := sessionIDFor("acc-2", []byte(`{"messages":[{"role":"user","content":"同一段对话"}]}`)),
		sessionIDFor("acc-1", []byte(`{"messages":[{"role":"user","content":"同一段对话"}]}`)); got == want {
		t.Fatalf("不同账号不该共用 session：%q", got)
	}
}

func TestClientMaskUUIDAndTimestamp(t *testing.T) {
	values := make([]string, 0, 2)
	timestamps := make([]string, 0, 2)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		values = append(values, r.Header.Get("x-request-id"))
		timestamps = append(timestamps, r.Header.Get("x-request-at"))
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	stage := newMaskStage(t, upstream.URL, "sk-token", contracts.AccountCredential{
		ClientHeaders: []contracts.AccountHeader{
			{Name: "x-request-id", Value: contracts.PlaceholderUUID},
			{Name: "x-request-at", Value: "t={{timestamp}}"},
		},
	})
	for i := 0; i < 2; i++ {
		if _, err := stage.Run(maskCtx("hi")); err != nil {
			t.Fatalf("Run: %v", err)
		}
	}
	if len(values) != 2 {
		t.Fatalf("期望 2 次请求，实际 %d", len(values))
	}
	if values[0] == "" || values[0] == values[1] {
		t.Fatalf("{{uuid}} 每次请求都该不同：%q vs %q", values[0], values[1])
	}
	// 36 字符带连字符 = RFC 4122 v4 形状。
	if len(values[0]) != 36 || strings.Count(values[0], "-") != 4 {
		t.Fatalf("uuid 形状不对：%q", values[0])
	}
	if !strings.HasPrefix(timestamps[0], "t=") || len(timestamps[0]) < 15 {
		t.Fatalf("时间戳没展开或前缀丢了：%q", timestamps[0])
	}
}

func TestClientMaskNeverOverridesProtectedHeaders(t *testing.T) {
	var seenAuthorization string
	var seenAccept string
	var seenContentType string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuthorization = r.Header.Get("Authorization")
		seenAccept = r.Header.Get("Accept")
		seenContentType = r.Header.Get("Content-Type")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	// 档案里塞满受保护头：装载阶段本该拒绝，这里直接构造到 transport 层验证「第二道闸」。
	stage := newMaskStage(t, upstream.URL, "sk-account-token", contracts.AccountCredential{
		ClientUserAgent: "spoofed-agent/1.0",
		ClientHeaders: []contracts.AccountHeader{
			{Name: "Authorization", Value: "Bearer attacker-token"},
			{Name: "Accept", Value: "text/html"},
			{Name: "Content-Type", Value: "text/plain"},
			{Name: "x-extra", Value: "kept"},
		},
	})

	if _, err := stage.Run(maskCtx("hi")); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if seenAuthorization != "Bearer sk-account-token" {
		t.Fatalf("鉴定头被档案顶掉了：%q", seenAuthorization)
	}
	if seenAccept == "text/html" {
		t.Fatalf("Accept 被档案顶掉了：%q", seenAccept)
	}
	if seenContentType == "text/plain" {
		t.Fatalf("Content-Type 被档案顶掉了：%q", seenContentType)
	}
}

func TestFirstUserTextAcrossProtocols(t *testing.T) {
	cases := map[string]string{
		"openai-chat": `{"messages":[{"role":"system","content":"sys"},{"role":"user","content":"你好"}]}`,
		"anthropic":   `{"system":"sys","messages":[{"role":"user","content":[{"type":"text","text":"你好"}]}]}`,
		"gemini":      `{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}`,
		"responses":   `{"input":[{"role":"user","content":[{"type":"input_text","text":"你好"}]}]}`,
	}
	for name, body := range cases {
		if got := firstUserText([]byte(body)); got != "你好" {
			t.Fatalf("%s：首条用户消息取错了：%q", name, got)
		}
	}

	// 拿不到就返回空串（调用方退化成「按账号稳定」），不报错、不 panic。
	for _, body := range []string{"", "not json", `{"messages":[]}`, `[]`} {
		if got := firstUserText([]byte(body)); got != "" {
			t.Fatalf("不该取出内容：%q → %q", body, got)
		}
	}
}

// session 算法的**固定向量**：防「Go 一份、TS 一份」然后悄悄漂移。
//
// 期望值是**写死的 32 位 hex**，不是用例里自己算出来的。算法是
//
//	hex( sha256( accountID ‖ 0x00 ‖ 首条用户消息文本 ) )[:32]
//
// 这三个值先用两个独立实现算过再抄进来（PowerShell 的 .NET SHA256 与 Node 的
// crypto，两边结果逐字相同），所以它钉的是**算法本身**，不是这份 Go 代码的当前行为。
//
// **TS 侧必须断言同一个字符串**：`account-admin` 的连通性测试要在 TS 里复刻这个算法
// （Go 的 transport 与 TS 的 test-connection 是两条独立链路，各写一份就会漂）。两边
// 用同一组向量，谁改了算法 CI 就立刻红。
//
// 别把这里改成「调 sessionIDFor 再和自己比」——那是拿实现验实现，一个字符都锁不住。
const (
	// sha256("acc-test" ‖ 0x00 ‖ "Hi")[:32]
	sessionVectorAccTestHi = "8defb1d7ad2e28e789863e433266cf9c"
	// sha256("acc-test" ‖ 0x00 ‖ "")[:32] —— 取不到用户文本时的退化值。
	sessionVectorAccTestEmpty = "ccfd15abe421f177d596bfc2200c34c1"
	// sha256("acc-other" ‖ 0x00 ‖ "Hi")[:32] —— 同对话、不同账号。
	sessionVectorAccOtherHi = "c90407fb1f5748150ad635737ee8c022"
)

// responsesShapeBody 是 OpenAI responses 形状的请求体（opencode 那条账号就是
// `protocol: openai-responses`）。首条 user 消息的文本是 "Hi"。
const responsesShapeBody = `{"model":"gpt-5","input":[{"role":"user","content":[{"type":"input_text","text":"Hi"}]}]}`

func TestSessionIDFixedVector(t *testing.T) {
	// ① 主向量：responses 形状 + 首条用户消息 "Hi"。
	if got := sessionIDFor("acc-test", []byte(responsesShapeBody)); got != sessionVectorAccTestHi {
		t.Fatalf("固定向量漂了：responses 形状算出 %q，期望 %q", got, sessionVectorAccTestHi)
	}

	// ② 形状无关：同一段话换成 chat / anthropic / gemini 形状，session 必须一样。
	//    这钉的是「只取决于取出的文本」——TS 侧四个协议分支必须取出同一个文本。
	sameText := map[string]string{
		"openai-chat": `{"model":"gpt-test","messages":[{"role":"user","content":"Hi"}]}`,
		"anthropic":   `{"model":"claude-test","messages":[{"role":"user","content":[{"type":"text","text":"Hi"}]}]}`,
		"gemini":      `{"contents":[{"role":"user","parts":[{"text":"Hi"}]}]}`,
	}
	for name, body := range sameText {
		if got := sessionIDFor("acc-test", []byte(body)); got != sessionVectorAccTestHi {
			t.Fatalf("%s 形状算出 %q，与 responses 形状不一致（期望 %q）", name, got, sessionVectorAccTestHi)
		}
	}

	// ③ 退化值：拿不到用户文本时按「账号 + 空文本」算 —— 仍然稳定，只是亲和粒度变粗。
	for name, body := range map[string]string{
		"空体":      ``,
		"不是 JSON": `not json`,
		"没有 user": `{"messages":[{"role":"assistant","content":"Hi"}]}`,
	} {
		if got := sessionIDFor("acc-test", []byte(body)); got != sessionVectorAccTestEmpty {
			t.Fatalf("%s 的退化值漂了：%q，期望 %q", name, got, sessionVectorAccTestEmpty)
		}
	}

	// ④ 亲和语义：首条用户消息相同、后面的对话不同 → 同一个 session。
	//    （这正是「对话越聊越长也不换会话」的意思，取整份请求体的哈希会破坏它。）
	longer := `{"model":"gpt-5","input":[{"role":"user","content":[{"type":"input_text","text":"Hi"}]},` +
		`{"role":"assistant","content":[{"type":"output_text","text":"你好，有什么可以帮你？"}]},` +
		`{"role":"user","content":[{"type":"input_text","text":"讲个笑话"}]}]}`
	if got := sessionIDFor("acc-test", []byte(longer)); got != sessionVectorAccTestHi {
		t.Fatalf("同一段对话变长后 session 变了：%q（期望 %q）", got, sessionVectorAccTestHi)
	}

	// ⑤ 账号隔离：同对话、换账号 → 必须不同。
	if got := sessionIDFor("acc-other", []byte(responsesShapeBody)); got != sessionVectorAccOtherHi {
		t.Fatalf("不同账号的固定向量漂了：%q，期望 %q", got, sessionVectorAccOtherHi)
	}
}

// TestSessionIDFixedVectorReachesUpstream 把同一个向量走完整条链路：
// 从 responses 形状的请求体取出 "Hi" → 展开进 `x-opencode-session` → 假上游亲眼看到。
// 只测 sessionIDFor 的话，「头到底贴没贴、贴的是不是这个值」还是没人管。
func TestSessionIDFixedVectorReachesUpstream(t *testing.T) {
	var seenSession string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenSession = r.Header.Get("x-opencode-session")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	stage, err := New(Config{}, staticSource{"acc-test": contracts.AccountCredential{
		AccountID:   "acc-test",
		Provider:    "openai",
		Kind:        "api_key",
		BaseURL:     upstream.URL,
		AccessToken: "sk-account-token",
		ClientHeaders: []contracts.AccountHeader{
			{Name: "x-opencode-session", Value: contracts.PlaceholderSession},
		},
	}}, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx := requestContext(false)
	ctx.Body = contracts.BytesBody([]byte(responsesShapeBody))
	ctx.AccountRoute = &contracts.AccountRoute{Picked: &contracts.ScoredAccount{AccountID: "acc-test"}}
	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if seenSession != sessionVectorAccTestHi {
		t.Fatalf("上游收到的会话头是 %q，期望写死的 %q", seenSession, sessionVectorAccTestHi)
	}
}

func TestClientMaskWithoutProfileChangesNothing(t *testing.T) {
	var seenSession string
	var seenAgent string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenSession = r.Header.Get("x-opencode-session")
		seenAgent = r.Header.Get("User-Agent")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	// 没挂档案：头一个都不多，UA 仍是网关默认值（不是空、也不是被清掉）。
	stage := newMaskStage(t, upstream.URL, "sk-token", contracts.AccountCredential{})
	if _, err := stage.Run(maskCtx("hi")); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if seenSession != "" {
		t.Fatalf("没挂档案却带了会话头：%q", seenSession)
	}
	if seenAgent == "" {
		t.Fatal("没挂档案时 UA 不该变空")
	}
}
