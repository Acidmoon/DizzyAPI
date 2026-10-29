package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/quota"
	"github.com/Acidmoon/DizzyAPI/modules/quotagate"
)

func quotaSnapshotJson(t *testing.T, generation int64, revision string, entries string) json.RawMessage {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"version":    quota.SnapshotVersion,
		"generation": generation,
		"revision":   revision,
		"entries":    json.RawMessage(entries),
	})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return payload
}

func TestQuotaReplaceAndStatusThroughBridge(t *testing.T) {
	h := testHandler(t)
	h.quota = quota.New(quota.WithTTL(15 * time.Second))

	result, err := h.Handle(context.Background(), contracts.BridgeMethodQuotaReplace,
		quotaSnapshotJson(t, 10, "rev-1", `[{"userId":"7","balanceMicros":"1500000"},{"userId":"8","balanceMicros":"-1"}]`))
	if err != nil {
		t.Fatalf("quota.replace: %v", err)
	}
	replace, ok := result.(quota.Result)
	if !ok {
		t.Fatalf("返回类型不对：%T", result)
	}
	if !replace.Ready || replace.Entries != 2 || replace.Revision != "rev-1" {
		t.Fatalf("quota.replace 结果不对：%+v", replace)
	}

	status, err := h.Handle(context.Background(), contracts.BridgeMethodQuotaStatus, nil)
	if err != nil {
		t.Fatalf("quota.status: %v", err)
	}
	state, ok := status.(quota.State)
	if !ok {
		t.Fatalf("quota.status 返回类型不对：%T", status)
	}
	if !state.Ready || state.Size != 2 || state.TtlMs != 15_000 || state.AgeMs < 0 {
		t.Fatalf("quota.status 不对：%+v", state)
	}
	// 桥响应不许带余额明细。
	payload, err := json.Marshal(status)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(payload), "1500000") || strings.Contains(string(payload), "userId") {
		t.Fatalf("quota.status 不许暴露余额明细：%s", payload)
	}
	// 没注入闸门阶段时 gate 键不出现（只增不改，响应与改动前逐字节一致）。
	if strings.Contains(string(payload), `"gate"`) {
		t.Fatalf("没有闸门阶段时不该出现 gate 字段：%s", payload)
	}
}

// 闸门的「连续不可用」观察要能通过 quota.status 读出来：偶发 1 次 vs 持续 N 次。
func TestQuotaStatusExposesGateStaleStreak(t *testing.T) {
	h := testHandler(t)
	cache := quota.New(quota.WithTTL(time.Second))
	h.quota = cache
	h.gate = quotagate.New(quotagate.Config{SnapshotTTL: time.Second}, cache, nil)

	// 还没有任何快照：放行模式不报错，但闸门要记下连续不可用。
	requestCtx := func() *contracts.Ctx {
		return &contracts.Ctx{
			Context: context.Background(),
			ReqID:   "req-quota",
			Key:     &contracts.APIKey{KeyID: "key-1", UserID: "7"},
		}
	}
	for index := 0; index < 3; index += 1 {
		if _, err := h.gate.Run(requestCtx()); err != nil {
			t.Fatalf("放行模式不该拒绝：%v", err)
		}
	}

	status, err := h.Handle(context.Background(), contracts.BridgeMethodQuotaStatus, nil)
	if err != nil {
		t.Fatalf("quota.status: %v", err)
	}
	state, ok := status.(quota.State)
	if !ok {
		t.Fatalf("返回类型不对：%T", status)
	}
	if state.Gate == nil {
		t.Fatal("注入了闸门阶段时 gate 字段必须出现")
	}
	if state.Gate.StaleStreak != 3 {
		t.Fatalf("连续不可用次数 = %d，期望 3", state.Gate.StaleStreak)
	}
	if state.Gate.StaleReason != "snapshot-unavailable" {
		t.Fatalf("staleReason = %q", state.Gate.StaleReason)
	}
	if state.Gate.AllowedUnknown != 3 {
		t.Fatalf("放行计数 = %d，期望 3", state.Gate.AllowedUnknown)
	}

	// 快照到位且覆盖该用户后，连续不可用清零。
	if _, err := cache.Replace(quota.Snapshot{
		Version:    quota.SnapshotVersion,
		Generation: 10,
		Revision:   "rev-1",
		Entries:    []quota.Entry{{UserID: "7", BalanceMicros: "1500000"}},
	}); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if _, err := h.gate.Run(requestCtx()); err != nil {
		t.Fatalf("余额充足不该拒绝：%v", err)
	}
	if stats := h.gate.Stats(); stats.StaleStreak != 0 {
		t.Fatalf("恢复后连续不可用必须归零：%+v", stats)
	}

	// 桥响应仍然不许带余额明细。
	payload, err := json.Marshal(status)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(payload), "1500000") || strings.Contains(string(payload), "userId") {
		t.Fatalf("quota.status 不许暴露余额明细：%s", payload)
	}
}

