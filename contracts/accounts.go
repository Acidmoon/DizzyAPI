package contracts

import "time"

// 账号相关的契约：发给上游要用的账号材料（`AccountCredential`）、打分用的候选
// （`AccountCandidate`）、以及 transport 对账号快照的最小依赖（`CredentialSource`）。
//
// 从 `contracts.go` 拆出来的原因：那个文件已超 500 行（§5.6 只许缩短），而账号这块
// 是**独立的一组契约**（身份 / 引用名 / 上游地址 / 客户端指纹），搬出来是纯移动，行为零变化。

// AccountCredential 是 transport 发请求所需的账号材料（含访问令牌）。
//
// 它只存在于 Go 进程内：不得写入日志、HTTP 响应或桥响应。
// 权威数据在 identity（TS）；Go 持有的是一份只读内存快照。
type AccountCredential struct {
	AccountID   string
	Provider    string
	Kind        string
	BaseURL     string
	AccessToken string
	ExpiresAt   *time.Time
	// Protocol 是该账号声明的上游协议（openai-chat / openai-responses / anthropic）。
	// 空 = 旧快照（未声明协议）：transport 走 Config.Path 回退，不做协议转换。
	Protocol string

	// Models 是这个账号服务的对外模型名；ModelMap 是「对外模型名 → 上游真实模型名」。
	// 空 = 未声明：模型路由不过滤该账号、模型映射不生效（向后兼容，旧快照合法）。
	Models   []string
	ModelMap map[string]string

	// ClientHeaders 是该账号挂的「客户端指纹档案」解出来的固定头（值里可能含模板），
	// ClientUserAgent 是档案声明的 UA。空 = 不伪装（旧快照合法）。
	//
	// 模板的展开发生在 transport（`{{session}}` 要用请求体算），所以这里存的是**未展开的原文**。
	// 这些头**永远不能覆盖鉴权头与内容协商头**：保护名单见 `IsProtectedRequestHeader`。
	ClientHeaders   []AccountHeader
	ClientUserAgent string
}

// AccountHeader 是一个要贴到上游请求上的头（名字 + 值，值可含模板占位）。
type AccountHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// CredentialSource 是 transport 对账号快照缓存的最小依赖。
// 接口由消费者定义；实现（内存缓存）在 internal/accounts。
type CredentialSource interface {
	Credential(accountID string) (AccountCredential, bool)
}

// AccountCandidate 是参与打分与调度的账号快照。
type AccountCandidate struct {
	AccountID     string            `json:"accountId"`
	Provider      string            `json:"provider"`
	Kind          string            `json:"kind,omitempty"`
	Disabled      bool              `json:"disabled,omitempty"`
	Priority      int               `json:"priority,omitempty"`
	Weight        *float64          `json:"weight,omitempty"`
	Health        HealthState       `json:"health,omitempty"`
	Tags          map[string]string `json:"tags,omitempty"`
	CooldownUntil *time.Time        `json:"cooldownUntil,omitempty"`

	QuotaRatio     *float64 `json:"quotaRatio,omitempty"`
	RateLimitRatio *float64 `json:"rateLimitRatio,omitempty"`

	InFlight    int `json:"inFlight,omitempty"`
	Concurrency int `json:"concurrency,omitempty"`

	LastUsedAt     *time.Time `json:"lastUsedAt,omitempty"`
	SuccessRate    *float64   `json:"successRate,omitempty"`
	LatencyP95Ms   *float64   `json:"latencyP95Ms,omitempty"`
	CostMultiplier *float64   `json:"costMultiplier,omitempty"`

	// Models 是这个账号服务的对外模型名。空 = 未声明：不参与模型路由过滤（向后兼容）。
	Models []string `json:"models,omitempty"`

	// ClientHeaders / ClientUserAgent 是这个账号挂的客户端指纹档案（见 AccountCredential 同名
	// 字段）。候选里带上它们是为了「排障时能看出这个账号在伪装成谁」；**真正的套用在
	// transport 里，取的是 Credential 那一份**，两者来自同一份快照。
	ClientHeaders   []AccountHeader `json:"clientHeaders,omitempty"`
	ClientUserAgent string          `json:"clientUserAgent,omitempty"`
}
