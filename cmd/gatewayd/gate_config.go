package main

import (
	"flag"
	"fmt"
	"time"
)

const (
	// minGateSnapshotTTLMs 是闸门快照有效期的下限：比 1 秒更短的 TTL 会把自己打成抖动。
	minGateSnapshotTTLMs = 1_000
	// maxGateSnapshotTTLMs 是上限：超过 10 分钟基本等于「关掉 TTL 检查」，宁可让配置明确失败。
	maxGateSnapshotTTLMs = 600_000
)

// gateFlags 是两条闸门（key 级执行面 / 定价闸门）的命令行配置。
//
// 指针形态是因为 flag 的值要到 flag.Parse() 之后才是真的；组合根在 Parse 之后读它们。
type gateFlags struct {
	// pricingGateEnabled 是定价闸门的开关，默认**关**（owner 拍板）：
	// 没开时不注册阶段，「关」是真正零行为，而不是「注册了但每次都放行」。
	pricingGateEnabled *bool
	// pricingSnapshotTTLMs 是价格快照有效期。
	pricingSnapshotTTLMs *int
	// keySpendSnapshotTTLMs 是 key 消费快照有效期。
	keySpendSnapshotTTLMs *int
}

// registerGateFlags 把闸门相关的 flag 注册到默认 flag 集。
//
// 两条快照都是**心跳式**推送 + 按 TTL 判新鲜度，所以 TTL 必须 ≥ 3 × TS 的推送间隔；
// 文案里直接写这条，免得运维把它调到比心跳还短（那会让闸门周期性 fail-closed）。
func registerGateFlags() *gateFlags {
	return &gateFlags{
		pricingGateEnabled: flag.Bool("pricing-gate", false,
			"定价闸门：模型没有配置价格时返回 403 MODEL_NOT_PRICED；默认关，上线确认价格快照正常后再打开"),
		pricingSnapshotTTLMs: flag.Int("pricing-snapshot-ttl-ms", 15000,
			fmt.Sprintf("价格快照有效期（毫秒），应 ≥ 3 × TS 的 pushIntervalMs；超出 %d..%d 直接启动失败",
				minGateSnapshotTTLMs, maxGateSnapshotTTLMs)),
		keySpendSnapshotTTLMs: flag.Int("keyspend-snapshot-ttl-ms", 15000,
			fmt.Sprintf("key 消费快照有效期（毫秒），应 ≥ 3 × TS 的 pushIntervalMs；超出 %d..%d 直接启动失败",
				minGateSnapshotTTLMs, maxGateSnapshotTTLMs)),
	}
}

// parseGateSnapshotTTL 把毫秒配置转成时长；非法值让进程起不来（AGENTS.md §2.4.5）。
//
// 定价闸门与 key 消费快照共用这套边界：两者都是心跳式推送 + 按 TTL 判新鲜度，
// 边界写两遍只会漂移。
func parseGateSnapshotTTL(flagName string, ms int) (time.Duration, error) {
	if ms < minGateSnapshotTTLMs || ms > maxGateSnapshotTTLMs {
		return 0, fmt.Errorf("%s 非法：必须在 %d..%d ms 之间，得到 %d",
			flagName, minGateSnapshotTTLMs, maxGateSnapshotTTLMs, ms)
	}
	return time.Duration(ms) * time.Millisecond, nil
}
