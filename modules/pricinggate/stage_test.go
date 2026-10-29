package pricinggate

import (
	"net/http"
	"testing"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

type fakePrices struct {
	ready    bool
	priced   map[string]struct{}
	wildcard bool
	age      time.Duration
	ttl      time.Duration
}

func (f fakePrices) Ready() bool { return f.ready }
func (f fakePrices) Priced(model string) bool {
	if f.wildcard {
		return true
	}
	_, ok := f.priced[model]
	return ok
}
func (f fakePrices) Age() time.Duration { return f.age }
func (f fakePrices) TTL() time.Duration { return f.ttl }

func ctxWithModel(model string) *contracts.Ctx {
	return &contracts.Ctx{ReqID: "req-1", Meta: contracts.RequestMeta{Model: model}}
}

func TestNoSnapshotIs503(t *testing.T) {
	stage := New(Config{}, fakePrices{ready: false}, nil)
	_, err := stage.Run(ctxWithModel("m"))
	typed, ok := err.(*contracts.StageError)
	if !ok {
		t.Fatalf("没有快照必须拒绝（fail-closed）：%v", err)
	}
	if typed.Status != http.StatusServiceUnavailable || typed.Code != contracts.CodePricingSnapshotUnavailable {
		t.Fatalf("错误不对：%d %s", typed.Status, typed.Code)
	}
	if typed.Retryable {
		t.Fatalf("快照不可用不可重试")
	}
	if stage.Stats().StrictBlocked != 1 {
		t.Fatalf("必须计 StrictBlocked")
	}
}

func TestStaleSnapshotIs503(t *testing.T) {
	stage := New(Config{SnapshotTTL: time.Second}, fakePrices{
		ready: true, priced: map[string]struct{}{"m": {}}, age: 5 * time.Second, ttl: time.Second,
	}, nil)
	_, err := stage.Run(ctxWithModel("m"))
	typed, ok := err.(*contracts.StageError)
	if !ok || typed.Code != contracts.CodePricingSnapshotUnavailable {
		t.Fatalf("过期快照必须 503：%v", err)
	}
}

func TestUnpricedModelIs403AndDoesNotForward(t *testing.T) {
	stage := New(Config{}, fakePrices{
		ready: true, priced: map[string]struct{}{"deepseek-flash": {}}, ttl: time.Minute,
	}, nil)
	_, err := stage.Run(ctxWithModel("gpt-4o"))
	typed, ok := err.(*contracts.StageError)
	if !ok {
		t.Fatalf("未定价模型必须拒绝：%v", err)
	}
	if typed.Status != http.StatusForbidden || typed.Code != contracts.CodeModelNotPriced {
		t.Fatalf("错误不对：%d %s", typed.Status, typed.Code)
	}
	if typed.Retryable {
		t.Fatalf("未定价不可重试")
	}
	if stage.Stats().Blocked != 1 {
		t.Fatalf("必须计 Blocked")
	}
}

func TestPricedModelPasses(t *testing.T) {
	stage := New(Config{}, fakePrices{
		ready: true, priced: map[string]struct{}{"deepseek-flash": {}}, ttl: time.Minute,
	}, nil)
	decision, err := stage.Run(ctxWithModel("deepseek-flash"))
	if err != nil {
		t.Fatalf("有价模型必须放行：%v", err)
	}
	if decision.Action != contracts.ActionContinue {
		t.Fatalf("应当继续")
	}
	if stage.Stats().Allowed != 1 {
		t.Fatalf("必须计 Allowed")
	}
}

func TestWildcardAllowsEveryModel(t *testing.T) {
	stage := New(Config{}, fakePrices{ready: true, wildcard: true, ttl: time.Minute}, nil)
	for _, model := range []string{"a", "b", "从没配过的模型"} {
		if _, err := stage.Run(ctxWithModel(model)); err != nil {
			t.Fatalf("有 * 兜底时 %q 必须放行：%v", model, err)
		}
	}
}

func TestEmptyModelIsIgnored(t *testing.T) {
	stage := New(Config{}, fakePrices{ready: true, ttl: time.Minute}, nil)
	if _, err := stage.Run(ctxWithModel("")); err != nil {
		t.Fatalf("空模型不在这层判（入口已经拒了）：%v", err)
	}
}

func TestNilPricesIsFailClosed(t *testing.T) {
	stage := New(Config{}, nil, nil)
	_, err := stage.Run(ctxWithModel("m"))
	typed, ok := err.(*contracts.StageError)
	if !ok || typed.Code != contracts.CodePricingSnapshotUnavailable {
		t.Fatalf("没有价格来源必须 503（fail-closed）：%v", err)
	}
}
