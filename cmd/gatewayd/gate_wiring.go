package main

import (
	"fmt"
	"log/slog"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/keyspend"
	"github.com/Acidmoon/DizzyAPI/internal/limits"
	pricingcache "github.com/Acidmoon/DizzyAPI/internal/pricing"
	"github.com/Acidmoon/DizzyAPI/modules/keygate"
	"github.com/Acidmoon/DizzyAPI/modules/pricinggate"
)

// 本文件是**闸门侧的装配**：创建缓存、注册 pre 相位阶段、算出阶段依赖。
//
// 组合根（main.go）只留调用与赋值；具体做什么在这里。
// 阶段注册顺序 = 阶段顺序（pre → dispatch → post），所以 key-gate 必须
// 紧跟 key-auth 注册（它要读 key-auth 写进 ctx.Key 的上限）。

// gateWiring 是闸门侧装配的结果：组合根把它塞进 handler。
type gateWiring struct {
	// spend 是每个 key 的累计消费快照（TS 心跳式推送；key 级金额上限判定用）。
	spend *keyspend.Cache
	// pricingCache 是价格快照（定价闸门判定「有没有价」）。
	pricingCache *pricingcache.Cache
	// keyGate 是 key 级执行面阶段（过期 / 金额上限 / key 并发 / 用户并发）。
	keyGate *keygate.Stage
	// keyLimits 是 key 级与用户级并发共用的原子预留。
	keyLimits *limits.Tracker
	// pricingGate 是定价闸门阶段。**默认关**：没开 `-pricing-gate` 时它是 nil，
	// 阶段根本没注册，「关」是真正零行为。
	pricingGate *pricinggate.Stage
	// pricingTTLMs / keySpendTTLMs 是两份快照的有效期（毫秒，供启动日志）。
	pricingTTLMs  int64
	keySpendTTLMs int64
	// pricingOn 是定价闸门是否打开（供启动日志）。
	pricingOn bool
}

// newGateWiring 创建闸门侧的缓存与阶段。
//
// 参数：
//   - registry 是阶段注册表（组合根是唯一组装点）；
//   - userLimits 是用户级并发上限的来源（余额快照，quota.Cache 实现了它）；
//   - flags 是命令行配置；
//   - logger 是进程日志。
//
// 装配顺序（也是阶段顺序）：
//
//	keyauth → key-gate（pre）→ pricing-gate（pre，默认关）→ contentaudit → quotagate
//
// key-gate 必须紧跟 key-auth：它要读 key-auth 写进 ctx.Key 的三个上限。
func newGateWiring(
	registry *contracts.Registry,
	userLimits keygate.UserLimits,
	flags *gateFlags,
	logger *slog.Logger,
) (*gateWiring, error) {
	// 价格快照（定价闸门用）：纯内存只读缓存，价格权威数据在 TS 的 pricing 插件里。
	// 闸门只判「有没有价」，算钱仍然只在 TS（一个数据一个写者）。
	pricingTTL, err := parseGateSnapshotTTL("-pricing-snapshot-ttl-ms", *flags.pricingSnapshotTTLMs)
	if err != nil {
		return nil, err
	}
	pricingCache := pricingcache.New(pricingcache.WithTTL(pricingTTL))

	// key 消费快照（金额上限判定用）：花钱的事实只有 TS 知道，Go 只读、只比大小。
	keySpendTTL, err := parseGateSnapshotTTL("-keyspend-snapshot-ttl-ms", *flags.keySpendSnapshotTTLMs)
	if err != nil {
		return nil, err
	}
	keySpendCache := keyspend.New(keyspend.WithTTL(keySpendTTL))
	// key 级与用户级并发共用同一套原子预留（AGENTS.md：别写两遍）。
	keyLimits := limits.New()

	// key 级执行面（pre）：过期 / 金额上限 / key 并发 / 用户并发。
	// 位置必须紧跟 key-auth（要用它写进 ctx.Key 的上限），早于任何转发判断。
	keyGate, err := keygate.Register(registry, keygate.Config{}, keygate.Deps{
		Spends:       keySpendCache,
		UserLimits:   userLimits,
		Reservations: keyLimits,
	}, logger)
	if err != nil {
		return nil, fmt.Errorf("初始化 key-gate 阶段失败：%w", err)
	}

	// 定价闸门（pre）：默认关（owner 拍板），上线确认价格快照正常后再用 -pricing-gate 打开。
	// 没打开时**不注册阶段**：省掉热路径上的一次判空，也让「关」是真正零行为。
	var pricingGateStage *pricinggate.Stage
	if *flags.pricingGateEnabled {
		stage, err := pricinggate.Register(registry,
			pricinggate.Config{SnapshotTTL: pricingTTL}, pricingCache, logger)
		if err != nil {
			return nil, fmt.Errorf("初始化定价闸门阶段失败：%w", err)
		}
		pricingGateStage = stage
	}

	return &gateWiring{
		spend:         keySpendCache,
		pricingCache:  pricingCache,
		keyGate:       keyGate,
		keyLimits:     keyLimits,
		pricingGate:   pricingGateStage,
		pricingTTLMs:  pricingTTL.Milliseconds(),
		keySpendTTLMs: keySpendTTL.Milliseconds(),
		pricingOn:     *flags.pricingGateEnabled,
	}, nil
}

// logPolicy 把两条闸门的策略写进启动日志（运维第一眼能看到「闸门开没开」）。
func (w *gateWiring) logPolicy(logger *slog.Logger) {
	logger.Info("key-gate 策略",
		"keyspendTtlMs", w.keySpendTTLMs,
		"keyConcurrency", "按 key 快照的 concurrencyLimit",
		"userConcurrency", "按余额快照的 concurrencyLimit")
	logger.Info("定价闸门策略",
		"enabled", w.pricingOn,
		"snapshotTtlMs", w.pricingTTLMs,
		"mode", "fail-closed（快照不可用 → 503）")
}
