package pricing

import (
	"testing"
	"time"
)

func price(model string) Price {
	return Price{
		Model:                model,
		InputPerMillion:      "1.5",
		OutputPerMillion:     "3",
		CacheReadPerMillion:  "0",
		CacheWritePerMillion: "0",
	}
}

func snapshot(generation int64, revision string, prices ...Price) Snapshot {
	return Snapshot{Version: SnapshotVersion, Generation: generation, Revision: revision, Prices: prices}
}

func TestPricedWithoutWildcard(t *testing.T) {
	cache := New()
	if _, err := cache.Replace(snapshot(1, "rev-1", price("deepseek-flash"))); err != nil {
		t.Fatalf("合法快照不该失败：%v", err)
	}
	if !cache.Priced("deepseek-flash") {
		t.Fatalf("精确命中的模型必须算有价")
	}
	if cache.Priced("gpt-4o") {
		t.Fatalf("没有 * 兜底时未配价的模型必须算没价（与 billing.hasPrice 同口径）")
	}
	if cache.Wildcard() {
		t.Fatalf("没有 * 时 Wildcard 必须是 false")
	}
}

func TestWildcardAllowsEveryModel(t *testing.T) {
	cache := New()
	if _, err := cache.Replace(snapshot(1, "rev-1", price("*"))); err != nil {
		t.Fatalf("合法快照不该失败：%v", err)
	}
	for _, model := range []string{"deepseek-flash", "gpt-4o", "任何没配过的模型"} {
		if !cache.Priced(model) {
			t.Fatalf("有 * 兜底时 %q 必须有价（通配口径两处必须一致）", model)
		}
	}
	if !cache.Wildcard() {
		t.Fatalf("有 * 时 Wildcard 必须是 true")
	}
}

func TestReplaceRejectsBadPriceShape(t *testing.T) {
	cache := New()
	bad := price("m")
	bad.InputPerMillion = "-1" // 负价：形状不合法
	if _, err := cache.Replace(snapshot(1, "rev", bad)); err == nil {
		t.Fatalf("负价必须整份拒绝")
	}
	bad = price("m")
	bad.OutputPerMillion = "1e3" // 指数写法不接受
	if _, err := cache.Replace(snapshot(1, "rev", bad)); err == nil {
		t.Fatalf("指数写法必须整份拒绝")
	}
	if cache.Ready() {
		t.Fatalf("被拒的快照不能让缓存变成 ready")
	}
}

func TestReplaceRejectsDuplicateModel(t *testing.T) {
	cache := New()
	if _, err := cache.Replace(snapshot(1, "rev", price("m"), price("m"))); err == nil {
		t.Fatalf("模型重复必须整份拒绝")
	}
}

func TestStaleAfterTTL(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	cache := New(WithTTL(2*time.Second), WithClock(func() time.Time { return now }))
	if _, err := cache.Replace(snapshot(1, "rev", price("m"))); err != nil {
		t.Fatalf("写入失败：%v", err)
	}
	if cache.Stale() {
		t.Fatalf("刚写完不该过期")
	}
	now = now.Add(3 * time.Second)
	if !cache.Stale() {
		t.Fatalf("超过 TTL 必须判定过期")
	}
}
