package modelroute

import (
	"fmt"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// 稳定错误码。HTTP 层只做状态码映射，不回显内部细节。
const (
	// CodeModelNotServed：过滤后没有任何候选账号服务请求的模型。
	CodeModelNotServed = "MODEL_NOT_SERVED"
	// CodeModelMapFailed：请求体无法解析 / 按映射重写（客户端问题，换账号无意义）。
	CodeModelMapFailed = "MODEL_MAP_FAILED"
	// CodeInvalidRequest：模块内部收到空的请求上下文（装配 / 调用错误）。
	CodeInvalidRequest = "MODEL_ROUTE_INVALID_REQUEST"
)

// modelNotServed 返回 503 且不可重试：换账号也没用，是模型名的问题。
// 模型名不是秘密，可以回显。
func modelNotServed(model string) *contracts.StageError {
	return &contracts.StageError{
		Status:    503,
		Code:      CodeModelNotServed,
		Message:   fmt.Sprintf("没有账号服务模型 %q", model),
		Retryable: false,
	}
}

// mapFailed 返回 400 且不可重试：请求体本身无法解析 / 按映射重写。
func mapFailed() *contracts.StageError {
	return &contracts.StageError{
		Status:    400,
		Code:      CodeModelMapFailed,
		Message:   "请求体无法按模型映射重写",
		Retryable: false,
	}
}
