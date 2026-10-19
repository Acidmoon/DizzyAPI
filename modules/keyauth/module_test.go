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
