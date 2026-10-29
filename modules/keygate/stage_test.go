package keygate

import (
	"net/http"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/limits"
)

type fakeSpends struct {
	ready bool
	spent map[string]int64
	age   time.Duration
}

func (f fakeSpends) Ready() bool { return f.ready }
func (f fakeSpends) Lookup(keyID string) (int64, bool) {
	value, ok := f.spent[keyID]
	return value, ok
}
func (f fakeSpends) Age() time.Duration { return f.age }
func (f fakeSpends) TTL() time.Duration { return 15 * time.Second }

type fakeUsers map[string]int

func (f fakeUsers) ConcurrencyLimit(userID string) (int, bool) {
	limit, ok := f[userID]
	return limit, ok
}

func ctxWith(key *contracts.APIKey) *contracts.Ctx {
	return &contracts.Ctx{ReqID: "req-1", Meta: contracts.RequestMeta{Model: "m"}, Key: key}
}

func TestExpiredKeyIs401(t *testing.T) {
	past := time.Now().Add(-time.Minute)
	stage := New(Deps{}, nil)
	_, err := stage.Run(ctxWith(&contracts.APIKey{KeyID: "k", UserID: "1", ExpiresAt: &past}))
	var typed *contracts.StageError
	if err == nil {
		t.Fatalf("过期 key 必须被拒绝")
	}
	if !asStageError(err, &typed) || typed.Status != http.StatusUnauthorized || typed.Code != contracts.CodeAPIKeyExpired {
		t.Fatalf("错误不对：%v", err)
	}
	if typed.Retryable {
		t.Fatalf("过期不可重试")
	}
}

func TestNotExpiredPasses(t *testing.T) {
	future := time.Now().Add(time.Hour)
	stage := New(Deps{}, nil)
	decision, err := stage.Run(ctxWith(&contracts.APIKey{KeyID: "k", UserID: "1", ExpiresAt: &future}))
	if err != nil {
		t.Fatalf("未过期不该拒绝：%v", err)
	}
	if decision.Action != contracts.ActionContinue {
		t.Fatalf("应当继续")
	}
}

func TestSpendingLimitBlocks(t *testing.T) {
	limit := int64(1_000)
	stage := New(Deps{Spends: fakeSpends{ready: true, spent: map[string]int64{"k": 1_000}}}, nil)
	_, err := stage.Run(ctxWith(&contracts.APIKey{KeyID: "k", UserID: "1", SpendingLimitMicros: &limit}))
	var typed *contracts.StageError
	if err == nil || !asStageError(err, &typed) {
		t.Fatalf("达到金额上限必须被拒绝：%v", err)
	}
	if typed.Status != http.StatusPaymentRequired || typed.Code != contracts.CodeAPIKeySpendingLimit {
		t.Fatalf("错误不对：%d %s", typed.Status, typed.Code)
	}
}

func TestSpendingUnknownAllowsAndCounts(t *testing.T) {
	limit := int64(1_000)
	stage := New(Deps{Spends: fakeSpends{ready: false}}, nil)
	if _, err := stage.Run(ctxWith(&contracts.APIKey{KeyID: "k", UserID: "1", SpendingLimitMicros: &limit})); err != nil {
		t.Fatalf("消费快照不可用时按不限放行（可用性优先）：%v", err)
	}
	if stage.Stats().SpendingUnknown != 1 {
		t.Fatalf("必须计 SpendingUnknown")
	}
}

func TestKeyConcurrencyBlocksAndReleases(t *testing.T) {
	tracker := limits.New()
	stage := New(Deps{Reservations: tracker}, nil)
	key := &contracts.APIKey{KeyID: "k", UserID: "1", ConcurrencyLimit: 1}

	ctx := ctxWith(key)
	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("第一次预留应当成功：%v", err)
	}
	if ctx.ReleasePreSlot == nil {
		t.Fatalf("预留成功后必须写入 ReleasePreSlot")
	}

	_, err := stage.Run(ctxWith(key))
	var typed *contracts.StageError
	if err == nil || !asStageError(err, &typed) {
		t.Fatalf("并发满必须拒绝")
	}
	if typed.Status != http.StatusTooManyRequests || typed.Code != contracts.CodeAPIKeyConcurrencyLimit {
		t.Fatalf("错误不对：%d %s", typed.Status, typed.Code)
	}

	ctx.ReleasePreSlot()
	ctx.ReleasePreSlot() // 幂等：handler defer + panic 兜底会各调一次
	if got := tracker.InFlight(contracts.LimitScopeKeyPrefix + "k"); got != 0 {
		t.Fatalf("释放后必须归零：%d", got)
	}
}

func TestUserConcurrencyBlocksAndRollsBackKeySlot(t *testing.T) {
	tracker := limits.New()
	stage := New(Deps{Reservations: tracker, UserLimits: fakeUsers{"1": 1}}, nil)
	key := &contracts.APIKey{KeyID: "k", UserID: "1", ConcurrencyLimit: 5}

	if _, err := stage.Run(ctxWith(key)); err != nil {
		t.Fatalf("第一次预留应当成功：%v", err)
	}
	// 同一用户的另一把 key：用户级上限 1 已经满了。
	_, err := stage.Run(ctxWith(&contracts.APIKey{KeyID: "k2", UserID: "1", ConcurrencyLimit: 5}))
	var typed *contracts.StageError
	if err == nil || !asStageError(err, &typed) {
		t.Fatalf("用户并发满必须拒绝")
	}
	if typed.Code != contracts.CodeUserConcurrencyLimit {
		t.Fatalf("错误码不对：%s", typed.Code)
	}
	// 被拒的那次已经把 key 级槽位退回去了。
	if got := tracker.InFlight(contracts.LimitScopeKeyPrefix + "k2"); got != 0 {
		t.Fatalf("用户级拒绝后 key 级槽位必须退回：%d", got)
	}
}

func TestNoLimitsIsNoop(t *testing.T) {
	tracker := limits.New()
	stage := New(Deps{Reservations: tracker, Spends: fakeSpends{ready: true}}, nil)
	ctx := ctxWith(&contracts.APIKey{ID: "static", Profile: "billed"})
	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("没有上限时必须放行：%v", err)
	}
	if ctx.ReleasePreSlot != nil {
		t.Fatalf("没有上限时不该写 ReleasePreSlot")
	}
	if tracker.Active() != 0 {
		t.Fatalf("没有上限时不该占槽位")
	}
}

func asStageError(err error, target **contracts.StageError) bool {
	typed, ok := err.(*contracts.StageError)
	if ok {
		*target = typed
	}
	return ok
}
