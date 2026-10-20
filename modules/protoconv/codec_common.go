package protoconv

import (
	"bytes"
	"encoding/json"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// 本文件放跨 codec 共用的小工具。
//
// 它们不属于任何单一协议：解析方（Anthropic）把信息留在 Part.Raw 里，
// 渲染方（任意非 Anthropic 协议）据此记一条有损映射。放在这里是为了让
// codec_chat.go 不必依赖 codec_anthropic.go —— 去掉 Anthropic codec 时
// 其余 codec 仍然独立成立。

// hasCacheControl 报告 IR 片段是否保留了 Anthropic 的 cache_control。
//
// 渲染到非 Anthropic 协议时由目标 codec 调用，用于记录一次有损映射
// （Anthropic 专有字段无法在 OpenAI 侧表达）。
func hasCacheControl(raw json.RawMessage) bool {
	if len(bytes.TrimSpace(raw)) == 0 {
		return false
	}
	var extras struct {
		CacheControl json.RawMessage `json:"cache_control"`
	}
	if json.Unmarshal(raw, &extras) != nil {
		return false
	}
	return len(bytes.TrimSpace(extras.CacheControl)) > 0
}

// thinkingLossyField 给 thinking 片段选一个有损映射字段名：
// 带签名的是 thinking.signature，脱敏的是 redacted_thinking，其余是 thinking。
func thinkingLossyField(part contracts.Part) string {
	if part.Redacted {
		return "redacted_thinking"
	}
	if part.Signature != "" {
		return "thinking.signature"
	}
	return "thinking"
}
