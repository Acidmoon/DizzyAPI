package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/quota"
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
