package main

import (
	"fmt"
	"time"
)

const (
	// minGateSnapshotTTLMs 是闸门快照有效期的下限：比 1 秒更短的 TTL 会把自己打成抖动。
	minGateSnapshotTTLMs = 1_000
	// maxGateSnapshotTTLMs 是上限：超过 10 分钟基本等于「关掉 TTL 检查」，宁可让配置明确失败。
	maxGateSnapshotTTLMs = 600_000
)

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
