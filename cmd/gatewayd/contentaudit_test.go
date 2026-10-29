package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
	contentauditcache "github.com/Acidmoon/DizzyAPI/internal/contentaudit"
	"github.com/Acidmoon/DizzyAPI/modules/contentaudit"
)

func contentAuditSnapshotJson(t *testing.T, generation int64, revision string, enabled bool, rules string) json.RawMessage {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"version":    contentauditcache.SnapshotVersion,
		"generation": generation,
		"revision":   revision,
		"enabled":    enabled,
		"rules":      json.RawMessage(rules),
	})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return payload
}

func TestContentAuditReplaceAndStatusThroughBridge(t *testing.T) {
	h := testHandler(t)
	h.contentAudit = contentauditcache.New(contentauditcache.WithTTL(15 * time.Second))
	h.contentAuditGate = contentaudit.New(contentaudit.Config{SnapshotTTL: 15 * time.Second}, h.contentAudit, nil)

	result, err := h.Handle(context.Background(), contracts.BridgeMethodContentAuditReplace,
		contentAuditSnapshotJson(t, 10, "rev-1", true,
			`[{"id":"r1","pattern":"badword","action":"block","category":"abuse"}]`))
	if err != nil {
		t.Fatalf("contentaudit.replace: %v", err)
	}
	replace, ok := result.(contentauditcache.Result)
	if !ok {
		t.Fatalf("返回类型不对：%T", result)
	}
	if !replace.Ready || replace.Rules != 1 || !replace.Enabled || replace.Revision != "rev-1" {
		t.Fatalf("contentaudit.replace 结果不对：%+v", replace)
	}

	status, err := h.Handle(context.Background(), contracts.BridgeMethodContentAuditStatus, nil)
	if err != nil {
		t.Fatalf("contentaudit.status: %v", err)
	}
	state, ok := status.(contentauditcache.State)
	if !ok {
		t.Fatalf("contentaudit.status 返回类型不对：%T", status)
	}
	if !state.Ready || state.Size != 1 || !state.Enabled || state.TtlMs != 15_000 {
		t.Fatalf("contentaudit.status 不对：%+v", state)
	}
	if state.Gate == nil {
		t.Fatal("注入了闸门阶段时 gate 字段必须出现")
	}
	// 桥响应不许带规则 pattern（只给计数与 id）。
	payload, err := json.Marshal(status)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(payload), "badword") {
		t.Fatalf("contentaudit.status 不许回显规则内容：%s", payload)
	}
}

// 闸门计数与命中统计要能通过 contentaudit.status 读出来（只增字段）。
func TestContentAuditStatusExposesGateStats(t *testing.T) {
	h := testHandler(t)
	h.contentAudit = contentauditcache.New(contentauditcache.WithTTL(time.Second))
	h.contentAuditGate = contentaudit.New(contentaudit.Config{SnapshotTTL: time.Second}, h.contentAudit, nil)

	if _, err := h.Handle(context.Background(), contracts.BridgeMethodContentAuditReplace,
		contentAuditSnapshotJson(t, 1, "rev-1", true,
			`[{"id":"r1","pattern":"badword","action":"block"}]`)); err != nil {
		t.Fatalf("contentaudit.replace: %v", err)
	}

	requestCtx := &contracts.Ctx{
		Context:        context.Background(),
		ReqID:          "req-content-audit",
		ClientProtocol: contracts.ProtocolOpenAIChat,
		Body:           contracts.BytesBody([]byte(`{"messages":[{"role":"user","content":"BADWORD"}]}`)),
	}
	if _, err := h.contentAuditGate.Run(requestCtx); err == nil {
		t.Fatal("命中 block 规则应被拒绝")
	}

	status, err := h.Handle(context.Background(), contracts.BridgeMethodContentAuditStatus, nil)
	if err != nil {
		t.Fatalf("contentaudit.status: %v", err)
	}
	state := status.(contentauditcache.State)
	if state.Gate == nil || state.Gate.Blocked != 1 || state.Gate.RuleHitTotal != 1 {
		t.Fatalf("gate 计数不对：%+v", state.Gate)
	}
	if state.Gate.RuleHits["r1"] != 1 {
		t.Fatalf("规则命中统计不对：%+v", state.Gate.RuleHits)
	}
}

// 非法快照明确失败，且不覆盖已有规则。
func TestContentAuditReplaceRejectsInvalidSnapshot(t *testing.T) {
	h := testHandler(t)
	h.contentAudit = contentauditcache.New()

	_, err := h.Handle(context.Background(), contracts.BridgeMethodContentAuditReplace,
		contentAuditSnapshotJson(t, 1, "rev-1", true, `[{"id":"r1","pattern":"","action":"block"}]`))
	if err == nil {
		t.Fatal("非法规则必须被拒绝")
	}
	if !strings.Contains(err.Error(), contentauditcache.CodeInvalidSnapshot) {
		t.Fatalf("错误码不对：%v", err)
	}
	if h.contentAudit.Ready() {
		t.Fatal("被拒绝的快照不能留下状态")
	}
}

// 没有装配缓存时：replace 明确失败，status 返回空状态（不 panic）。
func TestContentAuditBridgeWithoutCache(t *testing.T) {
	h := testHandler(t)
	if _, err := h.Handle(context.Background(), contracts.BridgeMethodContentAuditReplace,
		contentAuditSnapshotJson(t, 1, "rev-1", true, `[]`)); err == nil {
		t.Fatal("没有缓存时 replace 应明确失败")
	}
	status, err := h.Handle(context.Background(), contracts.BridgeMethodContentAuditStatus, nil)
	if err != nil {
		t.Fatalf("没有缓存时 status 不该报错：%v", err)
	}
	state := status.(contentauditcache.State)
	if state.Ready || state.Gate != nil {
		t.Fatalf("没有缓存时状态应为空：%+v", state)
	}
}

// TTL 配置非法时进程起不来。
func TestContentAuditSnapshotTTLConfig(t *testing.T) {
	if _, err := parseContentAuditSnapshotTTL(minContentAuditSnapshotTTLMs); err != nil {
		t.Fatalf("下界应当合法：%v", err)
	}
	if _, err := parseContentAuditSnapshotTTL(maxContentAuditSnapshotTTLMs); err != nil {
		t.Fatalf("上界应当合法：%v", err)
	}
	for _, invalid := range []int{0, -1, minContentAuditSnapshotTTLMs - 1, maxContentAuditSnapshotTTLMs + 1} {
		if _, err := parseContentAuditSnapshotTTL(invalid); err == nil {
			t.Fatalf("%d 应被拒绝", invalid)
		}
	}
}
