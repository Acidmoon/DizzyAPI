package main

import (
	"encoding/csv"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// usageCommand 是 `dizzy usage`：用量明细与汇总。
//
// 走 **/api/usage**（会话）。金额一律用**整数微元**（costMicros），
// **绝不用浮点**（AGENTS.md §2.4.3）。
func usageCommand() *command {
	return &command{
		Name:    "usage",
		Summary: "查看用量（--by model / --by key / 明细 / 导出）",
		Usage:   "dizzy usage [--range 7d|30d|90d] [--by model|key] [--limit <条数>]",
		Example: "dizzy usage\ndizzy usage --range 7d --by model\ndizzy usage --limit 20\ndizzy usage export --range 7d",
		Run:     runUsage,
	}
}

// usageRanges 是服务端支持的时间窗。
var usageRanges = map[string]bool{"7d": true, "30d": true, "90d": true}

func runUsage(args []string, globals globalFlags) error {
	// `usage export` 是子命令。
	if len(args) > 0 && args[0] == "export" {
		return runUsageExport(args[1:], globals)
	}

	set := newFlagSet("usage")
	rangeValue := set.String("range", "30d", "时间窗：7d / 30d / 90d")
	by := set.String("by", "", "聚合维度：model / key")
	limit := set.Int("limit", 20, "明细条数")
	model := set.String("model", "", "按模型过滤")
	keyID := set.String("key-id", "", "按 API key id 过滤")
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}
	if set.NArg() > 0 {
		return fmt.Errorf("%w：usage 不接受位置参数", errUsage)
	}

	if !usageRanges[*rangeValue] {
		return fmt.Errorf("%w：range 只能是 7d / 30d / 90d，收到 %q", errUsage, *rangeValue)
	}
	if *by != "" && *by != "model" && *by != "key" {
		return fmt.Errorf("%w：--by 只能是 model 或 key，收到 %q", errUsage, *by)
	}
	if *limit < 1 || *limit > 200 {
		return fmt.Errorf("%w：--limit 必须在 1..200 之间", errUsage)
	}

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}
	client, err := newAPIClient(config, globals)
	if err != nil {
		return err
	}

	query := url.Values{}
	query.Set("range", *rangeValue)
	if *model != "" {
		query.Set("model", *model)
	}
	if *keyID != "" {
		query.Set("apiKeyId", *keyID)
	}
	if *by == "" {
		query.Set("limit", strconv.Itoa(*limit))
	}

	var response usageResponse
	if err := client.DoJSON(Request{Method: "GET", Path: "/api/usage", Query: query}, &response); err != nil {
		return err
	}

	if config.JSON {
		return printJSON(response)
	}

	fmt.Fprintf(os.Stdout, "时间窗：%s（%s ~ %s）\n", response.Range, response.From, response.To)
	printUsageTotals("汇总", response.Totals)

	switch *by {
	case "model":
		fmt.Fprintln(os.Stdout)
		fmt.Fprintln(os.Stdout, "按模型：")
		for _, item := range response.Models {
			fmt.Fprintf(os.Stdout, "  %s\n", formatUsageLine(item.Model, item.usageTotals))
		}
	case "key":
		// 服务端目前只给按模型的聚合；按 key 的聚合由 CLI 从明细里算
		// （受 --limit 的条数限制，不是全量）。
		fmt.Fprintln(os.Stdout)
		fmt.Fprintln(os.Stdout, "按 API key（基于返回的明细聚合，不是全量）：")
		for _, group := range groupByKey(response.Records.Items) {
			fmt.Fprintf(os.Stdout, "  %s\n", formatUsageLine(group.name, group.totals))
		}
	default:
		fmt.Fprintln(os.Stdout)
		fmt.Fprintln(os.Stdout, "明细：")
		for _, row := range response.Records.Items {
			fmt.Fprintf(os.Stdout, "  %s  %s  %s\n",
				row.StartedAt, row.Model, formatUsageTotalsShort(row.totals()))
		}
	}
	return nil
}

