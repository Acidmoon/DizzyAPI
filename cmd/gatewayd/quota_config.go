package main

import (
	"fmt"
	"time"
)

const (
	// maxQuotaSnapshotTTLMs 是余额快照有效期的上限：超过 10 分钟基本等于「关掉 TTL 检查」，
	// 宁可让配置明确失败。
	maxQuotaSnapshotTTLMs = 600_000
	// minQuotaSnapshotTTLMs 是下限：比 1 秒更短的 TTL 会把自己打成抖动。
	minQuotaSnapshotTTLMs = 1_000
)

// parseQuotaSnapshotTTL 把毫秒配置转成时长；非法值让进程起不来（AGENTS.md §2.4.5）。
func parseQuotaSnapshotTTL(ms int) (time.Duration, error) {
	if ms < minQuotaSnapshotTTLMs || ms > maxQuotaSnapshotTTLMs {
		return 0, fmt.Errorf(
			"余额快照有效期（-quota-snapshot-ttl-ms）非法：必须在 %d..%d ms 之间，得到 %d",
			minQuotaSnapshotTTLMs, maxQuotaSnapshotTTLMs, ms)
	}
	return time.Duration(ms) * time.Millisecond, nil
}
