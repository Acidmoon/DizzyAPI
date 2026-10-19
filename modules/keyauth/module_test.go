package keyauth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

func ctxWithAuthorization(value string) *contracts.Ctx {
	headers := http.Header{}
	if value != "" {
		headers.Set("Authorization", value)
	}
	return &contracts.Ctx{Context: context.Background(), Headers: headers}
}

func TestPlaceholderAcceptsAnyBearer(t *testing.T) {
	stage := New(Config{})
	if !stage.Placeholder() {
		t.Fatal("空密钥应为占位模式")
	}
	ctx := ctxWithAuthorization("Bearer user-key")
	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctx.Key == nil || ctx.Key.ID == "" || ctx.Profile != DefaultProfile {
		t.Fatalf("没有写入 Key/Profile：%+v profile=%q", ctx.Key, ctx.Profile)
	}
	if strings.Contains(ctx.Key.ID, "user-key") {
		t.Fatal("Key.ID 不得包含原始密钥")
	}
}

func TestStaticKeys(t *testing.T) {
	stage := New(Config{Keys: []string{" key-a ", "key-b"}, Profile: "free"})
	ctx := ctxWithAuthorization("Bearer key-b")
	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctx.Profile != "free" {
		t.Fatalf("profile 不对：%s", ctx.Profile)
	}

	_, err := stage.Run(ctxWithAuthorization("Bearer wrong"))
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) || stageErr.Status != http.StatusUnauthorized || stageErr.Code != "INVALID_API_KEY" {
		t.Fatalf("期望 401 INVALID_API_KEY，得到 %v", err)
	}
}

func TestRejectsMissingOrMalformedHeader(t *testing.T) {
	stage := New(Config{})
	cases := []string{"", "Basic abc", "Bearer ", "Bearer"}
	for _, value := range cases {
		_, err := stage.Run(ctxWithAuthorization(value))
		var stageErr *contracts.StageError
		if !errors.As(err, &stageErr) || stageErr.Status != http.StatusUnauthorized {
			t.Fatalf("Authorization=%q 期望 401，得到 %v", value, err)
		}
	}
}

// fakeVerifier 只实现 keyauth 需要的两个方法；真实实现在 internal/apikeys。
type fakeVerifier struct {
	records map[string]contracts.APIKeyRecord
	count   int
}

func (f *fakeVerifier) Verify(presented string) (contracts.APIKeyRecord, bool) {
	record, ok := f.records[presented]
	return record, ok
}

func (f *fakeVerifier) Count() int { return f.count }

func TestDynamicKeysTakePrecedenceAndFillIdentity(t *testing.T) {
	verifier := &fakeVerifier{
		count: 1,
		records: map[string]contracts.APIKeyRecord{
			"dz-live-key": {KeyID: "key-id-1", UserID: "42", Name: "production", Profile: "free"},
		},
	}
	stage := New(Config{
		Keys:     []string{"env-key"},
		Profile:  "billed",
		Verifier: verifier,
	})
	if stage.Placeholder() {
		t.Fatal("动态快照非空时不能是占位模式")
	}

	ctx := ctxWithAuthorization("Bearer dz-live-key")
	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctx.Key == nil {
		t.Fatal("没有写入 Ctx.Key")
	}
	if ctx.Key.ID != "key-id-1" || ctx.Key.KeyID != "key-id-1" || ctx.Key.UserID != "42" ||
		ctx.Key.Name != "production" || ctx.Key.Profile != "free" {
		t.Fatalf("Ctx.Key 不对：%+v", ctx.Key)
	}
	if ctx.Profile != "free" {
		t.Fatalf("Ctx.Profile 应取 key 的 profile：%q", ctx.Profile)
	}

	// 快照非空时环境变量静态 key 必须失效，绝不回退。
	_, err := stage.Run(ctxWithAuthorization("Bearer env-key"))
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) || stageErr.Status != http.StatusUnauthorized || stageErr.Code != "INVALID_API_KEY" {
		t.Fatalf("快照非空时静态 key 必须被拒绝，得到 %v", err)
	}
}

func TestEmptySnapshotFallsBackToStaticKeys(t *testing.T) {
	verifier := &fakeVerifier{count: 0, records: map[string]contracts.APIKeyRecord{}}
	stage := New(Config{Keys: []string{"env-key"}, Verifier: verifier})

	ctx := ctxWithAuthorization("Bearer env-key")
	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("快照为空时应接受静态 key：%v", err)
	}
	if ctx.Key == nil || ctx.Key.ID == "" {
		t.Fatal("静态 key 也应写入指纹")
	}

	_, err := stage.Run(ctxWithAuthorization("Bearer other"))
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) || stageErr.Status != http.StatusUnauthorized {
		t.Fatalf("错误静态 key 应 401，得到 %v", err)
	}

	// 快照到达后同一 stage 立刻切换模式。
	verifier.count = 1
	verifier.records["env-key"] = contracts.APIKeyRecord{
		KeyID: "key-static-upgraded", UserID: "7", Profile: "billed",
	}
	upgraded := ctxWithAuthorization("Bearer env-key")
	if _, runErr := stage.Run(upgraded); runErr != nil {
		t.Fatalf("快照命中后应接受：%v", runErr)
	}
	if upgraded.Key == nil || upgraded.Key.UserID != "7" {
		t.Fatalf("快照命中应写入 userId：%+v", upgraded.Key)
	}
}

func TestEmptySnapshotAndNoStaticKeysStayPlaceholder(t *testing.T) {
	stage := New(Config{Verifier: &fakeVerifier{count: 0}})
	if !stage.Placeholder() {
		t.Fatal("空快照 + 无静态 key 应为占位模式")
	}
	ctx := ctxWithAuthorization("Bearer any-dev-key")
	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("占位模式应接受非空 key：%v", err)
	}
	if ctx.Key == nil || ctx.Key.UserID != "" {
		t.Fatalf("占位模式不应伪造 userId：%+v", ctx.Key)
	}
}

func TestDynamicRejectionDoesNotLeakKey(t *testing.T) {
	stage := New(Config{
		Verifier: &fakeVerifier{count: 1, records: map[string]contracts.APIKeyRecord{}},
	})
	secret := "dz-unknown-secret-key"
	_, err := stage.Run(ctxWithAuthorization("Bearer " + secret))
	if err == nil {
		t.Fatal("未知 key 必须被拒绝")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("错误信息泄漏了 key：%v", err)
	}
}
