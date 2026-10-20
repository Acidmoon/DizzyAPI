// Package protoconv 是 LLM 协议转换中间件。
//
// 它在 dispatch 相位、transport 之前运行：按「客户端协议 vs 选中账号声明的上游协议」
// 决定是否转换请求体（写 Ctx.Upstream），并把上游响应转换回客户端协议。
//
// 边界（AGENTS.md §2.3 / §2.4）：
//   - 只 import contracts；
//   - 不感知令牌（只按账号 id 取协议，不读令牌内容）；
//   - 失败默认 fail-closed：协议未知时明确报错，不猜、不静默降级；
//   - 有损映射必须记 LossyNote 并进日志（只记字段名，不记内容）。
package protoconv

import "github.com/Acidmoon/DizzyAPI/contracts"

// 稳定错误码。HTTP 层只做状态码映射，不回显内部细节。
const (
	// CodeProtocolUnknown：客户端协议非 openai-chat，但上游协议未声明。
	CodeProtocolUnknown = "PROTOCOL_UNKNOWN"
	// CodeConvertFailed：请求体解析或渲染失败（客户端问题，换账号无意义）。
	CodeConvertFailed = "PROTOCOL_CONVERT_FAILED"
	// CodeTranscodeFailed：上游响应无法解析或转回客户端协议（上游问题，可换账号）。
	CodeTranscodeFailed = "PROTOCOL_TRANSCODE_FAILED"
	// CodeCodecUnavailable：需要的协议 codec 未注册（部署缺少能力）。
	CodeCodecUnavailable = "PROTOCOL_CODEC_UNAVAILABLE"
	// CodeInvalidConfig：模块装配参数不合法。
	CodeInvalidConfig = "PROTOCOL_CONVERT_INVALID_CONFIG"
)

// protocolUnknown 返回 fail-closed 的 502。
//
// 上游协议为空是「按账号而变」的事实：换一个声明了协议的账号可能就能服务，
// 所以标记为可重试。
func protocolUnknown() *contracts.StageError {
	return &contracts.StageError{
		Status:    502,
		Code:      CodeProtocolUnknown,
		Message:   "上游账号未声明协议，无法转换",
		Retryable: true,
	}
}

// codecUnavailable 返回 502。上游协议各账号不同，换账号可能命中已注册的 codec。
func codecUnavailable() *contracts.StageError {
	return &contracts.StageError{
		Status:    502,
		Code:      CodeCodecUnavailable,
		Message:   "缺少所需的协议编解码器",
		Retryable: true,
	}
}

// convertFailed 返回 400，且不可重试：请求体本身无法按客户端协议解析 / 渲染。
func convertFailed() *contracts.StageError {
	return &contracts.StageError{
		Status:    400,
		Code:      CodeConvertFailed,
		Message:   "请求无法按客户端协议解析",
		Retryable: false,
	}
}

// transcodeFailed 返回 502：上游响应无法解析 / 转回客户端协议。可换账号重试。
func transcodeFailed() *contracts.StageError {
	return &contracts.StageError{
		Status:    502,
		Code:      CodeTranscodeFailed,
		Message:   "上游响应无法转换为客户端协议",
		Retryable: true,
	}
}
