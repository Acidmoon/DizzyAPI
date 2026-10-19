package accountpriority

import (
	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Register 把本模块挂到组合根上：一个能力型服务 + 一个阶段型阶段。
// 去掉 main.go 里的这一行，模块就整体消失；此时描述符若仍引用这个阶段，
// 启动校验必须显式失败（AGENTS.md D4 / §5.1）。
func Register(reg *contracts.Registry, cfg Config) (*Service, error) {
	if reg == nil {
		return nil, newError(CodeInvalidRequest, "Registry 不能为空")
	}
	service, err := New(cfg)
	if err != nil {
		return nil, err
	}
	reg.Service(ServiceName, service)
	reg.Stage(NewStage(service))
	return service, nil
}