func TestQuotaReplaceRejectsStaleAndMalformedSnapshots(t *testing.T) {
	h := testHandler(t)
	h.quota = quota.New()
	if _, err := h.Handle(context.Background(), contracts.BridgeMethodQuotaReplace,
		quotaSnapshotJson(t, 100, "rev-1", `[]`)); err != nil {
		t.Fatalf("第一份快照应当接受：%v", err)
	}

	_, err := h.Handle(context.Background(), contracts.BridgeMethodQuotaReplace,
		quotaSnapshotJson(t, 99, "rev-0", `[]`))
	if err == nil || !strings.Contains(err.Error(), quota.CodeStaleSnapshot) {
		t.Fatalf("回退快照必须拒绝并带 %s：%v", quota.CodeStaleSnapshot, err)
	}

	_, err = h.Handle(context.Background(), contracts.BridgeMethodQuotaReplace,
		quotaSnapshotJson(t, 101, "rev-2", `[{"userId":"7","balanceMicros":"1.5"}]`))
	if err == nil || !strings.Contains(err.Error(), quota.CodeInvalidBalance) {
		t.Fatalf("浮点余额必须拒绝并带 %s：%v", quota.CodeInvalidBalance, err)
	}

	_, err = h.Handle(context.Background(), contracts.BridgeMethodQuotaReplace, json.RawMessage(`{"version":"x"}`))
	if err == nil || !strings.Contains(err.Error(), "BRIDGE_BAD_REQUEST") {
		t.Fatalf("参数不合法应回 BRIDGE_BAD_REQUEST：%v", err)
	}
}

func TestQuotaBridgeWithoutCache(t *testing.T) {
	h := testHandler(t)
	if _, err := h.Handle(context.Background(), contracts.BridgeMethodQuotaReplace,
		quotaSnapshotJson(t, 1, "rev", `[]`)); err == nil ||
		!strings.Contains(err.Error(), "QUOTA_UNAVAILABLE") {
		t.Fatalf("没有装配缓存时应明确失败：%v", err)
	}
	status, err := h.Handle(context.Background(), contracts.BridgeMethodQuotaStatus, nil)
	if err != nil {
		t.Fatalf("没有缓存时 quota.status 不该报错：%v", err)
	}
	if state, ok := status.(quota.State); !ok || state.Ready {
		t.Fatalf("没有缓存时应回零值状态：%+v", status)
	}
}

func TestQuotaSnapshotTTLConfig(t *testing.T) {
	for _, valid := range []int{1_000, 15_000, 600_000} {
		if got, err := parseQuotaSnapshotTTL(valid); err != nil ||
			got != time.Duration(valid)*time.Millisecond {
			t.Fatalf("%d 应当合法：%v %v", valid, got, err)
		}
	}
	for _, invalid := range []int{0, -1, 999, 600_001, 10_000_000} {
		if _, err := parseQuotaSnapshotTTL(invalid); err == nil {
			t.Fatalf("-quota-snapshot-ttl-ms=%d 必须报错", invalid)
		}
	}
}
