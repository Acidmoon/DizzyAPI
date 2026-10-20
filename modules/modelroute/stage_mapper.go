package modelroute

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// MapStage 是 dispatch 相位的模型映射阶段，注册在 accountpriority 之后、
// protoconv 之前。
//
// 它只写 Ctx.MappedBody：
//   - nil  = 不映射（transport / protoconv 用客户端原始字节）；
//   - 非 nil = 顶层 model 字段已替换成上游真实模型名的请求体。
//
// 关键：每个 attempt 都必须显式重置 Ctx.MappedBody（含置 nil）。engine.runDispatch
// 的失败转移循环会重跑本阶段，残留上一次的改写结果就会把错误的请求体发出去。
type MapStage struct {
	service *Service
}

// NewMapStage 用现有服务构造阶段。
func NewMapStage(service *Service) *MapStage {
	return &MapStage{service: service}
}

func (s *MapStage) Name() string           { return MapStageName }
func (s *MapStage) Phase() contracts.Phase { return contracts.PhaseDispatch }
func (s *MapStage) Required() bool         { return true }
func (s *MapStage) NeedBody() bool         { return true }

func (s *MapStage) Run(ctx *contracts.Ctx) (contracts.Decision, error) {
	if ctx == nil {
		return contracts.Decision{}, contracts.Errorf(500, CodeInvalidRequest, "请求上下文为空")
	}

	// 1) 每个 attempt 先显式重置：绝不残留上一次的映射结果。
	ctx.MappedBody = nil

	model := strings.TrimSpace(ctx.Meta.Model)
	if model == "" {
		return continueDecision, nil
	}

	// 2) 取不到选中账号或凭据：交给 transport 报账号错误。
	if ctx.AccountRoute == nil || ctx.AccountRoute.Picked == nil {
		return continueDecision, nil
	}
	if s.service.creds == nil {
		return continueDecision, nil
	}
	credential, ok := s.service.creds.Credential(ctx.AccountRoute.Picked.AccountID)
	if !ok {
		return continueDecision, nil
	}

	// 3) 账号没有该模型的映射：保持 nil，字节级直通不受影响。
	upstreamModel, ok := credential.ModelMap[model]
	if !ok || strings.TrimSpace(upstreamModel) == "" {
		return continueDecision, nil
	}

	// 4) 命中：替换 body 顶层 model 字段，写进 MappedBody。
	//    ctx.Meta.Model 保持客户端请求的模型名不变（日志与错误消息要用它）。
	if ctx.Body == nil {
		return contracts.Decision{}, mapFailed()
	}
	body, err := ctx.Body.Bytes()
	if err != nil {
		return contracts.Decision{}, mapFailed()
	}
	rewritten, err := rewriteModel(body, upstreamModel)
	if err != nil {
		return contracts.Decision{}, mapFailed()
	}
	ctx.MappedBody = rewritten
	s.service.logger.Info("模型映射",
		"reqId", ctx.ReqID,
		"model", model,
		"upstreamModel", upstreamModel,
		"accountId", credential.AccountID,
	)
	return continueDecision, nil
}

// rewriteModel 只改 body 顶层的 model 字段：解析成 map[string]json.RawMessage，
// 替换 model 键，再序列化。
//
// 其余字段的「值」原样保留（键顺序与结构空白会变，这是可接受的）：用
// SetEscapeHTML(false) 避免值里的 < > & 被重新转义，保证只动 model 这一个字段。
func rewriteModel(body []byte, upstreamModel string) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, err
	}
	if fields == nil {
		// 合法 JSON 但不是对象（如 null）。
		return nil, errors.New("请求体不是 JSON 对象")
	}
	encoded, err := json.Marshal(upstreamModel)
	if err != nil {
		return nil, err
	}
	fields["model"] = encoded

	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(fields); err != nil {
		return nil, err
	}
	// Encode 会补一个换行；去掉它，让输出更贴近原始 body 的形态。
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}
