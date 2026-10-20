package protoconv

import (
	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Stage 是 dispatch 相位的协议转换阶段，注册在 transport 之前。
//
// 它只写 Ctx.Upstream：
//   - nil  = 直通（transport 用客户端原始字节）；
//   - 非 nil = 转换后的上游请求（transport 用它，并按它的 Protocol 选方言）。
//
// 关键：每个 attempt 都必须显式写 Ctx.Upstream（含置 nil）。engine.runDispatch
// 的失败转移循环会重跑本阶段，残留上一次的结果就会发错请求体。
type Stage struct {
	service *Service
}

// NewStage 用现有服务构造阶段。
func NewStage(service *Service) *Stage {
	return &Stage{service: service}
}

func (s *Stage) Name() string           { return StageName }
func (s *Stage) Phase() contracts.Phase { return contracts.PhaseDispatch }
func (s *Stage) Required() bool         { return true }
func (s *Stage) NeedBody() bool         { return true }

var continueDecision = contracts.Decision{Action: contracts.ActionContinue}

// Run 计算本 attempt 的上游请求体。
func (s *Stage) Run(ctx *contracts.Ctx) (contracts.Decision, error) {
	if ctx == nil {
		return contracts.Decision{}, contracts.Errorf(500, "PROTOCOL_CONVERT_INVALID_REQUEST", "请求上下文为空")
	}

	// 1) 每个 attempt 先显式重置：绝不残留上一次转换结果。
	ctx.Upstream = nil

	client := ctx.ClientProtocol
	if client == "" {
		// 旧路径 / 未知客户端协议：直通。
		return continueDecision, nil
	}

	// 2) 取不到选中账号或凭据：交给 transport 报账号错误。
	upstream, ok := s.service.upstreamProtocol(ctx)
	if !ok {
		return continueDecision, nil
	}

	// 3) 上游协议未声明：openai-chat 客户端可直通；其他协议 fail-closed。
	if upstream == "" {
		if client == contracts.ProtocolOpenAIChat {
			return continueDecision, nil
		}
		return contracts.Decision{}, protocolUnknown()
	}

	// 4) 同协议：快路径直通。
	if upstream == client {
		return continueDecision, nil
	}

	// 5) 跨协议：入站 codec 解析，出站 codec 渲染。
	inbound, ok := s.service.codecs.Lookup(client)
	if !ok {
		return contracts.Decision{}, codecUnavailable()
	}
	outbound, ok := s.service.codecs.Lookup(upstream)
	if !ok {
		return contracts.Decision{}, codecUnavailable()
	}
	if ctx.Body == nil {
		return contracts.Decision{}, convertFailed()
	}
	// 始终从客户端原始字节重新解析，保证幂等。
	body, err := ctx.Body.Bytes()
	if err != nil {
		return contracts.Decision{}, convertFailed()
	}
	request, err := inbound.ParseRequest(body)
	if err != nil {
		return contracts.Decision{}, convertFailed()
	}
	rendered, err := outbound.RenderRequest(request)
	if err != nil {
		return contracts.Decision{}, convertFailed()
	}

	// 6) 补齐 LossyNote 的方向端点（codec 只知道自己的协议）。
	notes := request.Lossy
	for index := range notes {
		if notes[index].From == "" {
			notes[index].From = client
		}
		if notes[index].To == "" {
			notes[index].To = upstream
		}
	}
	ctx.Upstream = &contracts.UpstreamRequest{
		Protocol: upstream,
		Body:     rendered,
		Lossy:    notes,
	}
	s.service.logLossy(ctx.ReqID, notes)
	return continueDecision, nil
}
