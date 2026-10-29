package contracts

// key-gate（key 级执行面）与 pricing-gate（定价闸门）共用的稳定错误码与桥方法名。
//
// 两条闸门都是 **pre 相位**、都在 key-auth 之后：它们只做判定，不自己写 HTTP，
// 也不改余额 —— 拒绝就是拒绝，不转发上游、不扣费。

const (
	// CodeAPIKeyExpired 表示 API key 已过期（401、不可重试）。
	//
	// 与 INVALID_API_KEY 分开是有意的：过期是「这把 key 曾经有效」，用户需要看到
	// 明确的过期信号，而不是一个查不出原因的「key 无效」。
	CodeAPIKeyExpired = "API_KEY_EXPIRED"
	// CodeAPIKeySpendingLimit 表示该 key 的累计消费已达金额上限（402、不可重试）。
	CodeAPIKeySpendingLimit = "API_KEY_SPENDING_LIMIT"
	// CodeAPIKeyConcurrencyLimit 表示该 key 的并发请求已达上限（429、不可重试）。
	CodeAPIKeyConcurrencyLimit = "API_KEY_CONCURRENCY_LIMIT"
	// CodeUserConcurrencyLimit 表示该用户的并发请求已达上限（429、不可重试）。
	//
	// 与 key 级分开成两个码：一个是「这把 key 用得太猛」，一个是「这个人用得太猛」，
	// 排障与用户提示都不一样。两者共用同一套原子预留实现。
	CodeUserConcurrencyLimit = "USER_CONCURRENCY_LIMIT"
)

const (
	// CodeModelNotPriced 表示请求的模型没有配置价格（403、不可重试、不转发上游）。
	//
	// owner 拍的是「真拒绝」：没有价格的模型不许请求，而不是照常请求再标注未定价。
	CodeModelNotPriced = "MODEL_NOT_PRICED"
	// CodePricingSnapshotUnavailable 表示价格快照不可用（503、不可重试）。
	//
	// fail-closed：定价闸门是 owner 拍的真拒绝，快照不可用时宁可拒绝也不能放行。
	CodePricingSnapshotUnavailable = "PRICING_SNAPSHOT_UNAVAILABLE"
)

const (
	// LimitScopeKeyPrefix / LimitScopeUserPrefix 是并发槽位的 scope 前缀。
	//
	// key 级与用户级**共用同一套原子预留实现**（AGENTS.md：别写两遍），作用域靠前缀区分；
	// 前缀放在 contracts 里是因为 modules/* 只能 import contracts，不能在模块里各写一份。
	LimitScopeKeyPrefix  = "key:"
	LimitScopeUserPrefix = "user:"
)

const (
	// BridgeMethodPricingReplace 是 TS 推送价格快照的桥方法名（TS → Go，心跳式）。
	BridgeMethodPricingReplace = "pricing.replace"
	// BridgeMethodPricingStatus 是查询价格快照健康度的桥方法名（只读、无参数）。
	BridgeMethodPricingStatus = "pricing.status"
	// BridgeMethodKeySpendReplace 是 TS 推送「每个 key 的累计消费」的桥方法名（心跳式）。
	//
	// 金额一律十进制微元字符串：JSON number 会丢 >2^53 的精度，Go 解析失败即整份拒绝。
	BridgeMethodKeySpendReplace = "keyspend.replace"
	// BridgeMethodKeySpendStatus 是查询 key 消费快照健康度的桥方法名（只读、无参数）。
	BridgeMethodKeySpendStatus = "keyspend.status"
)
