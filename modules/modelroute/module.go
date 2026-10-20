// Package modelroute 是 LLM 请求的模型路由与模型映射中间件。
//
// 它把「客户端请求的对外模型名」变成两件事：
//
//   - 路由（pre 相位，model-route）：按账号声明的 Models 过滤候选，让
//     accountpriority 只在真正服务该模型的账号里打分；
//   - 映射（dispatch 相位，model-map）：按选中账号的 ModelMap 把 body 顶层的
//     model 字段换成上游真实模型名，写进 Ctx.MappedBody（nil = 不映射）。
//
// 两个阶段分处 pre 与 dispatch，而 Registry.Stage() 只按注册顺序追加、engine
// 又强制相位不倒退，所以这里提供两个注册函数，由组合根按位置各调一次：
//
//	keyauth → RegisterRouter → accountpriority → RegisterMapper → protoconv → transport
//
// 边界（AGENTS.md §2.3 / §2.4）：
//   - 只 import contracts；
//   - 不读令牌内容（只按账号 id 取模型映射）；模型名不是秘密，可进日志；
//   - 未声明 Models / ModelMap 的账号行为与今天逐字节相同（不参与过滤 + 不映射）。
package modelroute

import (
	"errors"
	"log/slog"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const (
	// ServiceName 是注册表里的服务名。
	ServiceName = "model-route"
	// RouteStageName 是 pre 相位的路由过滤阶段名。
	RouteStageName = "model-route"
	// MapStageName 是 dispatch 相位的模型映射阶段名。
	MapStageName = "model-map"
)

// Config 是模型路由模块的运行参数。目前没有可调项，保留以对齐 Register 模板。
type Config struct{}

// Service 是模型路由模块的能力面：候选过滤 + 模型映射。
//
// 它不含秘密：只按账号 id 查「对外模型名 → 上游模型名」的映射，从不读取令牌内容。
type Service struct {
	creds  contracts.CredentialSource
	logger *slog.Logger
}

// New 构造服务。creds 只有映射阶段需要；路由阶段不取凭据，可为 nil。
func New(creds contracts.CredentialSource, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{creds: creds, logger: logger}
}

// RegisterRouter 注册 pre 相位的路由过滤阶段，并暴露能力型服务。
//
// 必须排在 accountpriority **之前**：它在 pre 相位原地收窄 Ctx.AccountCandidates，
// 后面的 accountpriority 只在剩下的账号里打分。
func RegisterRouter(reg *contracts.Registry, _ Config, logger *slog.Logger) (*Service, error) {
	if reg == nil {
		return nil, errors.New("modelroute: Registry 不能为空")
	}
	service := New(nil, logger)
	reg.Service(ServiceName, service)
	reg.Stage(NewRouteStage(service))
	return service, nil
}

// RegisterMapper 注册 dispatch 相位的模型映射阶段。
//
// 必须排在 accountpriority **之后**（要读 Ctx.AccountRoute.Picked）、protoconv
// **之前**（protoconv 解析 IR 时优先用 Ctx.MappedBody）。
func RegisterMapper(reg *contracts.Registry, _ Config, creds contracts.CredentialSource, logger *slog.Logger) error {
	if reg == nil {
		return errors.New("modelroute: Registry 不能为空")
	}
	if creds == nil {
		return errors.New("modelroute: CredentialSource 不能为空")
	}
	reg.Stage(NewMapStage(New(creds, logger)))
	return nil
}
