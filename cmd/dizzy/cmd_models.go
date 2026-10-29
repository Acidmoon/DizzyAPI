package main

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

// modelsCommand 是 `dizzy models`。
//
// 默认打 **GET /v1/models**（Bearer key）：只给当前可用模型名的并集。
// `--catalog` 改打 **GET /api/models**（会话）：带价格、可用性与覆盖度。
//
// 两个端点不是一回事：前者归 Go 的 LLM 入口，后者归 TS 的模型广场。
func modelsCommand() *command {
	return &command{
		Name:    "models",
		Summary: "列出可用模型（--catalog 看价格与可用性）",
		Usage:   "dizzy models [--catalog] [--search <关键词>]",
		Example: "dizzy models\ndizzy models --catalog --search gpt\ndizzy models --json",
		Run:     runModels,
	}
}

func runModels(args []string, globals globalFlags) error {
	set := newFlagSet("models")
	catalog := set.Bool("catalog", false, "看价格与可用性（打 /api/models，需要会话）")
	search := set.String("search", "", "按模型名子串过滤")
	availability := set.String("availability", "", "all / available / unavailable")
	priced := set.String("priced", "", "all / priced / unpriced")
	if err := set.Parse(args); err != nil {
		return fmt.Errorf("%w：%v", errUsage, err)
	}
	if set.NArg() > 0 {
		return fmt.Errorf("%w：models 不接受位置参数", errUsage)
	}

	config, err := resolveConfig(globals)
	if err != nil {
		return err
	}

	if *catalog {
		return runModelsCatalog(config, globals, *search, *availability, *priced)
	}

	client, err := newLLMClient(config, globals)
	if err != nil {
		return err
	}
	var response modelsResponse
	if err := client.DoJSON(Request{Method: "GET", Path: "/v1/models"}, &response); err != nil {
		return err
	}

	names := []string{}
	for _, item := range response.Data {
		names = append(names, item.ID)
	}
	if config.JSON {
		return printJSON(response)
	}
	if len(names) == 0 {
		fmt.Fprintln(os.Stdout, "（没有可用模型：账号池里没有账号声明 models，或快照还没到）")
		return nil
	}
	for _, name := range names {
		fmt.Fprintln(os.Stdout, name)
	}
	return nil
}

// modelsResponse 是 GET /v1/models 的响应。
type modelsResponse struct {
	Object string `json:"object"`
	Data   []struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Created int64  `json:"created"`
		OwnedBy string `json:"owned_by"`
	} `json:"data"`
}

// catalogResponse 是 GET /api/models 的响应（模型广场）。
type catalogResponse struct {
	Available []catalogModel `json:"available"`
	Unavail   []catalogModel `json:"unavailable"`
	Summary   struct {
		Total            int `json:"total"`
		AvailableCount   int `json:"availableCount"`
		UnavailableCount int `json:"unavailableCount"`
		PricedCount      int `json:"pricedCount"`
		AccountCount     int `json:"accountCount"`
	} `json:"summary"`
}

// catalogModel 是模型广场里的一条。
type catalogModel struct {
	Model               string        `json:"model"`
	Reason              string        `json:"reason"`
	Detail              string        `json:"detail"`
	AccountCount        int           `json:"accountCount"`
	HealthyAccountCount int           `json:"healthyAccountCount"`
	Priced              bool          `json:"priced"`
	Protocols           []string      `json:"protocols"`
	Price               *catalogPrice `json:"price"`
}

// catalogPrice 是模型价格（十进制字符串，单位：元 / 百万 token）。
type catalogPrice struct {
	InputPerMillion      string `json:"inputPerMillion"`
	OutputPerMillion     string `json:"outputPerMillion"`
	CacheReadPerMillion  string `json:"cacheReadPerMillion"`
	CacheWritePerMillion string `json:"cacheWritePerMillion"`
	Currency             string `json:"currency"`
}

func runModelsCatalog(config Config, globals globalFlags, search, availability, priced string) error {
	client, err := newAPIClient(config, globals)
	if err != nil {
		return err
	}

	query := map[string]string{}
	if search != "" {
		query["search"] = search
	}
	if availability != "" {
		query["availability"] = availability
	}
	if priced != "" {
		query["priced"] = priced
	}

	values := url.Values{}
	for key, value := range query {
		values.Set(key, value)
	}
	var response catalogResponse
	if err := client.DoJSON(Request{Method: "GET", Path: "/api/models", Query: values}, &response); err != nil {
		return err
	}

	if config.JSON {
		return printJSON(response)
	}

	fmt.Fprintf(os.Stdout, "可用 %d / 共 %d（有价 %d，覆盖账号 %d）\n",
		response.Summary.AvailableCount, response.Summary.Total,
		response.Summary.PricedCount, response.Summary.AccountCount)

	for _, item := range response.Available {
		fmt.Fprintln(os.Stdout, formatCatalogModel(item))
	}
	for _, item := range response.Unavail {
		line := fmt.Sprintf("%s（不可用：%s）", item.Model, item.Reason)
		if item.Detail != "" {
			line += " — " + item.Detail
		}
		fmt.Fprintln(os.Stdout, line)
	}
	return nil
}

// formatCatalogModel 把一条模型目录渲染成一行。
func formatCatalogModel(item catalogModel) string {
	line := item.Model
	if item.HealthyAccountCount > 0 {
		line += fmt.Sprintf("（健康账号 %d", item.HealthyAccountCount)
		if item.AccountCount > item.HealthyAccountCount {
			line += fmt.Sprintf("/%d", item.AccountCount)
		}
		line += "）"
	}
	if len(item.Protocols) > 0 {
		line += " [" + strings.Join(item.Protocols, ",") + "]"
	}
	if item.Price != nil {
		line += fmt.Sprintf(" 输入 %s / 输出 %s 元每百万 token",
			item.Price.InputPerMillion, item.Price.OutputPerMillion)
	}
	return line
}
