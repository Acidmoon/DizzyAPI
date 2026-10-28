package usagelog

import (
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

func mustRing(t *testing.T, capacity int) *Ring {
	t.Helper()
	ring, err := NewRing(capacity)
	if err != nil {
		t.Fatalf("NewRing(%d): %v", capacity, err)
	}
	return ring
}

func appendRecords(ring *Ring, count int) {
	for index := 0; index < count; index++ {
		ring.Append(contracts.UsageRecord{RequestID: "req"})
	}
}

func TestNewRingRejectsInvalidCapacity(t *testing.T) {
	for _, capacity := range []int{-1, 0, MaxCapacity + 1} {
		ring, err := NewRing(capacity)
		if err == nil {
			t.Fatalf("capacity=%d 必须报错，得到 %+v", capacity, ring)
		}
		if !strings.Contains(err.Error(), "容量必须在") {
			t.Fatalf("错误信息不够明确：%v", err)
		}
		if ring != nil {
			t.Fatalf("非法容量不应返回 Ring，得到 %+v", ring)
		}
	}
	for _, capacity := range []int{MinCapacity, DefaultCapacity, MaxCapacity} {
		if _, err := NewRing(capacity); err != nil {
			t.Fatalf("capacity=%d 应当合法：%v", capacity, err)
		}
	}
}

func TestEmptyRing(t *testing.T) {
	ring := mustRing(t, 4)
	if ring.Epoch() == "" {
		t.Fatal("epoch 不能为空")
	}
	result := ring.Since(ring.Epoch(), 0, 10)
	if result.Epoch != ring.Epoch() {
		t.Fatalf("epoch = %q，期望 %q", result.Epoch, ring.Epoch())
	}
	if result.FirstSeq != 0 || result.LastSeq != 0 {
		t.Fatalf("空缓冲的 first/last 应为 0，得到 %d/%d", result.FirstSeq, result.LastSeq)
	}
	if len(result.Records) != 0 {
		t.Fatalf("空缓冲不应有记录，得到 %d 条", len(result.Records))
	}
}

func TestAppendAssignsIncreasingSeqAndEpoch(t *testing.T) {
	ring := mustRing(t, 4)
	appendRecords(ring, 3)

	result := ring.Since(ring.Epoch(), 0, 10)
	if result.FirstSeq != 1 || result.LastSeq != 3 {
		t.Fatalf("first/last = %d/%d，期望 1/3", result.FirstSeq, result.LastSeq)
	}
	for index, record := range result.Records {
		if record.Seq != int64(index+1) {
			t.Fatalf("record[%d].Seq = %d，期望 %d", index, record.Seq, index+1)
		}
		if record.Epoch != ring.Epoch() {
			t.Fatalf("record[%d].Epoch = %q，期望 %q", index, record.Epoch, ring.Epoch())
		}
	}
}

func TestSinceAfterSeqBoundaries(t *testing.T) {
	ring := mustRing(t, 4)
	appendRecords(ring, 3)

	// afterSeq = 0：全部。
	if got := ring.Since(ring.Epoch(), 0, 10); len(got.Records) != 3 {
		t.Fatalf("afterSeq=0 期望 3 条，得到 %d", len(got.Records))
	}
	// afterSeq = 2：只剩 3。
	got := ring.Since(ring.Epoch(), 2, 10)
	if len(got.Records) != 1 || got.Records[0].Seq != 3 {
		t.Fatalf("afterSeq=2 期望只剩 seq=3，得到 %+v", got.Records)
	}
	// afterSeq 超过 LastSeq：没有记录，但边界仍反映缓冲内容。
	got = ring.Since(ring.Epoch(), 99, 10)
	if len(got.Records) != 0 {
		t.Fatalf("afterSeq=99 不应有记录，得到 %d", len(got.Records))
	}
	if got.FirstSeq != 1 || got.LastSeq != 3 {
		t.Fatalf("边界应保持 1/3，得到 %d/%d", got.FirstSeq, got.LastSeq)
	}
}

func TestEpochChangeReturnsWholeBuffer(t *testing.T) {
	ring := mustRing(t, 4)
	appendRecords(ring, 3)

	got := ring.Since("old-epoch", 2, 10)
	if got.Epoch != ring.Epoch() {
		t.Fatalf("epoch = %q，期望 %q", got.Epoch, ring.Epoch())
	}
	if len(got.Records) != 3 {
		t.Fatalf("epoch 变化时应返回整个缓冲，得到 %d 条", len(got.Records))
	}
	if got.Records[0].Seq != 1 || got.Records[2].Seq != 3 {
		t.Fatalf("epoch 变化时应从最旧开始，得到 %+v", got.Records)
	}
}

func TestWrapDropsOldest(t *testing.T) {
	ring := mustRing(t, 3)
	appendRecords(ring, 5)

	got := ring.Since(ring.Epoch(), 0, 10)
	if got.Dropped != 2 {
		t.Fatalf("dropped = %d，期望 2", got.Dropped)
	}
	if got.FirstSeq != 3 || got.LastSeq != 5 {
		t.Fatalf("first/last = %d/%d，期望 3/5", got.FirstSeq, got.LastSeq)
	}
	if len(got.Records) != 3 || got.Records[0].Seq != 3 || got.Records[2].Seq != 5 {
		t.Fatalf("回绕后应保留 seq 3..5，得到 %+v", got.Records)
	}
}

func TestSinceLimitIsClamped(t *testing.T) {
	ring := mustRing(t, 10)
	appendRecords(ring, 5)

	if got := ring.Since(ring.Epoch(), 0, 0); len(got.Records) != MinLimit {
		t.Fatalf("limit=0 应 clamp 到 %d，得到 %d 条", MinLimit, len(got.Records))
	}
	if got := ring.Since(ring.Epoch(), 0, 2); len(got.Records) != 2 {
		t.Fatalf("limit=2 期望 2 条，得到 %d", len(got.Records))
	}
	large := mustRing(t, MaxLimit+100)
	appendRecords(large, MaxLimit+100)
	if got := large.Since(large.Epoch(), 0, MaxLimit+100); len(got.Records) != MaxLimit {
		t.Fatalf("limit 应 clamp 到 %d，得到 %d 条", MaxLimit, len(got.Records))
	}

	small := mustRing(t, 3)
	if small.Since(small.Epoch(), 0, 10).LastSeq != 0 {
		t.Fatal("没有记录时 LastSeq 应为 0")
	}
}

func TestStatsSnapshot(t *testing.T) {
	ring := mustRing(t, 4)
	appendRecords(ring, 2)

	stats := ring.Stats()
	if stats.Epoch != ring.Epoch() {
		t.Fatalf("stats.Epoch = %q，期望 %q", stats.Epoch, ring.Epoch())
	}
	if stats.Capacity != 4 || stats.Size != 2 {
		t.Fatalf("capacity/size = %d/%d，期望 4/2", stats.Capacity, stats.Size)
	}
	if stats.FirstSeq != 1 || stats.LastSeq != 2 {
		t.Fatalf("first/last = %d/%d，期望 1/2", stats.FirstSeq, stats.LastSeq)
	}
	if stats.Dropped != 0 || stats.Gap != 0 {
		t.Fatalf("没回绕时 dropped/gap 应为 0，得到 %d/%d", stats.Dropped, stats.Gap)
	}

	// Stats 是只读快照：连续调用不改任何状态。
	if again := ring.Stats(); again != stats {
		t.Fatalf("Stats 不应改变状态：%+v → %+v", stats, again)
	}
}

func TestStatsGapOnlyCountsUndeliveredRecords(t *testing.T) {
	ring := mustRing(t, 3)
	appendRecords(ring, 5)

	// 读者还没来：seq 1、2 被覆盖时都没被取走 → 真丢 2 条。
	stats := ring.Stats()
	if stats.Dropped != 2 || stats.Gap != 2 {
		t.Fatalf("dropped/gap = %d/%d，期望 2/2", stats.Dropped, stats.Gap)
	}

	// 读者取走 3..5；再写 3 条会覆盖 3、4、5，但它们已被取走 → 只有 churn，不再算 gap。
	if got := ring.Since(ring.Epoch(), 0, 10); len(got.Records) != 3 {
		t.Fatalf("期望取到 3 条，得到 %d", len(got.Records))
	}
	appendRecords(ring, 3)
	stats = ring.Stats()
	if stats.Dropped != 5 {
		t.Fatalf("dropped = %d，期望 5", stats.Dropped)
	}
	if stats.Gap != 2 {
		t.Fatalf("已投递记录被覆盖不应计入 gap：gap = %d，期望 2", stats.Gap)
	}
	if stats.Gap > stats.Dropped {
		t.Fatalf("gap(%d) 不能大于 dropped(%d)", stats.Gap, stats.Dropped)
	}
	if stats.FirstSeq != 6 || stats.LastSeq != 8 || stats.Size != 3 {
		t.Fatalf("回绕后的边界/占用不对：%+v", stats)
	}
}

// TestWrapDeliveryHasNoDuplicatesAndNoSilentLoss 模拟 TS 的轮询循环：
// 小容量缓冲持续回绕，分页拉取时必须「已投递的序号严格递增、不重复」，
// 且丢失的条数与 Go 侧的 gap 计数一致（回绕后不重复不丢）。
func TestWrapDeliveryHasNoDuplicatesAndNoSilentLoss(t *testing.T) {
	ring := mustRing(t, 4)
	appendRecords(ring, 10)

	seen := make([]int64, 0, 10)
	var afterSeq int64
	for {
		result := ring.Since(ring.Epoch(), afterSeq, 2)
		if len(result.Records) == 0 {
			break
		}
		for _, record := range result.Records {
			if record.Seq <= afterSeq {
				t.Fatalf("拉到了重复/倒退的序号 %d（afterSeq=%d）", record.Seq, afterSeq)
			}
			seen = append(seen, record.Seq)
			afterSeq = record.Seq
		}
	}
	expected := []int64{7, 8, 9, 10}
	if len(seen) != len(expected) {
		t.Fatalf("取到 %v，期望 %v", seen, expected)
	}
	for index, seq := range expected {
		if seen[index] != seq {
			t.Fatalf("取到 %v，期望 %v", seen, expected)
		}
	}
	stats := ring.Stats()
	if stats.Gap != 6 || stats.Dropped != 6 {
		t.Fatalf("没被任何人取走的 6 条应同时算进 dropped/gap：%+v", stats)
	}

	// 读者跟上之后再回绕：旧记录已投递，不应再增加 gap。
	appendRecords(ring, 4)
	afterSeq = 10
	pulled := 0
	for {
		result := ring.Since(ring.Epoch(), afterSeq, 2)
		if len(result.Records) == 0 {
			break
		}
		for _, record := range result.Records {
			if record.Seq <= afterSeq {
				t.Fatalf("第二轮拉到了重复序号 %d（afterSeq=%d）", record.Seq, afterSeq)
			}
			afterSeq = record.Seq
			pulled++
		}
	}
	if pulled != 4 {
		t.Fatalf("第二轮应取到 4 条新记录，得到 %d", pulled)
	}
	if stats = ring.Stats(); stats.Gap != 6 {
		t.Fatalf("读者跟得上时 gap 不应增长：%+v", stats)
	}
}

func TestNilRingStats(t *testing.T) {
	var ring *Ring
	if stats := ring.Stats(); stats != (StatsResult{}) {
		t.Fatalf("nil Ring 的 Stats 应为零值，得到 %+v", stats)
	}
}
