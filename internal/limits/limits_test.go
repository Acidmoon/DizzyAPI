package limits

import (
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

func TestAcquireReleaseAndIdempotentRelease(t *testing.T) {
	tracker := New()
	release, ok := tracker.Acquire("key:a", 2)
	if !ok {
		t.Fatalf("第一次预留应当成功")
	}
	if _, ok := tracker.Acquire("key:a", 2); !ok {
		t.Fatalf("并发上限 2：第二次预留应当成功")
	}
	if _, ok := tracker.Acquire("key:a", 2); ok {
		t.Fatalf("并发上限 2：第三次预留必须失败（不排队）")
	}

	release()
	release() // 幂等：重复调用只减一次
	if got := tracker.InFlight("key:a"); got != 1 {
		t.Fatalf("release 幂等失败：in-flight = %d，期望 1", got)
	}
}

func TestAcquireWithoutLimitStillCounts(t *testing.T) {
	tracker := New()
	release, ok := tracker.Acquire(contracts.LimitScopeKeyPrefix+"k", 0)
	if !ok {
		t.Fatalf("limit<=0 必须永远成功")
	}
	if got := tracker.InFlight(contracts.LimitScopeKeyPrefix + "k"); got != 1 {
		t.Fatalf("不限并发也要计数：in-flight = %d", got)
	}
	release()
	if got := tracker.Active(); got != 0 {
		t.Fatalf("release 之后必须归零：active = %d", got)
	}
}

func TestSummarySeparatesKeyAndUserScopes(t *testing.T) {
	tracker := New()
	r1, _ := tracker.Acquire(contracts.LimitScopeKeyPrefix+"k1", 5)
	r2, _ := tracker.Acquire(contracts.LimitScopeUserPrefix+"1", 5)
	defer r1()
	defer r2()

	summary := tracker.Summary()
	if summary.ActiveKeys != 1 || summary.ActiveUsers != 1 {
		t.Fatalf("scope 分类错误：%+v", summary)
	}
}
