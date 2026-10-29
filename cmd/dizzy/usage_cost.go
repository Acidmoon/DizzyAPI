package main

import (
	"errors"
	"net/url"
	"strconv"
	"time"
)

// usageCostPoll 是「chat 之后回查权威费用」的轮询参数。
//
// 用量是**异步**落库的：Go 把记录放进环形缓冲，TS 的 usage 插件每秒轮询一次
// （app.yml 的 usage.pollIntervalMs = 1000），再落 SQLite 并结算。所以请求刚
// 返回时那条记录通常还查不到，必须等一两秒。
const (
	usageCostPollAttempts = 8
	usageCostPollInterval = 500 * time.Millisecond
)

// usageCostLookup 负责「按刚打完的那条请求，回 /api/usage 查权威费用」。
//
// **为什么不在 CLI 里自己算钱**：
//   - 价格表归 pricing 插件（控制面），CLI 未必登录、也未必有权限读；
//   - 更关键的是 token 口径：客户端拿到的 OpenAI 形状 `prompt_tokens` **含**缓存，
//     而网关记账的四桶里 `input` **不含**缓存（internal/usageprobe.Normalize）。
//     跨协议时（例如上游 Anthropic、客户端 OpenAI）连这个关系都不成立 ——
//     protoconv 渲染回客户端时 `prompt_tokens` 填的是**净输入**。
//     所以 CLI 按响应里的 token 硬算，一定存在对不上的情形。
//
// 结论：费用只有一个权威来源 —— `/api/usage` 的 `costMicros`。
type usageCostLookup struct {
	client *Client
	// model 是**客户端请求的**模型名（用量记录的 model 也是它，不是上游名）。
	model string
	// since 是请求开始时间；只接受不早于它（减去容差）的记录。
	since time.Time
	// seenBefore 是请求前已存在的最大用量 id，用来排除旧记录。
	seenBefore int64
}

// lookup 轮询 /api/usage 找本次请求的那条记录，返回它的费用（整数微元）。
//
// 找不到就返回空字符串（不是错误）：用量有延迟时「查不到」是正常情况，
// 不该让一条已经成功的 chat 变成失败。
func (l *usageCostLookup) cost() (string, string, bool) {
	if l == nil || l.client == nil {
		return "", "", false
	}
	for attempt := 0; attempt < usageCostPollAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(usageCostPollInterval)
		}
		cost, reqID, ok := l.once()
		if ok {
			return cost, reqID, true
		}
	}
	return "", "", false
}

// once 查一轮。
func (l *usageCostLookup) once() (string, string, bool) {
	query := url.Values{}
	// 用一个够宽的窗口：跨零点时 7d 也覆盖得到；limit 取小值，只关心最近几条。
	query.Set("range", "7d")
	query.Set("limit", "20")
	if l.model != "" {
		query.Set("model", l.model)
	}

	var response usageResponse
	if err := l.client.DoJSON(Request{Method: "GET", Path: "/api/usage", Query: query}, &response); err != nil {
		return "", "", false
	}

	// 明细按 id 倒序（服务端 ORDER BY id DESC），第一条匹配的就是最新一条。
	for _, record := range response.Records.Items {
		if record.Model != l.model {
			continue
		}
		if l.seenBefore > 0 && rowID(record) <= l.seenBefore {
			// 这是请求之前就存在的旧记录。
			continue
		}
		startedAt, err := time.Parse(time.RFC3339Nano, record.StartedAt)
		if err == nil && startedAt.Before(l.since.Add(-5*time.Second)) {
			continue
		}
		return record.CostMicros, record.ReqID, true
	}
	return "", "", false
}

// rowID 取明细行的数值 id。etime 解析不出来时按 0 处理（等于「不作排除」）。
func rowID(record usageRow) int64 {
	if record.ID <= 0 {
		return 0
	}
	return record.ID
}

// maxUsageID 取当前最大的用量记录 id（请求前调用，用于排除旧记录）。
//
// 查不到（没登录 / 用量插件没运行）返回 0：那时 cost 查询本来也会失败，
// 不影响 chat 本身成功。
func maxUsageID(client *Client) int64 {
	query := url.Values{}
	query.Set("range", "7d")
	query.Set("limit", "1")
	var response usageResponse
	if err := client.DoJSON(Request{Method: "GET", Path: "/api/usage", Query: query}, &response); err != nil {
		return 0
	}
	if len(response.Records.Items) == 0 {
		return 0
	}
	return rowID(response.Records.Items[0])
}

// newUsageCostLookup 在**发请求之前**建一个查询器（它要先记下当前最大 id）。
//
// 拿不到会话时返回 nil：chat 只用 Bearer key 也该能跑，只是不打印费用。
func newUsageCostLookup(config Config, globals globalFlags, model string) (*usageCostLookup, error) {
	client, err := newAPIClient(config, globals)
	if err != nil {
		if errors.Is(err, ErrCredentialsMissing) {
			return nil, nil
		}
		return nil, err
	}
	return &usageCostLookup{
		client:     client,
		model:      model,
		since:      time.Now(),
		seenBefore: maxUsageID(client),
	}, nil
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
