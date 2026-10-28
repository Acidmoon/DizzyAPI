package accountruntime

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

func TestAcquireRespectsConcurrency(t *testing.T) {
	tracker := New(0)

	release, ok := tracker.Acquire("acc", 2)
	if !ok {
		t.Fatal("第一个槽位应当拿到")
	}
	if _, ok := tracker.Acquire("acc", 2); !ok {
		t.Fatal("第二个槽位应当拿到")
	}
	if _, ok := tracker.Acquire("acc", 2); ok {
		t.Fatal("concurrency=2 时第三个槽位必须被拒绝")
	}
	if got := tracker.InFlight("acc"); got != 2 {
		t.Fatalf("InFlight = %d，期望 2", got)
	}

	release()
	release() // 幂等：重复调用只减一次
	if got := tracker.InFlight("acc"); got != 1 {
		t.Fatalf("重复 release 不应多减：InFlight = %d，期望 1", got)
	}
	release, ok = tracker.Acquire("acc", 2)
	if !ok {
		t.Fatal("释放后应当能重新拿到槽位")
	}
	release()
}

func TestAcquireWithoutConcurrencyIsUnlimited(t *testing.T) {
	tracker := New(0)
	for index := 0; index < 100; index += 1 {
		release, ok := tracker.Acquire("old-account", 0)
		if !ok {
			t.Fatalf("未声明 concurrency（0）时第 %d 个槽位不应被拒绝", index+1)
		}
		defer release()
	}
	if got := tracker.InFlight("old-account"); got != 100 {
		t.Fatalf("InFlight = %d，期望 100（仍然计数，但不限流）", got)
	}
}

// TestConcurrentAcquireNeverExceedsConcurrency 用并发压一遍原子性：
// 同时刻的活跃数绝不能超过声明的上限。
func TestConcurrentAcquireNeverExceedsConcurrency(t *testing.T) {
	tracker := New(0)
	const limit = 5
	const workers = 200
	var maxActive atomic.Int64
	var active atomic.Int64
	var wg sync.WaitGroup
	for index := 0; index < workers; index += 1 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, ok := tracker.Acquire("acc", limit)
			if !ok {
				return
			}
			current := active.Add(1)
			for {
				observed := maxActive.Load()
				if current <= observed || maxActive.CompareAndSwap(observed, current) {
					break
				}
			}
			time.Sleep(time.Millisecond)
			active.Add(-1)
			release()
		}()
	}
	wg.Wait()
	if got := maxActive.Load(); got > limit {
		t.Fatalf("同时刻活跃数 %d 超过了并发上限 %d", got, limit)
	}
	if got := tracker.Active(); got != 0 {
		t.Fatalf("全部结束后活跃数应归零，得到 %d", got)
	}
}

func TestApplyWritesInFlightAndCooldown(t *testing.T) {
	now := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)
	tracker := New(30*time.Second, WithClock(func() time.Time { return now }))
	if release, ok := tracker.Acquire("hot", 10); !ok {
		t.Fatal("Acquire 失败")
	} else {
		defer release()
	}
	tracker.RecordLimit("limited")

	candidates := []contracts.AccountCandidate{
		{AccountID: "hot", Concurrency: 10},
		{AccountID: "limited"},
		{AccountID: "idle"},
	}
	tracker.Apply(candidates)

	if candidates[0].InFlight != 1 {
		t.Fatalf("hot.InFlight = %d，期望 1", candidates[0].InFlight)
	}
	if candidates[0].CooldownUntil != nil {
		t.Fatalf("hot 不应有冷却：%+v", candidates[0].CooldownUntil)
	}
	if candidates[1].CooldownUntil == nil || !candidates[1].CooldownUntil.Equal(now.Add(30*time.Second)) {
		t.Fatalf("limited.CooldownUntil = %+v，期望 %v", candidates[1].CooldownUntil, now.Add(30*time.Second))
	}
	if candidates[2].InFlight != 0 || candidates[2].CooldownUntil != nil {
		t.Fatalf("idle 不应有运行时状态：%+v", candidates[2])
	}
}

func TestCooldownExpiresAutomatically(t *testing.T) {
	now := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)
	tracker := New(30*time.Second, WithClock(func() time.Time { return now }))
	tracker.RecordLimit("acc")
	if _, ok := tracker.CoolingUntil("acc"); !ok {
		t.Fatal("刚记录的冷却应当生效")
	}

	candidates := []contracts.AccountCandidate{{AccountID: "acc"}}
	now = now.Add(31 * time.Second)
	tracker.Apply(candidates)
	if candidates[0].CooldownUntil != nil {
		t.Fatalf("冷却到期后必须自动恢复：%+v", candidates[0].CooldownUntil)
	}
	if _, ok := tracker.CoolingUntil("acc"); ok {
		t.Fatal("过期冷却不应再报告为冷却中")
	}
}

func TestRecordLimitDisabledWhenCooldownZero(t *testing.T) {
	tracker := New(0)
	tracker.RecordLimit("acc")
	if _, ok := tracker.CoolingUntil("acc"); ok {
		t.Fatal("cooldown=0 表示关闭冷却，不应记录")
	}
}

func TestSummaryAggregatesActiveAndCooling(t *testing.T) {
	now := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)
	tracker := New(30*time.Second, WithClock(func() time.Time { return now }))
	if stats := tracker.Summary(); stats.Active != 0 || stats.Cooling != 0 {
		t.Fatalf("空白运行时应全为 0：%+v", stats)
	}

	release1, _ := tracker.Acquire("acc-1", 0)
	release2, _ := tracker.Acquire("acc-1", 0)
	tracker.RecordLimit("acc-1")
	tracker.RecordLimit("acc-2")
	stats := tracker.Summary()
	if stats.Active != 2 || stats.Cooling != 2 {
		t.Fatalf("aggregate = %+v，期望 active=2 cooling=2", stats)
	}

	// 冷却到期后冷却计数归零，活跃数不受影响。
	now = now.Add(31 * time.Second)
	if stats := tracker.Summary(); stats.Active != 2 || stats.Cooling != 0 {
		t.Fatalf("冷却到期后 aggregate = %+v，期望 active=2 cooling=0", stats)
	}
	release1()
	release2()
	if stats := tracker.Summary(); stats.Active != 0 {
		t.Fatalf("释放后活跃数应归零：%+v", stats)
	}
}

func TestNilTrackerIsSafe(t *testing.T) {
	var tracker *Tracker
	release, ok := tracker.Acquire("acc", 1)
	if !ok {
		t.Fatal("nil Tracker 应视为不限流")
	}
	release()
	tracker.RecordLimit("acc")
	tracker.Apply(nil)
	if tracker.InFlight("acc") != 0 || tracker.Active() != 0 {
		t.Fatal("nil Tracker 的观察值应全为 0")
	}
}
