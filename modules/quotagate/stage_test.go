package quotagate

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

type fakeBalances struct {
	ready    bool
	balances map[string]int64
	age      time.Duration
	ttl      time.Duration
}

func (f *fakeBalances) Ready() bool { return f.ready }

func (f *fakeBalances) Lookup(userID string) (int64, bool) {
	balance, ok := f.balances[userID]
	return balance, ok
}

func (f *fakeBalances) Age() time.Duration { return f.age }

func (f *fakeBalances) TTL() time.Duration { return f.ttl }

func keyCtx(userID string) *contracts.Ctx {
	ctx := &contracts.Ctx{Context: context.Background(), ReqID: "req-quota"}
	if userID != "" {
		ctx.Key = &contracts.APIKey{KeyID: "key-1", UserID: userID}
	}
	return ctx
}

func newStage(t *testing.T, cfg Config, balances Balances) *Stage {
	t.Helper()
	return New(cfg, balances, nil)
}

// codeOf 取错误的稳定码；不是 StageError 时返回空字符串。
func codeOf(err error) (string, *contracts.StageError) {
	stageErr, ok := err.(*contracts.StageError)
	if !ok {
		return "", nil
	}
	return stageErr.Code, stageErr
}

func TestEnoughBalanceIsAllowed(t *testing.T) {
	stage := newStage(t, Config{SnapshotTTL: 15 * time.Second}, &fakeBalances{
		ready:    true,
		balances: map[string]int64{"42": 1_000_000},
	})
	decision, err := stage.Run(keyCtx("42"))
	if err != nil {
		t.Fatalf("余额充足不该拒绝：%v", err)
	}
	if decision.Action != contracts.ActionContinue {
		t.Fatalf("余额充足应继续：%+v", decision)
	}
}

// TestZeroAndNegativeBalanceRejected：那是本条线的验收口径——402、不可重试。
func TestZeroAndNegativeBalanceRejected(t *testing.T) {
	for _, balance := range []int64{0, -1, -5_000_000} {
		stage := newStage(t, Config{SnapshotTTL: 15 * time.Second}, &fakeBalances{
			ready:    true,
			balances: map[string]int64{"42": balance},
		})
		_, err := stage.Run(keyCtx("42"))
		if err == nil {
			t.Fatalf("余额 %d 必须拒绝", balance)
		}
		code, stageErr := codeOf(err)
		if code != contracts.CodeInsufficientBalance {
			t.Fatalf("余额 %d 的错误码应为 %s，得到 %v", balance, contracts.CodeInsufficientBalance, err)
		}
		if stageErr.Status != http.StatusPaymentRequired {
			t.Fatalf("余额 %d 应回 402，得到 %d", balance, stageErr.Status)
		}
		if stageErr.Retryable {
			t.Fatalf("余额 %d 的拒绝必须不可重试", balance)
		}
	}
}

// TestMinBalanceThreshold：余额 ≤ 阈值一律拒绝（含等于），高于阈值才放行。
func TestMinBalanceThreshold(t *testing.T) {
	stage := newStage(t, Config{SnapshotTTL: 15 * time.Second, MinBalanceMicros: 500_000}, &fakeBalances{
		ready:    true,
		balances: map[string]int64{"42": 499_999, "43": 500_000, "44": 500_001},
	})
	for _, userID := range []string{"42", "43"} {
		if _, err := stage.Run(keyCtx(userID)); err == nil {
			t.Fatalf("用户 %s 的余额 ≤ 阈值必须拒绝", userID)
		}
	}
	if _, err := stage.Run(keyCtx("44")); err != nil {
		t.Fatalf("高于阈值应当放行：%v", err)
	}
}

func TestStaticKeyIsNotPrechecked(t *testing.T) {
	// 没有 Key 或 Key.UserID 为空 = 静态 key / 未鉴权路径：不预检。
	stage := newStage(t, Config{SnapshotTTL: 15 * time.Second, RequireSnapshot: true}, &fakeBalances{
		ready: false,
	})
	for _, ctx := range []*contracts.Ctx{nil, keyCtx(""), {Context: context.Background()}} {
		decision, err := stage.Run(ctx)
		if err != nil {
			t.Fatalf("没有 userId 时不该拒绝：%v", err)
		}
		if decision.Action != contracts.ActionContinue {
			t.Fatalf("没有 userId 时应继续：%+v", decision)
		}
	}
}

func TestSnapshotUnavailableFailsOpenByDefault(t *testing.T) {
	stage := newStage(t, Config{SnapshotTTL: 15 * time.Second}, &fakeBalances{ready: false})
	decision, err := stage.Run(keyCtx("42"))
	if err != nil {
		t.Fatalf("默认策略是放行 + 告警：%v", err)
	}
	if decision.Action != contracts.ActionContinue {
		t.Fatalf("默认策略应继续：%+v", decision)
	}
	if stage.Stats().AllowedUnknown != 1 {
		t.Fatalf("应记一次放行：%+v", stage.Stats())
	}
}