// usageResponse 是 GET /api/usage 的响应。
type usageResponse struct {
	Range   string                `json:"range"`
	From    string                `json:"from"`
	To      string                `json:"to"`
	Totals  usageTotals           `json:"totals"`
	Daily   []usageDaily          `json:"daily"`
	Models  []usageModelBreakdown `json:"models"`
	Records struct {
		Items      []usageRow `json:"items"`
		NextCursor *int64     `json:"nextCursor"`
	} `json:"records"`
	PricingAvailable bool   `json:"pricingAvailable"`
	GeneratedAt      string `json:"generatedAt"`
}

// usageTotals 是一组用量数字。
//
// costMicros 是**整数微元的十进制字符串**（1 元 = 1_000_000 微元）。
// 这里保持字符串，不转成 float64 —— 大额会丢精度。
type usageTotals struct {
	Requests         int    `json:"requests"`
	Tokens           int    `json:"tokens"`
	InputTokens      int    `json:"inputTokens"`
	OutputTokens     int    `json:"outputTokens"`
	CacheReadTokens  int    `json:"cacheReadTokens"`
	CacheWriteTokens int    `json:"cacheWriteTokens"`
	CostCents        int    `json:"costCents"`
	CostMicros       string `json:"costMicros"`
}

// usageDaily 是一天的汇总。
type usageDaily struct {
	Date string `json:"date"`
	usageTotals
}

// usageModelBreakdown 是按模型的汇总。
type usageModelBreakdown struct {
	Model string `json:"model"`
	usageTotals
}

// usageRow 是一条用量明细。
type usageRow struct {
	ID               int64   `json:"id"`
	ReqID            string  `json:"reqId"`
	APIKeyID         string  `json:"apiKeyId"`
	APIKeyName       string  `json:"apiKeyName"`
	Model            string  `json:"model"`
	Protocol         string  `json:"protocol"`
	Stream           bool    `json:"stream"`
	Status           int     `json:"status"`
	ErrorCode        *string `json:"errorCode"`
	DurationMs       int     `json:"durationMs"`
	StartedAt        string  `json:"startedAt"`
	CostMicros       string  `json:"costMicros"`
	InputTokens      int     `json:"inputTokens"`
	OutputTokens     int     `json:"outputTokens"`
	CacheReadTokens  int     `json:"cacheReadTokens"`
	CacheWriteTokens int     `json:"cacheWriteTokens"`
	TotalTokens      int     `json:"totalTokens"`
}

// totals 把一条明细折成汇总口径。
func (r usageRow) totals() usageTotals {
	return usageTotals{
		Requests:         1,
		Tokens:           r.TotalTokens,
		InputTokens:      r.InputTokens,
		OutputTokens:     r.OutputTokens,
		CacheReadTokens:  r.CacheReadTokens,
		CacheWriteTokens: r.CacheWriteTokens,
		CostMicros:       r.CostMicros,
	}
}

// printUsageTotals 打一组用量数字。
//
// 费用同时给「元」和「整数微元」：人看元，脚本精确对账看微元
// （微元是整数最小单位，不丢精度）。
func printUsageTotals(label string, totals usageTotals) {
	fmt.Fprintf(os.Stdout, "%s：请求 %d · token %d（入 %d / 出 %d / 缓存读 %d / 缓存写 %d）· 费用 %s\n",
		label, totals.Requests, totals.Tokens, totals.InputTokens, totals.OutputTokens,
		totals.CacheReadTokens, totals.CacheWriteTokens, formatCostMicros(totals.CostMicros))
}

// formatUsageTotalsShort 打一组用量数字（简短版）。
func formatUsageTotalsShort(totals usageTotals) string {
	return fmt.Sprintf("token %d · 费用 %s",
		totals.Tokens, formatCostMicros(totals.CostMicros))
}

// formatUsageLine 打「名字 + 数字」一行。
func formatUsageLine(name string, totals usageTotals) string {
	return fmt.Sprintf("%s — 请求 %d · token %d · 费用 %s",
		name, totals.Requests, totals.Tokens, formatCostMicros(totals.CostMicros))
}

