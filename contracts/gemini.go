// Package contracts 的 Gemini 模型名归一。
//
// Gemini 的模型名同时出现在两个地方：
//   - 客户端请求路径：`/v1beta/models/{model}:generateContent`；
//   - 上游请求路径：方言里的 `{model}` 占位（见 modules/transport）。
//
// Google 官方 REST 形状是 `{model=models/*}`，官方 SDK 默认拼成
// `models/gemini-2.0-flash`；但很多客户端也会直接传裸名 `gemini-2.0-flash`。
// 两边都接受，内部统一按**裸模型名**处理，拼路径时只补一层 `models/`。
//
// 归一函数放在 contracts：它是入口解析（internal/httpapi）与上游拼路径
// （modules/transport）共用的纯函数，放在任一模块都会逼另一个模块跨层 import。
package contracts

import (
	"errors"
	"strings"
)

const (
	// GeminiModelsSegment 是 Gemini 资源名前缀（`models/`）。
	GeminiModelsSegment = "models/"

	// GeminiMaxModelNameLength 是归一后模型名的长度上限（防超长路径）。
	GeminiMaxModelNameLength = 256
)

// ErrGeminiModelNameInvalid 表示模型名不合法。调用方按所在位置映射自己的
// 稳定错误码（入口 → 404，上游拼路径 → UPSTREAM_URL_INVALID）。
var ErrGeminiModelNameInvalid = errors.New("gemini: 模型名不合法")

// NormalizeGeminiModelName 把客户端 / 配置里来的模型名归一成裸模型名。
//
// 规则（**只剥一层**，剥完仍非法就明确失败，绝不静默降级）：
//   - 去掉首尾空白；
//   - 去掉**一个**可选的 `models/` 前缀（`models/models/x` 剥完仍是 `models/x`，失败）；
//   - 归一后必须非空、长度 ≤ GeminiMaxModelNameLength；
//   - 归一后不许含 `/ \ ? #` 与 NUL（它要拼进 URL 路径，不能改变路径语义）。
func NormalizeGeminiModelName(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	trimmed = strings.TrimPrefix(trimmed, GeminiModelsSegment)
	if trimmed == "" {
		return "", ErrGeminiModelNameInvalid
	}
	if len(trimmed) > GeminiMaxModelNameLength {
		return "", ErrGeminiModelNameInvalid
	}
	if strings.ContainsAny(trimmed, "/\\?#\x00") {
		return "", ErrGeminiModelNameInvalid
	}
	return trimmed, nil
}
