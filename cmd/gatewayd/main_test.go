package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accountruntime"
	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/apikeys"
	"github.com/Acidmoon/DizzyAPI/internal/bridge"
	"github.com/Acidmoon/DizzyAPI/internal/usagelog"
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

func TestUsageRingCapacityRejectsInvalidConfig(t *testing.T) {
	// 非法容量必须让组合根返回错误（main 会据此 os.Exit(1)），不能静默回落默认值。
	for _, capacity := range []int{-1, 0, usagelog.MaxCapacity + 1} {
		ring, err := newUsageRing(capacity)
		if err == nil {
			t.Fatalf("capacity=%d 应让启动失败，得到 %+v", capacity, ring)
		}
		if !strings.Contains(err.Error(), "-usage-ring-capacity") {
			t.Fatalf("启动错误应点出配置项：%v", err)
		}
	}

	ring, err := newUsageRing(usagelog.DefaultCapacity)
	if err != nil {
		t.Fatalf("默认容量应当合法：%v", err)
	}
	if got := ring.Stats().Capacity; got != usagelog.DefaultCapacity {
		t.Fatalf("容量 = %d，期望 %d", got, usagelog.DefaultCapacity)
	}
}

func TestUsageStatsReportsRingHealth(t *testing.T) {
	h := testHandler(t)
	ring, err := newUsageRing(4)
	if err != nil {
		t.Fatalf("newUsageRing: %v", err)
	}
	h.usage = ring
	for index := 0; index < 6; index++ {
		ring.Append(contracts.UsageRecord{RequestID: "req"})
	}

	result, err := h.Handle(context.Background(), contracts.BridgeMethodUsageStats, nil)
	if err != nil {
		t.Fatalf("usage.stats: %v", err)
	}
	stats, ok := result.(usagelog.StatsResult)
	if !ok {
		t.Fatalf("usage.stats 返回类型不对：%T", result)
	}
	if stats.Capacity != 4 || stats.Size != 4 {
		t.Fatalf("capacity/size = %d/%d，期望 4/4", stats.Capacity, stats.Size)
	}
	if stats.LastSeq != 6 || stats.FirstSeq != 3 {
		t.Fatalf("first/last = %d/%d，期望 3/6", stats.FirstSeq, stats.LastSeq)
	}
	if stats.Dropped != 2 || stats.Gap != 2 {
		t.Fatalf("dropped/gap = %d/%d，期望 2/2", stats.Dropped, stats.Gap)
	}
	if stats.Epoch == "" {
		t.Fatal("usage.stats 必须带 epoch")
	}

	// 必须能原样序列化成 JSON 的整数（TS 侧按整数解析，不能出现浮点）。
	payload, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	for _, field := range []string{`"capacity":4`, `"size":4`, `"dropped":2`, `"gap":2`, `"lastSeq":6`} {
		if !strings.Contains(string(payload), field) {
			t.Fatalf("usage.stats JSON 缺少 %s：%s", field, payload)
		}
	}
}

func TestUsageStatsWithoutRing(t *testing.T) {
	h := testHandler(t)
	result, err := h.Handle(context.Background(), contracts.BridgeMethodUsageStats, nil)
	if err != nil {
		t.Fatalf("没有环形缓冲时不应报错：%v", err)
	}
	if stats, ok := result.(usagelog.StatsResult); !ok || stats != (usagelog.StatsResult{}) {
		t.Fatalf("没有环形缓冲时应返回零值，得到 %+v", result)
	}
}

func TestAccountsStatusCarriesAggregatedRuntime(t *testing.T) {
	h := testHandler(t)
	tracker := accountruntime.New(30 * time.Second)
	h.runtime = tracker
	if _, err := h.accounts.Replace(accounts.Snapshot{
		Version: accounts.SnapshotVersion,
		Accounts: []accounts.Account{
			{AccountID: "acc-1", Provider: "openai", Kind: "api_key", BaseURL: "https://upstream.example/v1", Token: "sk-1", Concurrency: 2},
			{AccountID: "acc-2", Provider: "openai", Kind: "api_key", BaseURL: "https://upstream.example/v1", Token: "sk-2", Concurrency: 2},
		},
	}); err != nil {
		t.Fatalf("accounts.Replace: %v", err)
	}
	release, ok := tracker.Acquire("acc-1", 2)
	if !ok {
		t.Fatal("acc-1 应当能预留槽位")
	}
	defer release()
	tracker.RecordLimit("acc-2")

	result, err := h.Handle(context.Background(), bridge.MethodAccountsStatus, nil)
	if err != nil {
		t.Fatalf("accounts.status: %v", err)
	}
	payload, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var decoded struct {
		Accounts int `json:"accounts"`
		Runtime  struct {
			Active  int `json:"active"`
			Cooling int `json:"cooling"`
		} `json:"runtime"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v（%s）", err, payload)
	}
	if decoded.Accounts != 2 {
		t.Fatalf("原有字段必须原样保留：%s", payload)
	}
	if decoded.Runtime.Active != 1 || decoded.Runtime.Cooling != 1 {
		t.Fatalf("runtime 应为 active=1 cooling=1：%s", payload)
	}
	// 只增不改：不含账号级明细，也不含任何令牌。
	if strings.Contains(string(payload), "acc-1") || strings.Contains(string(payload), "sk-") {
		t.Fatalf("accounts.status 不许回显账号级明细或秘密：%s", payload)
	}
}

func TestAccountsStatusOmitsRuntimeWithoutTracker(t *testing.T) {
	h := testHandler(t)
	result, err := h.Handle(context.Background(), bridge.MethodAccountsStatus, nil)
	if err != nil {
		t.Fatalf("accounts.status: %v", err)
	}
	payload, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(payload, &raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if _, ok := raw["runtime"]; ok {
		t.Fatalf("没有运行时状态时不许输出 runtime 字段：%s", payload)
	}
}

func TestAccountCooldownConfig(t *testing.T) {
	// 合法值：0 = 关闭冷却；上限值刚好合法。
	if got, err := parseAccountCooldown(0); err != nil || got != 0 {
		t.Fatalf("0 应当表示关闭冷却：duration=%v err=%v", got, err)
	}
	if got, err := parseAccountCooldown(30_000); err != nil || got != 30*time.Second {
		t.Fatalf("30s 应当合法：duration=%v err=%v", got, err)
	}
	if got, err := parseAccountCooldown(maxAccountCooldownMs); err != nil ||
		got != time.Duration(maxAccountCooldownMs)*time.Millisecond {
		t.Fatalf("上限值应当合法：duration=%v err=%v", got, err)
	}

	// 非法值：负数 / 超过上限都必须让进程起不来，不能静默回落默认值。
	for _, invalid := range []int{-1, maxAccountCooldownMs + 1} {
		if _, err := parseAccountCooldown(invalid); err == nil {
			t.Fatalf("-account-cooldown-ms=%d 必须报错", invalid)
		}
	}
}
