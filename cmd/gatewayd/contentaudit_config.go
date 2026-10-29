package main

import (
	"fmt"
	"time"
)

const (
	// minContentAuditSnapshotTTLMs 是规则快照有效期的下限：比 1 秒更短的 TTL 会把自己打成抖动。
	minContentAuditSnapshotTTLMs = 1_000
	// maxContentAuditSnapshotTTLMs 是上限：超过 10 分钟基本等于「关掉 TTL 检查」，宁可让配置明确失败。
	maxContentAuditSnapshotTTLMs = 600_000
)

// parseContentAuditSnapshotTTL 把毫秒配置转成时长；非法值让进程起不来（AGENTS.md §2.4.5）。
func parseContentAuditSnapshotTTL(ms int) (time.Duration, error) {
	if ms < minContentAuditSnapshotTTLMs || ms > maxContentAuditSnapshotTTLMs {
		return 0, fmt.Errorf(
			"内容审核规则快照有效期（-content-audit-snapshot-ttl-ms）非法：必须在 %d..%d ms 之间，得到 %d",
			minContentAuditSnapshotTTLMs, maxContentAuditSnapshotTTLMs, ms)
	}
	return time.Duration(ms) * time.Millisecond, nil
}
