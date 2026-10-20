package protoconv

import (
	"errors"
	"log/slog"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const (
	// ServiceName 是注册表里的服务名。
	ServiceName = "protocol-convert"
	// StageName 是描述符里的阶段名。
	StageName = "protocol-convert"
)

// Config 是协议转换模块的运行参数。目前没有可调项，保留以对齐 Register 模板。
type Config struct{}

// Register 把本模块挂到组合根上：一个能力型服务 + 一个 dispatch 阶段。
//
// 阶段必须注册在 transport **之前**（组合根按注册顺序决定阶段顺序）。
// 去掉 main.go 里的这一行，模块就整体消失：此时跨协议请求会因缺少
// Ctx.Upstream 而走直通路径（上游协议与客户端协议不一致时行为退化）。
//
// 返回的 Service 暴露 Transcoder()，组合根把它注入 transport。
func Register(
	reg *contracts.Registry,
	_ Config,
	codecs *contracts.CodecRegistry,
	creds contracts.CredentialSource,
	logger *slog.Logger,
) (*Service, error) {
	if reg == nil {
		return nil, errors.New("protoconv: Registry 不能为空")
	}
	service, err := New(codecs, creds, logger)
	if err != nil {
		return nil, err
	}
	reg.Service(ServiceName, service)
	reg.Stage(NewStage(service))
	return service, nil
}
