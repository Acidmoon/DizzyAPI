package contracts

// 额度闸门（余额只读快照 + pre 相位预检）相关的桥方法名与稳定错误码。
//
// 余额的唯一写者仍是 TS 的 `user` 插件：Go 侧只接收一份只读快照，用来在 pre 相位
// 拦住「余额 ≤ 阈值」的请求，避免白用上游。快照缺失 / 过期时的策略由 quotagate 决定
// （默认放行 + 告警，严格模式 fail-closed）。

const (
	// BridgeMethodQuotaReplace 是 TS 推送余额快照的桥方法名（TS → Go）。
	BridgeMethodQuotaReplace = "quota.replace"
	// BridgeMethodQuotaStatus 是查询快照健康度的桥方法名（只读、无参数）。
	BridgeMethodQuotaStatus = "quota.status"
)

const (
	// CodeInsufficientBalance 表示余额不足，请求被额度闸门拒绝（402、不可重试）。
	CodeInsufficientBalance = "INSUFFICIENT_BALANCE"
	// CodeQuotaSnapshotUnavailable 表示严格模式下快照未就绪或已过期（503、不可重试）。
	CodeQuotaSnapshotUnavailable = "QUOTA_SNAPSHOT_UNAVAILABLE"
)
