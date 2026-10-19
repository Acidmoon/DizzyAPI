package accountpriority

import "fmt"

// ErrorCode 是稳定的错误码，桥会原样传到 TS 管理面。
type ErrorCode string

const (
	CodeInvalidConfig      ErrorCode = "ACCOUNT_PRIORITY_INVALID_CONFIG"
	CodeStrategyNotFound   ErrorCode = "ACCOUNT_PRIORITY_STRATEGY_NOT_FOUND"
	CodeNoEligibleAccount  ErrorCode = "ACCOUNT_PRIORITY_NO_ELIGIBLE_ACCOUNT"
	CodeInvalidRequest     ErrorCode = "ACCOUNT_PRIORITY_INVALID_REQUEST"
	CodeTooManyCandidates  ErrorCode = "ACCOUNT_PRIORITY_TOO_MANY_CANDIDATES"
	CodeDuplicateCandidate ErrorCode = "ACCOUNT_PRIORITY_DUPLICATE_CANDIDATE"
)

// Error 是模块的领域错误。不要用字符串包含关系判断错误类型。
type Error struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func newError(code ErrorCode, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// IsCode 判断错误是否属于某个稳定错误码。
func IsCode(err error, code ErrorCode) bool {
	typed, ok := err.(*Error)
	return ok && typed.Code == code
}
