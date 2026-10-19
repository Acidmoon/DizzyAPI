package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/apikeys"
	"github.com/Acidmoon/DizzyAPI/internal/bridge"
	"github.com/Acidmoon/DizzyAPI/modules/accountpriority"
)

func testHandler(t *testing.T) *handler {
	t.Helper()
	service, err := accountpriority.New(accountpriority.Config{})
	if err != nil {
		t.Fatalf("accountpriority.New: %v", err)
	}
	return &handler{
		service:  service,
		accounts: accounts.New(),
		keys:     apikeys.New(),
		logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		shutdown: make(chan struct{}),
	}
}

func TestAccountsReplaceDoesNotEchoSecrets(t *testing.T) {
	h := testHandler(t)
	params := json.RawMessage(`{
		"version": 1,
		"generation": "g1",
		"accounts": [{
			"accountId": "acc-1",
			"provider": "openai",
			"kind": "api_key",
			"baseUrl": "https://api.example.com/v1",
			"token": "sk-super-secret"
		}]
	}`)

	result, err := h.Handle(context.Background(), bridge.MethodReplaceAccounts, params)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	payload, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(payload), "sk-super-secret") {
		t.Fatalf("accounts.replace 响应泄漏了令牌：%s", payload)
	}

	status, err := h.Handle(context.Background(), bridge.MethodAccountsStatus, nil)
	if err != nil {
		t.Fatalf("Handle status: %v", err)
	}
	payload, err = json.Marshal(status)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(payload), "sk-super-secret") {
		t.Fatalf("accounts.status 泄漏了令牌：%s", payload)
	}
	if !strings.Contains(string(payload), `"accounts":1`) {
		t.Fatalf("状态计数不对：%s", payload)
	}
}

func TestAccountsReplaceRejectsInvalidSnapshotWithoutSecrets(t *testing.T) {
	h := testHandler(t)
	params := json.RawMessage(`{
		"version": 1,
		"accounts": [{
			"accountId": "acc-1",
			"provider": "openai",
			"baseUrl": "not-a-url",
			"token": "sk-super-secret"
		}]
	}`)

	_, err := h.Handle(context.Background(), bridge.MethodReplaceAccounts, params)
	if err == nil {
		t.Fatal("非法快照必须被拒绝")
	}
	if strings.Contains(err.Error(), "sk-super-secret") {
		t.Fatalf("错误信息泄漏了令牌：%v", err)
	}
	public, ok := err.(*bridge.Error)
	if !ok || public.Code != "ACCOUNTS_INVALID_ACCOUNT" {
		t.Fatalf("错误码不对：%v", err)
	}
}

func TestKeysReplaceDoesNotEchoHashes(t *testing.T) {
	h := testHandler(t)
	hash := strings.Repeat("a", 64)
	params := json.RawMessage(`{
		"version": 1,
		"generation": 3,
		"keys": [{
			"keyId": "key-1",
			"userId": 42,
			"keyHash": "` + hash + `",
			"profile": "billed",
			"name": "default"
		}]
	}`)

	result, err := h.Handle(context.Background(), bridge.MethodReplaceKeys, params)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	payload, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(payload), hash) {
		t.Fatalf("keys.replace 响应泄漏了哈希：%s", payload)
	}
	if !strings.Contains(string(payload), `"keys":1`) {
		t.Fatalf("响应计数不对：%s", payload)
	}

	status, err := h.Handle(context.Background(), bridge.MethodKeysStatus, nil)
	if err != nil {
		t.Fatalf("Handle status: %v", err)
	}
	payload, err = json.Marshal(status)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(payload), hash) {
		t.Fatalf("keys.status 泄漏了哈希：%s", payload)
	}
	if !strings.Contains(string(payload), `"keys":1`) {
		t.Fatalf("状态计数不对：%s", payload)
	}
}

func TestKeysReplaceRejectsInvalidSnapshotWithoutHashes(t *testing.T) {
	h := testHandler(t)
	badHash := strings.Repeat("z", 64)
	params := json.RawMessage(`{
		"version": 1,
		"keys": [{
			"keyId": "key-1",
			"userId": 42,
			"keyHash": "` + badHash + `",
			"profile": "billed"
		}]
	}`)

	_, err := h.Handle(context.Background(), bridge.MethodReplaceKeys, params)
	if err == nil {
		t.Fatal("非法快照必须被拒绝")
	}
	if strings.Contains(err.Error(), badHash) {
		t.Fatalf("错误信息泄漏了哈希：%v", err)
	}
	public, ok := err.(*bridge.Error)
	if !ok || public.Code != apikeys.CodeInvalidKey {
		t.Fatalf("错误码不对：%v", err)
	}
}
