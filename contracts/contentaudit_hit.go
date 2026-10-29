package contracts

// ContentAuditHit 是一条审核规则的命中结果。
//
// 它**不含被审文本**：日志与桥响应只记规则 id、动作与分类，绝不回显用户输入
// （AGENTS.md §5.1）。
type ContentAuditHit struct {
	RuleID   string
	Action   string
	Category string
}

const (
	// ContentAuditActionBlock 表示命中即拒绝请求（403、不可重试）。
	ContentAuditActionBlock = "block"
	// ContentAuditActionLog 表示命中只记日志与计数，请求照常放行。
	ContentAuditActionLog = "log"
)
