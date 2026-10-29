package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// POST /v1/embeddings（OpenAI 兼容）。
//
// 它与 chat 同属 OpenAI 兼容族：同一套 JSON 习惯、同一个 Bearer 鉴权、同样的
// failover / 额度闸门 / 用量记录。区别只有两处：
//   - **路径不同**（/embeddings）：由 contracts.Ctx.Operation 在 transport 里选，
//     不新造 Protocol（那会污染协议语义与 codec 注册表）；
//   - **只有 OpenAI 兼容账号能处理**：anthropic / gemini 没有 embeddings 端点，
//     选中它们必须明确拒绝，绝不能把请求发到 chat 端点上。
//
// 它不流式：`stream: true` 明确 400，不做静默忽略。

const (
	// embeddingsMaxInputs 是一次请求里 input 数组的最大条数。
	embeddingsMaxInputs = 2048
	// embeddingsMaxInputChars 是 input 文本的总字符上限（1 Mi 字符，约 1 MiB 量级）。
	// 请求体本身还有 MaxBodyBytes 上限；这条是业务上限，给客户端明确的 413。
	embeddingsMaxInputChars = 1 << 20
)

// apiError 是入口层校验失败：状态码 + 稳定码 + 人话。
type apiError struct {
	status  int
	code    string
	message string
}

// validateEmbeddings 校验 embeddings 的请求形状（不改写 body）。
//
// 通过返回 nil；失败返回带稳定码的 apiError，由调用方按客户端协议渲染。
func validateEmbeddings(body []byte, stream bool) *apiError {
	if stream {
		return &apiError{
			status:  http.StatusBadRequest,
			code:    "INVALID_REQUEST",
			message: "embeddings 不支持流式（stream 必须为 false 或缺省）",
		}
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil || fields == nil {
		return &apiError{
			status:  http.StatusBadRequest,
			code:    "INVALID_REQUEST",
			message: "请求体必须是 JSON 对象",
		}
	}
	raw, exists := fields["input"]
	if !exists {
		return &apiError{status: http.StatusBadRequest, code: "INVALID_REQUEST", message: "缺少 input"}
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		if text == "" {
			return &apiError{status: http.StatusBadRequest, code: "INVALID_REQUEST", message: "input 不能是空字符串"}
		}
		if len(text) > embeddingsMaxInputChars {
			return tooLarge()
		}
		return nil
	}

	var list []string
	if err := json.Unmarshal(raw, &list); err != nil {
		return &apiError{
			status:  http.StatusBadRequest,
			code:    "INVALID_REQUEST",
			message: "input 只接受字符串或字符串数组",
		}
	}
	if len(list) == 0 {
		return &apiError{status: http.StatusBadRequest, code: "INVALID_REQUEST", message: "input 不能是空数组"}
	}
	if len(list) > embeddingsMaxInputs {
		return tooLarge()
	}
	total := 0
	for _, item := range list {
		if item == "" {
			return &apiError{status: http.StatusBadRequest, code: "INVALID_REQUEST", message: "input 里不能有空字符串"}
		}
		total += len(item)
		if total > embeddingsMaxInputChars {
			return tooLarge()
		}
	}
	return nil
}

func tooLarge() *apiError {
	return &apiError{
		status:  http.StatusRequestEntityTooLarge,
		code:    "INPUT_TOO_LARGE",
		message: "input 超过上限（最多 2048 条、总计 1048576 字符）",
	}
}

// embeddingCandidates 只保留能处理 embeddings 的账号：OpenAI 兼容族。
//
// 「未声明协议」按 OpenAI 兼容处理（与 protoconv 的直通口径一致），不能把旧账号
// 静默排除。返回的候选顺序与输入一致，不打乱打分结果。
func (s *Server) embeddingCandidates(candidates []contracts.AccountCandidate) []contracts.AccountCandidate {
	filtered := make([]contracts.AccountCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if s.embeddingCapable(candidate.AccountID) {
			filtered = append(filtered, candidate)
		}
	}
	return filtered
}

func (s *Server) embeddingCapable(accountID string) bool {
	credential, ok := s.accounts.Credential(accountID)
	if !ok {
		// 拿不到凭据就交给后面的阶段报账号错误（不要在这里静默丢掉候选）。
		return true
	}
	protocol := contracts.Protocol(credential.Protocol)
	return protocol == "" || protocol.IsOpenAI()
}
