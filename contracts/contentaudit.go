package contracts

// 内容审核（content-audit）的桥方法与稳定错误码。
//
// 与额度闸门同构：TS 是规则的唯一写者，把规则快照心跳式推给 Go；Go 只读，
// 在 pre 相位用预编译的小写表做子串匹配。桥方法名必须与 TS 侧
// `packages/account-priority` 的 catalog 声明逐字一致。

const (
	// BridgeMethodContentAuditReplace 是 TS 推送审核规则快照的桥方法名（TS → Go）。
	BridgeMethodContentAuditReplace = "contentaudit.replace"
	// BridgeMethodContentAuditStatus 是查询规则快照健康度与命中计数的桥方法名（只读、无参数）。
	BridgeMethodContentAuditStatus = "contentaudit.status"
)

const (
	// CodeContentBlocked 表示用户输入命中 block 规则，请求被拒绝（403、不可重试）。
	CodeContentBlocked = "CONTENT_BLOCKED"
	// CodeContentAuditSnapshotUnavailable 表示严格模式下规则快照未就绪或已过期（503、不可重试）。
	CodeContentAuditSnapshotUnavailable = "CONTENT_AUDIT_SNAPSHOT_UNAVAILABLE"
)
