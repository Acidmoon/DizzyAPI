package quota

import (
	"strings"
	"testing"
	"time"
)

func snapshotOf(generation int64, revision string, entries ...Entry) Snapshot {
	return Snapshot{Version: SnapshotVersion, Generation: generation, Revision: revision, Entries: entries}
}

func TestReplaceAcceptsValidSnapshotAndLooksUpBalance(t *testing.T) {
	cache := New()
	if cache.Ready() {
		t.Fatal("还没收到快照时 Ready 必须是 false")
	}
	result, err := cache.Replace(snapshotOf(10, "rev-1",
		Entry{UserID: "7", BalanceMicros: "1500000"},
		Entry{UserID: "8", BalanceMicros: "-250000"},
	))
	if err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if !cache.Ready() || result.Entries != 2 || result.Revision != "rev-1" {
		t.Fatalf("结果不对：%+v", result)
	}
	if balance, ok := cache.Lookup("7"); !ok || balance != 1_500_000 {
		t.Fatalf("用户 7 的余额应为 1500000，得到 %d ok=%v", balance, ok)
	}
	// 余额允许为负（后付费透支）。
	if balance, ok := cache.Lookup("8"); !ok || balance != -250_000 {
		t.Fatalf("用户 8 的余额应为 -250000，得到 %d ok=%v", balance, ok)
	}
	if _, ok := cache.Lookup("9"); ok {
		t.Fatal("快照里没有的用户必须 ok=false")
	}
}

func TestEmptySnapshotIsReadyButCoversNoUser(t *testing.T) {
	cache := New()
	if _, err := cache.Replace(snapshotOf(1, "rev-empty")); err != nil {
		t.Fatalf("合法的空快照必须被接受：%v", err)
	}
	if !cache.Ready() {
		t.Fatal("空快照也算「已收到」")
	}
	if _, ok := cache.Lookup("1"); ok {
		t.Fatal("空快照里没有用户")
	}
}

func TestReplaceRejectsInvalidSnapshot(t *testing.T) {
	cases := []struct {
		name     string
		snapshot Snapshot
		code     string
	}{
		{"版本不对", Snapshot{Version: 2, Generation: 1, Revision: "r", Entries: []Entry{{UserID: "1", BalanceMicros: "0"}}}, CodeInvalidSnapshot},
		{"generation 非正", snapshotOf(0, "r", Entry{UserID: "1", BalanceMicros: "0"}), CodeInvalidSnapshot},
		{"revision 为空", snapshotOf(1, "", Entry{UserID: "1", BalanceMicros: "0"}), CodeInvalidSnapshot},
		{"userId 为空", snapshotOf(1, "r", Entry{UserID: "", BalanceMicros: "0"}), CodeInvalidSnapshot},
		{"userId 不是数字", snapshotOf(1, "r", Entry{UserID: "u1", BalanceMicros: "0"}), CodeInvalidSnapshot},
		{"余额是浮点", snapshotOf(1, "r", Entry{UserID: "1", BalanceMicros: "1.5"}), CodeInvalidBalance},
		{"余额不可解析", snapshotOf(1, "r", Entry{UserID: "1", BalanceMicros: "abc"}), CodeInvalidBalance},
		{"余额溢出 int64", snapshotOf(1, "r", Entry{UserID: "1", BalanceMicros: "9223372036854775808"}), CodeInvalidBalance},
		{
			"userId 重复",
			snapshotOf(1, "r",
				Entry{UserID: "1", BalanceMicros: "0"},
				Entry{UserID: "1", BalanceMicros: "1"}),
			CodeDuplicateUser,
		},
	}
	for _, tc := range cases {
		cache := New()
		if _, err := cache.Replace(tc.snapshot); err == nil {
			t.Fatalf("%s：必须明确失败", tc.name)
		} else {
			var typed *Error
			if !asQuotaError(err, &typed) || typed.Code != tc.code {
				t.Fatalf("%s：错误码应为 %s，得到 %v", tc.name, tc.code, err)
			}
		}
		if cache.Ready() {
			t.Fatalf("%s：非法快照不许被应用", tc.name)
		}
	}
}

