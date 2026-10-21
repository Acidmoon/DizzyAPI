package modelroute

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// fakeCreds 是「账号 id → 凭据」的假凭据源。
type fakeCreds map[string]contracts.AccountCredential

func (c fakeCreds) Credential(accountID string) (contracts.AccountCredential, bool) {
	credential, ok := c[accountID]
	return credential, ok
}

func credsWith(accountID string, mapping map[string]string) fakeCreds {
	return fakeCreds{accountID: {AccountID: accountID, ModelMap: mapping}}
}

func mapperStage(creds contracts.CredentialSource) *MapStage {
	return NewMapStage(New(creds, discardLogger()))
}

func mapCtx(accountID, model, body string) *contracts.Ctx {
	ctx := &contracts.Ctx{
		ReqID: "r",
		Meta:  contracts.RequestMeta{Model: model},
		Body:  contracts.BytesBody([]byte(body)),
	}
	if accountID != "" {
		ctx.AccountRoute = &contracts.AccountRoute{Picked: &contracts.ScoredAccount{AccountID: accountID}}
	}
	return ctx
}

func TestMapRewritesModelField(t *testing.T) {
	stage := mapperStage(credsWith("a", map[string]string{"gpt-4o": "gpt-4o-2024-11-20"}))
	ctx := mapCtx("a", "gpt-4o", `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)

	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctx.MappedBody == nil {
		t.Fatal("命中映射必须写入 MappedBody")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(ctx.MappedBody, &fields); err != nil {
		t.Fatalf("MappedBody 不是合法 JSON：%v", err)
	}
	var model string
	if err := json.Unmarshal(fields["model"], &model); err != nil {
		t.Fatalf("model 字段不是字符串：%v", err)
	}
	if model != "gpt-4o-2024-11-20" {
		t.Fatalf("model 未替换：%s", model)
	}
	// ctx.Meta.Model 是客户端请求的模型名，不得改写。
	if ctx.Meta.Model != "gpt-4o" {
		t.Fatalf("ctx.Meta.Model 不应被改写：%s", ctx.Meta.Model)
	}
	// 用量记录需要上游真实模型名。
	if ctx.UpstreamModel != "gpt-4o-2024-11-20" {
		t.Fatalf("UpstreamModel = %q，期望 gpt-4o-2024-11-20", ctx.UpstreamModel)
	}
}

func TestMapPreservesOtherFieldValues(t *testing.T) {
	stage := mapperStage(credsWith("a", map[string]string{"gpt-4o": "upstream-model"}))
	// 值里带 < > & 与嵌套对象，验证只动 model、且不重新转义值。
	body := `{"model":"gpt-4o","temperature":0.5,"system":"a<b>c&d","nested":{"z":1,"a":[1,2,3]}}`
	ctx := mapCtx("a", "gpt-4o", body)

	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	var got, want map[string]json.RawMessage
	if err := json.Unmarshal(ctx.MappedBody, &got); err != nil {
		t.Fatalf("MappedBody 非法 JSON：%v", err)
	}
	if err := json.Unmarshal([]byte(body), &want); err != nil {
		t.Fatalf("原始 body 非法 JSON：%v", err)
	}
	for key := range want {
		if key == "model" {
			continue
		}
		if string(got[key]) != string(want[key]) {
			t.Fatalf("字段 %s 的值被改动：got=%s want=%s", key, got[key], want[key])
		}
	}
	// 值里的 < > & 必须保持字面（若被重新转义，就会变成转义序列而非原字符）。
	if !strings.Contains(string(ctx.MappedBody), `"a<b>c&d"`) {
		t.Fatalf("值被重新转义：%s", ctx.MappedBody)
	}
}

func TestMapNoEntryLeavesMappedBodyNil(t *testing.T) {
	stage := mapperStage(credsWith("a", map[string]string{"other-model": "x"}))
	ctx := mapCtx("a", "gpt-4o", `{"model":"gpt-4o"}`)

	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctx.MappedBody != nil {
		t.Fatal("没有映射时 MappedBody 必须为 nil（字节级直通）")
	}
	if ctx.UpstreamModel != "" {
		t.Fatalf("没有映射时 UpstreamModel 必须为空，得到 %q", ctx.UpstreamModel)
	}
}

func TestMapResetsMappedBodyEachAttempt(t *testing.T) {
	stage := mapperStage(credsWith("a", map[string]string{"other-model": "x"}))
	ctx := mapCtx("a", "gpt-4o", `{"model":"gpt-4o"}`)
	// 模拟上一次 attempt 的残留。
	ctx.MappedBody = []byte(`{"stale":true}`)
	ctx.UpstreamModel = "stale-model"

	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctx.MappedBody != nil {
		t.Fatalf("每个 attempt 必须重置 MappedBody，残留=%s", ctx.MappedBody)
	}
	if ctx.UpstreamModel != "" {
		t.Fatalf("每个 attempt 必须重置 UpstreamModel，残留=%q", ctx.UpstreamModel)
	}
}

func TestMapHitReplacesStaleMappedBody(t *testing.T) {
	stage := mapperStage(credsWith("a", map[string]string{"gpt-4o": "upstream"}))
	ctx := mapCtx("a", "gpt-4o", `{"model":"gpt-4o"}`)
	ctx.MappedBody = []byte(`{"stale":true}`)

	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if strings.Contains(string(ctx.MappedBody), "stale") {
		t.Fatalf("残留没有被覆盖：%s", ctx.MappedBody)
	}
}

func TestMapParseFailureIsNotRetryable(t *testing.T) {
	stage := mapperStage(credsWith("a", map[string]string{"gpt-4o": "upstream"}))
	ctx := mapCtx("a", "gpt-4o", `{not json`)

	_, err := stage.Run(ctx)
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) {
		t.Fatalf("期望 StageError，得到 %v", err)
	}
	if stageErr.Code != CodeModelMapFailed || stageErr.Status != 400 || stageErr.Retryable {
		t.Fatalf("映射失败应 400 且不可重试：%+v", stageErr)
	}
	if ctx.MappedBody != nil {
		t.Fatal("失败时不得写入 MappedBody")
	}
}

func TestMapMissingAccountContinues(t *testing.T) {
	stage := mapperStage(credsWith("other", map[string]string{"gpt-4o": "upstream"}))
	ctx := mapCtx("a", "gpt-4o", `{"model":"gpt-4o"}`)

	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctx.MappedBody != nil {
		t.Fatal("取不到凭据时应直通（MappedBody=nil）")
	}
}

func TestMapEmptyModelContinues(t *testing.T) {
	stage := mapperStage(credsWith("a", map[string]string{"gpt-4o": "upstream"}))
	ctx := mapCtx("a", "", `{"model":"gpt-4o"}`)

	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctx.MappedBody != nil {
		t.Fatal("缺 model 时不应映射")
	}
}
