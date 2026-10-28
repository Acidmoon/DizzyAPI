package httpapi

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/engine"
	"github.com/Acidmoon/DizzyAPI/internal/quota"
	"github.com/Acidmoon/DizzyAPI/modules/quotagate"
)

// 额度闸门的验收口径走真实链路（httpapi → engine → quotagate）：被拒时客户端必须
// 收到 402 与 body 里的 INSUFFICIENT_BALANCE，而且 dispatch 一次都不许进。

func quotaHandler(t *testing.T, balances *quota.Cache, config quotagate.Config) (http.Handler, *atomic.Int64) {
	t.Helper()
	cache := accounts.New()
	if _, err := cache.Replace(accounts.Snapshot{
		Version: accounts.SnapshotVersion,
		Accounts: []accounts.Account{{
			AccountID: "acc-1", Provider: "openai", Kind: "api_key",
			BaseURL: "https://upstream.example/v1", Token: "sk-upstream", Concurrency: 2,
		}},
	}); err != nil {
		t.Fatalf("accounts.Replace: %v", err)
	}

	registry := contracts.NewRegistry()
	// 等价于 key-auth 的产出：写入 Ctx.Key（含 userId）。
	registry.Stage(&stubStage{
		name:  "key-auth",
		phase: contracts.PhasePre,
		run: func(ctx *contracts.Ctx) (contracts.Decision, error) {
			ctx.Key = &contracts.APIKey{KeyID: "key-1", UserID: "42"}
			return contracts.Decision{Action: contracts.ActionContinue}, nil
		},
	})
	if _, err := quotagate.Register(registry, config, balances, nil); err != nil {
		t.Fatalf("quotagate.Register: %v", err)
	}
	var dispatchCalls atomic.Int64
	// 等价于 accountpriority 的产出：写入排好序的候选，让 dispatch 有账号可试。
	registry.Stage(&stubStage{
		name:  "account-priority",
		phase: contracts.PhasePre,
		run: func(ctx *contracts.Ctx) (contracts.Decision, error) {
			ctx.AccountRoute = &contracts.AccountRoute{
				Strategy: "default",
				Ranked:   []contracts.ScoredAccount{{AccountID: "acc-1"}},
			}
			return contracts.Decision{Action: contracts.ActionContinue}, nil
		},
	})
	registry.Stage(&stubStage{
		name:  "dispatch",
		phase: contracts.PhaseDispatch,
		run: func(*contracts.Ctx) (contracts.Decision, error) {
			dispatchCalls.Add(1)
			return contracts.Decision{Action: contracts.ActionRespond, Status: http.StatusOK}, nil
		},
	})

	instance, err := engine.New(registry.Stages(), nil)
	if err != nil {
		t.Fatalf("engine.New: %v", err)
	}
	server, err := New(instance, cache, nil, Config{MaxBodyBytes: 1 << 20, TrustedProxyHops: 1})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	return server.Handler(), &dispatchCalls
}

func replaceBalance(t *testing.T, cache *quota.Cache, generation int64, balance string) {
	t.Helper()
	snapshot := quota.Snapshot{
		Version:    quota.SnapshotVersion,
		Generation: generation,
		Revision:   "rev-" + balance,
		Entries:    []quota.Entry{{UserID: "42", BalanceMicros: balance}},
	}
	if _, err := cache.Replace(snapshot); err != nil {
		t.Fatalf("quota.Replace: %v", err)
	}
}

func TestInsufficientBalanceRejectedBeforeDispatch(t *testing.T) {
	cache := quota.New(quota.WithTTL(10 * time.Second))
	replaceBalance(t, cache, 1, "0")
	handler, dispatchCalls := quotaHandler(t, cache, quotagate.Config{SnapshotTTL: 10 * time.Second})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, llmRequest(t, nil))

	if recorder.Code != http.StatusPaymentRequired {
		t.Fatalf("期望 402，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	payload := decodeErrorBody(t, recorder)
	if payload.Error.Code != contracts.CodeInsufficientBalance {
		t.Fatalf("响应体错误码应为 %s，得到 %q：%s",
			contracts.CodeInsufficientBalance, payload.Error.Code, recorder.Body.String())
	}
	if got := dispatchCalls.Load(); got != 0 {
		t.Fatalf("余额不足的请求不许进入 dispatch，实际执行了 %d 次", got)
	}
}

func TestSufficientBalanceReachesDispatch(t *testing.T) {
	cache := quota.New(quota.WithTTL(10 * time.Second))
	replaceBalance(t, cache, 1, "1000000")
	handler, dispatchCalls := quotaHandler(t, cache, quotagate.Config{SnapshotTTL: 10 * time.Second})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, llmRequest(t, nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("余额充足应放行，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if got := dispatchCalls.Load(); got != 1 {
		t.Fatalf("余额充足应进入 dispatch 一次，实际 %d", got)
	}
}

func TestMissingSnapshotPolicyThroughHttp(t *testing.T) {
	// 默认：放行（availability 优先，后付费结算兜底）。
	lenient := quota.New(quota.WithTTL(10 * time.Second))
	handler, dispatchCalls := quotaHandler(t, lenient, quotagate.Config{SnapshotTTL: 10 * time.Second})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, llmRequest(t, nil))
	if recorder.Code != http.StatusOK || dispatchCalls.Load() != 1 {
		t.Fatalf("默认策略应放行：%d dispatch=%d", recorder.Code, dispatchCalls.Load())
	}

	// 严格：503 且 body 带 QUOTA_SNAPSHOT_UNAVAILABLE，dispatch 不进。
	strict := quota.New(quota.WithTTL(10 * time.Second))
	strictHandler, strictCalls := quotaHandler(t, strict, quotagate.Config{
		SnapshotTTL: 10 * time.Second, RequireSnapshot: true,
	})
	recorder = httptest.NewRecorder()
	strictHandler.ServeHTTP(recorder, llmRequest(t, nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("严格模式应回 503，得到 %d", recorder.Code)
	}
	payload := decodeErrorBody(t, recorder)
	if payload.Error.Code != contracts.CodeQuotaSnapshotUnavailable {
		t.Fatalf("响应体错误码应为 %s，得到 %q",
			contracts.CodeQuotaSnapshotUnavailable, payload.Error.Code)
	}
	if got := strictCalls.Load(); got != 0 {
		t.Fatalf("严格模式拒绝的请求不许进入 dispatch，实际 %d", got)
	}
}