func TestSnapshotUnavailableFailsClosedInStrictMode(t *testing.T) {
	stage := newStage(t, Config{SnapshotTTL: 15 * time.Second, RequireSnapshot: true}, &fakeBalances{ready: false})
	_, err := stage.Run(keyCtx("42"))
	if err == nil {
		t.Fatal("严格模式下快照未就绪必须拒绝")
	}
	code, stageErr := codeOf(err)
	if code != contracts.CodeQuotaSnapshotUnavailable {
		t.Fatalf("错误码应为 %s，得到 %v", contracts.CodeQuotaSnapshotUnavailable, err)
	}
	if stageErr.Status != http.StatusServiceUnavailable || stageErr.Retryable {
		t.Fatalf("严格模式必须是 503 且不可重试：%+v", stageErr)
	}
}

func TestExpiredSnapshotFollowsPolicy(t *testing.T) {
	expired := func() *fakeBalances {
		return &fakeBalances{ready: true, balances: map[string]int64{"42": 1_000_000}, age: 30 * time.Second, ttl: 15 * time.Second}
	}
	lenient := newStage(t, Config{SnapshotTTL: 15 * time.Second}, expired())
	if _, err := lenient.Run(keyCtx("42")); err != nil {
		t.Fatalf("默认模式 TTL 过期应放行：%v", err)
	}
	strict := newStage(t, Config{SnapshotTTL: 15 * time.Second, RequireSnapshot: true}, expired())
	if _, err := strict.Run(keyCtx("42")); err == nil {
		t.Fatal("严格模式 TTL 过期必须拒绝")
	}

	// 快照自带的 TTL 优先于配置缺省值：两者都过期才算过期。
	fresh := &fakeBalances{ready: true, balances: map[string]int64{"42": 1_000_000}, age: 30 * time.Second, ttl: 60 * time.Second}
	if _, err := newStage(t, Config{RequireSnapshot: true}, fresh).Run(keyCtx("42")); err != nil {
		t.Fatalf("配置 TTL 为 0 时应取快照的 TTL（60s）：%v", err)
	}
}

func TestUnknownUserFollowsPolicy(t *testing.T) {
	balances := &fakeBalances{ready: true, balances: map[string]int64{"43": 1_000_000}}
	if _, err := newStage(t, Config{SnapshotTTL: time.Second}, balances).Run(keyCtx("42")); err != nil {
		t.Fatalf("默认模式查不到用户应放行：%v", err)
	}
	_, err := newStage(t, Config{SnapshotTTL: time.Second, RequireSnapshot: true}, balances).Run(keyCtx("42"))
	if err == nil {
		t.Fatal("严格模式查不到用户必须拒绝")
	}
	if code, _ := codeOf(err); code != contracts.CodeQuotaSnapshotUnavailable {
		t.Fatalf("错误码应为 %s，得到 %v", contracts.CodeQuotaSnapshotUnavailable, err)
	}
}

// TestWarnIsThrottled：快照没就绪时每 5 秒一次请求，不能每个请求刷一行日志。
func TestWarnIsThrottled(t *testing.T) {
	var buffer bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buffer, &slog.HandlerOptions{Level: slog.LevelWarn}))
	now := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)
	stage := New(Config{SnapshotTTL: time.Second}, &fakeBalances{ready: false}, logger)
	stage.now = func() time.Time { return now }

	for index := 0; index < 5; index++ {
		if _, err := stage.Run(keyCtx("42")); err != nil {
			t.Fatalf("放行路径不该报错：%v", err)
		}
	}
	if lines := strings.Count(buffer.String(), "余额快照不可用"); lines != 1 {
		t.Fatalf("同一原因默认每 %s 最多一行，实际 %d 行：%s", DefaultWarnInterval, lines, buffer.String())
	}
	now = now.Add(DefaultWarnInterval + time.Second)
	if _, err := stage.Run(keyCtx("42")); err != nil {
		t.Fatalf("放行路径不该报错：%v", err)
	}
	if lines := strings.Count(buffer.String(), "余额快照不可用"); lines != 2 {
		t.Fatalf("过了节流窗口应当再报一行，实际 %d 行", lines)
	}
}

func TestRegisterValidatesConfig(t *testing.T) {
	registry := contracts.NewRegistry()
	if _, err := Register(registry, Config{SnapshotTTL: time.Second}, &fakeBalances{ttl: time.Second}, nil); err != nil {
		t.Fatalf("合法配置不该失败：%v", err)
	}
	if _, err := Register(nil, Config{}, &fakeBalances{}, nil); err == nil {
		t.Fatal("Registry 为 nil 必须失败")
	}
	if _, err := Register(contracts.NewRegistry(), Config{SnapshotTTL: -time.Second}, &fakeBalances{}, nil); err == nil {
		t.Fatal("负数 TTL 必须失败")
	}
	// 配置 TTL 为 0 时回落到余额缓存的 TTL。
	snapshot := &fakeBalances{ttl: 7 * time.Second}
	stage, err := Register(contracts.NewRegistry(), Config{}, snapshot, nil)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if stage.config.SnapshotTTL != 7*time.Second {
		t.Fatalf("TTL 应回落到快照的 7s，得到 %s", stage.config.SnapshotTTL)
	}
	if len(registry.Stages()) != 1 || registry.Stages()[0].Name() != StageName {
		t.Fatalf("阶段没有注册成功：%+v", registry.Stages())
	}
	if registry.Stages()[0].Phase() != contracts.PhasePre || !registry.Stages()[0].Required() {
		t.Fatalf("额度闸门必须是 pre 相位且必需：%+v", registry.Stages()[0])
	}
}
