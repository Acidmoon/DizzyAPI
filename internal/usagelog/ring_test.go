package usagelog

import (
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

func appendRecords(ring *Ring, count int) {
	for index := 0; index < count; index++ {
		ring.Append(contracts.UsageRecord{RequestID: "req"})
	}
}

func TestEmptyRing(t *testing.T) {
	ring := NewRing(4)
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
	ring := NewRing(4)
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
	ring := NewRing(4)
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
	ring := NewRing(4)
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
	ring := NewRing(3)
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
	ring := NewRing(10)
	appendRecords(ring, 5)

	if got := ring.Since(ring.Epoch(), 0, 0); len(got.Records) != MinLimit {
		t.Fatalf("limit=0 应 clamp 到 %d，得到 %d 条", MinLimit, len(got.Records))
	}
	if got := ring.Since(ring.Epoch(), 0, 2); len(got.Records) != 2 {
		t.Fatalf("limit=2 期望 2 条，得到 %d", len(got.Records))
	}
	large := NewRing(MaxLimit + 100)
	appendRecords(large, MaxLimit+100)
	if got := large.Since(large.Epoch(), 0, MaxLimit+100); len(got.Records) != MaxLimit {
		t.Fatalf("limit 应 clamp 到 %d，得到 %d 条", MaxLimit, len(got.Records))
	}

	small := NewRing(3)
	if small.Since(small.Epoch(), 0, 10).LastSeq != 0 {
		t.Fatal("没有记录时 LastSeq 应为 0")
	}
}
