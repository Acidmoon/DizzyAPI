// 用量记录的线格式（AGENTS.md §4.2）。
//
// 一条 UsageRecord 是「一次完成的 LLM 请求」的用量事实：谁用的（用户 / key）、
// 打了哪个账号与模型、花了多少 token、耗时、状态与客户端 IP。
//
// 它**不是**计费凭据：当前没有真实扣费，费用由 TS 侧的 pricing 插件按价格表在读取时
// 计算（AGENTS.md §8）。Go 只负责把事实产出来。
package contracts

import "time"

// BridgeMethodUsageSince 是桥上的用量拉取方法名。
//
// TS 每 pollIntervalMs 调一次 `usage.since {epoch, afterSeq, limit}`，拿到缓冲里的新记录。
// 用轮询而不是事件推送：断线可以补拉，TS 重启也不会丢；epoch 标识 gatewayd 的一次进程
// 生命周期（重启后 seq 从 1 重新开始），避免 TS 的 afterSeq 卡在旧值上。
const BridgeMethodUsageSince = "usage.since"

// BridgeMethodUsageStats 是桥上的用量缓冲健康度查询方法名（只读、无参数）。
//
// 它返回容量 / 占用 / 累计丢弃 / 累计缺口 / epoch / lastSeq，给 TS 在检测到
// 序号缺口或连续落库失败时补充上下文：「是缓冲太小还是轮询断了」。
// TS 不该在正常路径上每轮都调用它。
const BridgeMethodUsageStats = "usage.stats"

// UsageRecord 是一条已完成的 LLM 请求记录。
//
// 令牌口径：InputTokens **不含**缓存命中/创建的部分；OpenAI 的 prompt_tokens 包含缓存，
// 采集侧必须换算后再写进来，否则四个桶会重复计数（AGENTS.md §7 协议转换 / 用量）。
type UsageRecord struct {
	// Seq / Epoch 由缓冲分配，保证 TS 能按序拉取并在重启后重新对齐。
	Seq   int64  `json:"seq"`
	Epoch string `json:"epoch"`

	RequestID string `json:"requestId"`
	// UserID / KeyID 为空 = 静态 key（DIZZYAPI_API_KEYS）或无 key 的调用。
	UserID  string `json:"userId"`
	KeyID   string `json:"keyId"`
	KeyName string `json:"keyName"`
	Profile string `json:"profile,omitempty"`

	AccountID string `json:"accountId,omitempty"`

	// Model 是客户端请求的模型名；UpstreamModel 是映射后真正发给上游的名字。
	Model         string `json:"model"`
	UpstreamModel string `json:"upstreamModel,omitempty"`

	// Protocol 是客户端协议；UpstreamProtocol 是上游账号协议。
	// 两者的 token 语义不同（见上），TS 侧据此核对口径。
	Protocol         Protocol `json:"protocol,omitempty"`
	UpstreamProtocol Protocol `json:"upstreamProtocol,omitempty"`

	Stream    bool   `json:"stream"`
	Status    int    `json:"status"`
	ErrorCode string `json:"errorCode,omitempty"`

	InputTokens      int `json:"inputTokens"`
	OutputTokens     int `json:"outputTokens"`
	CacheReadTokens  int `json:"cacheReadTokens"`
	CacheWriteTokens int `json:"cacheWriteTokens"`
	ReasoningTokens  int `json:"reasoningTokens"`
	TotalTokens      int `json:"totalTokens"`

	// UsagePresent 表示响应里确实带了 usage；UsageComplete 表示流已读完（客户端中途断开为 false）。
	// 两者都为 false 时 token 全是 0，不能当成「确实用了 0 个 token」。
	UsagePresent  bool `json:"usagePresent"`
	UsageComplete bool `json:"usageComplete"`

	DurationMs int64     `json:"durationMs"`
	ClientIP   string    `json:"clientIp,omitempty"`
	Attempts   int       `json:"attempts,omitempty"`
	StartedAt  time.Time `json:"startedAt"`
}

// UsageSink 接收已完成的请求记录。实现必须是非阻塞的：它在 LLM 请求的返回路径上。
type UsageSink interface {
	Append(UsageRecord)
}