func TestReplaceRejectsGenerationRegression(t *testing.T) {
	cache := New()
	if _, err := cache.Replace(snapshotOf(100, "rev-new", Entry{UserID: "1", BalanceMicros: "100"})); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	_, err := cache.Replace(snapshotOf(99, "rev-old", Entry{UserID: "1", BalanceMicros: "0"}))
	if err == nil {
		t.Fatal("generation 回退必须明确拒绝")
	}
	if !strings.Contains(err.Error(), CodeStaleSnapshot) {
		t.Fatalf("错误码应为 %s：%v", CodeStaleSnapshot, err)
	}
	// 旧快照不许覆盖当前快照。
	if balance, _ := cache.Lookup("1"); balance != 100 {
		t.Fatalf("回退的快照不许覆盖当前快照，余额得到 %d", balance)
	}
}

func TestSameGenerationSameRevisionIsIdempotent(t *testing.T) {
	cache := New()
	if _, err := cache.Replace(snapshotOf(5, "rev-a", Entry{UserID: "1", BalanceMicros: "100"})); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	result, err := cache.Replace(snapshotOf(5, "rev-a", Entry{UserID: "1", BalanceMicros: "100"}))
	if err != nil {
		t.Fatalf("同 generation 同 revision 的重复推送应当幂等成功：%v", err)
	}
	if result.Entries != 1 {
		t.Fatalf("幂等返回的 entries 不对：%+v", result)
	}
	// 同 generation 但内容不同：这是冲突，明确拒绝。
	if _, err := cache.Replace(snapshotOf(5, "rev-b", Entry{UserID: "1", BalanceMicros: "200"})); err == nil {
		t.Fatal("同 generation 不同 revision 必须拒绝")
	} else if !strings.Contains(err.Error(), CodeStaleSnapshot) {
		t.Fatalf("错误码应为 %s：%v", CodeStaleSnapshot, err)
	}
}

func TestStateReportsAgeAndTTL(t *testing.T) {
	now := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)
	cache := New(WithTTL(15*time.Second), WithClock(func() time.Time { return now }))
	state := cache.State()
	if state.Ready || state.TtlMs != 15_000 || state.AgeMs != 0 {
		t.Fatalf("未收到快照时 State 不对：%+v", state)
	}

	if _, err := cache.Replace(snapshotOf(1, "rev", Entry{UserID: "1", BalanceMicros: "0"})); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	now = now.Add(4 * time.Second)
	state = cache.State()
	if !state.Ready || state.Size != 1 || state.AgeMs != 4_000 || state.TtlMs != 15_000 {
		t.Fatalf("State 不对：%+v", state)
	}
	if cache.Stale() {
		t.Fatal("4 秒龄的快照还不算过期")
	}
	now = now.Add(12 * time.Second)
	if !cache.Stale() {
		t.Fatal("16 秒龄超过 15 秒 TTL，必须判过期")
	}
}

func TestNilCacheIsSafe(t *testing.T) {
	var cache *Cache
	if cache.Ready() {
		t.Fatal("nil 缓存不是 Ready")
	}
	if _, ok := cache.Lookup("1"); ok {
		t.Fatal("nil 缓存查不到任何用户")
	}
	if !cache.Stale() {
		t.Fatal("nil 缓存视为过期")
	}
	if cache.TTL() != 0 || cache.Age() != 0 {
		t.Fatal("nil 缓存的 TTL / Age 应为 0")
	}
	if _, err := cache.Replace(snapshotOf(1, "r")); err == nil {
		t.Fatal("nil 缓存 Replace 必须失败")
	}
}

// asQuotaError 是 errors.As 的小包装，避免测试里到处 import errors。
func asQuotaError(err error, target **Error) bool {
	for err != nil {
		if typed, ok := err.(*Error); ok {
			*target = typed
			return true
		}
		unwrapped, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapped.Unwrap()
	}
	return false
}
