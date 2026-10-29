package keyspend

import (
	"testing"
	"time"
)

func snapshot(generation int64, revision string, entries ...Entry) Snapshot {
	return Snapshot{Version: SnapshotVersion, Generation: generation, Revision: revision, Entries: entries}
}

func TestReplaceAndLookup(t *testing.T) {
	cache := New()
	if cache.Ready() {
		t.Fatalf("还没收到快照时 Ready 必须是 false")
	}
	result, err := cache.Replace(snapshot(1, "rev-1",
		Entry{KeyID: "k1", SpentMicros: "1000000"},
		Entry{KeyID: "k2", SpentMicros: "0"},
	))
	if err != nil {
		t.Fatalf("合法快照不该失败：%v", err)
	}
	if !result.Ready || result.Entries != 2 {
		t.Fatalf("结果不对：%+v", result)
	}
	if spent, ok := cache.Lookup("k1"); !ok || spent != 1_000_000 {
		t.Fatalf("k1 = %d/%v，期望 1000000/true", spent, ok)
	}
	if _, ok := cache.Lookup("missing"); ok {
		t.Fatalf("快照里没有的 key 必须 ok=false")
	}
}

func TestReplaceRejectsNegativeAndNonDecimalAmounts(t *testing.T) {
	cache := New()
	for _, value := range []string{"-1", "1.5", "abc", ""} {
		if _, err := cache.Replace(snapshot(1, "rev", Entry{KeyID: "k", SpentMicros: value})); err == nil {
			t.Fatalf("金额 %q 必须被拒绝（整份快照）", value)
		}
	}
	if cache.Ready() {
		t.Fatalf("被拒的快照不能让缓存变成 ready")
	}
}

func TestReplaceRejectsGenerationRegression(t *testing.T) {
	cache := New()
	if _, err := cache.Replace(snapshot(5, "rev-5", Entry{KeyID: "k", SpentMicros: "10"})); err != nil {
		t.Fatalf("首次写入失败：%v", err)
	}
	if _, err := cache.Replace(snapshot(4, "rev-4", Entry{KeyID: "k", SpentMicros: "99"})); err == nil {
		t.Fatalf("generation 回退必须被拒绝（不覆盖新快照）")
	}
	if spent, _ := cache.Lookup("k"); spent != 10 {
		t.Fatalf("回退的快照不能覆盖：spent = %d，期望 10", spent)
	}
	// 同 generation + 同 revision = 幂等重推
	if _, err := cache.Replace(snapshot(5, "rev-5", Entry{KeyID: "k", SpentMicros: "10"})); err != nil {
		t.Fatalf("幂等重推应当成功：%v", err)
	}
}

func TestStaleAfterTTL(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	cache := New(WithTTL(2*time.Second), WithClock(func() time.Time { return now }))
	if _, err := cache.Replace(snapshot(1, "rev", Entry{KeyID: "k", SpentMicros: "1"})); err != nil {
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