// keyGroup 是按 key 聚合出来的一组。
type keyGroup struct {
	name   string
	totals usageTotals
}

// groupByKey 把明细按 API key 聚合。
//
// 费用是**直接累加每条的 costMicros**（服务端已按模型算好的精确值），
// 不用 token 重算 —— 重算需要价格表，而价格表不在 CLI 手上。
func groupByKey(rows []usageRow) []keyGroup {
	order := []string{}
	groups := map[string]*keyGroup{}
	for _, row := range rows {
		name := row.APIKeyName
		if name == "" {
			name = row.APIKeyID
		}
		if name == "" {
			name = "（无 key）"
		}
		group, ok := groups[name]
		if !ok {
			// 费用从 "0" 起算（不是空串）：addMicros 对解析失败的输入会原样返回左边，
			// 空串会让整组费用永远是空。
			group = &keyGroup{name: name, totals: usageTotals{CostMicros: "0"}}
			groups[name] = group
			order = append(order, name)
		}
		group.totals.Requests += 1
		group.totals.Tokens += row.TotalTokens
		group.totals.InputTokens += row.InputTokens
		group.totals.OutputTokens += row.OutputTokens
		group.totals.CacheReadTokens += row.CacheReadTokens
		group.totals.CacheWriteTokens += row.CacheWriteTokens
		group.totals.CostMicros = addMicros(group.totals.CostMicros, row.CostMicros)
	}
	result := make([]keyGroup, 0, len(order))
	for _, name := range order {
		result = append(result, *groups[name])
	}
	return result
}

// runUsageExport 是 `dizzy usage export`：导出 CSV。
func runUsageExport(args []string, globals globalFlags) error {
	set := newFlagSet("usage export")
	rangeValue := set.String("range", "30d", "时间窗：7d / 30d / 90d")
	model := set.String("model", "", "按模型过滤")
	keyID := set.String("key-id", "", "按 API key id 过滤")
	output := set.String("output", "", "写到文件（默认打到 stdout）")
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}
	if set.NArg() > 0 {
		return fmt.Errorf("%w：usage export 不接受位置参数", errUsage)
	}
	if !usageRanges[*rangeValue] {
		return fmt.Errorf("%w：range 只能是 7d / 30d / 90d，收到 %q", errUsage, *rangeValue)
	}

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}
	client, err := newAPIClient(config, globals)
	if err != nil {
		return err
	}

	query := url.Values{}
	query.Set("range", *rangeValue)
	query.Set("format", "csv")
	if *model != "" {
		query.Set("model", *model)
	}
	if *keyID != "" {
		query.Set("apiKeyId", *keyID)
	}

	var response exportResponse
	if err := client.DoJSON(Request{Method: "GET", Path: "/api/usage/export", Query: query}, &response); err != nil {
		return err
	}
	if response.Content == "" {
		return fmt.Errorf("导出结果为空")
	}

	if *output == "" {
		// CSV 原样写到 stdout（带 BOM，Excel 能认）。
		fmt.Fprint(os.Stdout, response.Content)
		return nil
	}
	if err := os.WriteFile(*output, []byte(response.Content), 0o644); err != nil {
		return fmt.Errorf("写文件 %s 失败：%w", *output, err)
	}
	fmt.Fprintf(os.Stdout, "已导出 %d 行到 %s\n", countCSVRows(response.Content), *output)
	return nil
}

// exportResponse 是 GET /api/usage/export 的响应。
type exportResponse struct {
	Filename string `json:"filename"`
	Content  string `json:"content"`
}

// countCSVRows 数 CSV 的数据行（不含表头）。
func countCSVRows(content string) int {
	reader := csv.NewReader(strings.NewReader(content))
	reader.FieldsPerRecord = -1
	records, err := reader.ReadAll()
	if err != nil {
		return 0
	}
	if len(records) == 0 {
		return 0
	}
	return len(records) - 1
}
