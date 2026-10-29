package main

import (
	"net/url"
	"strconv"
	"time"
)

// usageCostPoll 是「chat 之后按 reqId 回查权威费用」的轮询参数。
//
// 用量是**异步**落库的：Go 把记录放进环形缓冲，TS 的 usage 插件每秒轮询一次
// （app.yml 的 usage.pollIntervalMs = 1000），再落 SQLite 并结算。所以请求刚
// 返回时那条记录通常还查不到（404），必须等一两秒。
const (
	usageCostPollAttempts = 8
	usageCostPollInterval = 500 * time.Millisecond
)

// usageCostLookup 按 reqId 精确回查**这一条**记录的费用。
//
// **为什么不在 CLI 里自己算钱**：
//   - 价格表归 pricing 插件（控制面），CLI 未必登录、也未必有权限读；
//   - 更关键的是 token 口径：客户端拿到的 OpenAI 形状 `prompt_tokens` **含**缓存，
//     而网关记账的四桶里 `input` **不含**缓存（internal/usageprobe.Normalize）。
//     跨协议时（例如上游 Anthropic、客户端 OpenAI）连这个关系都不成立 ——
//     protoconv 渲染回客户端时 `prompt_tokens` 填的是**净输入**。
//     所以 CLI 按响应里的 token 硬算，一定存在对不上的情形。
//
// **为什么不用「模型 + 时间窗 + 已见最大 id」猜**：并发请求、跨零点、同一模型
// 多条记录时，猜出来的那条可能是别人的。宁可显示「未取到」，也不报一个错的数。
//
// 结论：费用只有一个权威来源 —— `GET /api/usage/:reqId` 的 `costMicros`。
type usageCostLookup struct {
	client *Client
	// reqID 来自响应头 X-Request-Id（网关自己给的，与用量记录的 reqId 同源）。
	reqID string
}

// cost 轮询这条记录，返回费用（整数微元）与「取到了没」。
//
// 取不到不是错误：用量有延迟、或服务端还没有这个头时，chat 本身已经成功了，
// 不该因为查不到费用而变成失败。
func (l *usageCostLookup) cost() (string, bool) {
	if l == nil || l.client == nil || l.reqID == "" {
		return "", false
	}
	for attempt := 0; attempt < usageCostPollAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(usageCostPollInterval)
		}
		if cost, ok := l.once(); ok {
			return cost, true
		}
	}
	return "", false
}

// once 查一轮单条详情。
//
// 404 在这里是**正常情况**（记录还没落库），不是错误；其它错误同样只让这一轮
// 落空，不向上抛 —— 见 cost 的注释。
func (l *usageCostLookup) once() (string, bool) {
	var response usageDetailResponse
	if err := l.client.DoJSON(Request{
		Method: "GET",
		Path:   "/api/usage/" + url.PathEscape(l.reqID),
	}, &response); err != nil {
		return "", false
	}
	if response.Record.ReqID != l.reqID {
		// 防御：服务端回的不是这条（正常不会发生）。
		return "", false
	}
	return response.Record.CostMicros, true
}

// lookupCostByRequestID 按 reqId 回查费用。没有会话或没有 reqId 时返回 false。
func lookupCostByRequestID(config Config, globals globalFlags, reqID string) (string, bool) {
	if reqID == "" {
		return "", false
	}
	client, err := newAPIClient(config, globals)
	if err != nil {
		// 没有会话（只有 Bearer key）时 chat 照常跑，只是不打印费用。
		return "", false
	}
	return (&usageCostLookup{client: client, reqID: reqID}).cost()
}

// formatCostMicros 把费用渲染成「元（微元）」形式。
//
// 同时给两种：人看元，脚本要看微元（整数最小单位，不丢精度）。
func formatCostMicros(micros string) string {
	if micros == "" {
		return "（未知）"
	}
	return formatMicros(micros) + "（" + micros + " 微元）"
}

// formatCount 把整数渲染成十进制字符串（避免 fmt 的 %d 与 big 混用）。
func formatCount(value int) string {
	return strconv.Itoa(value)
}
