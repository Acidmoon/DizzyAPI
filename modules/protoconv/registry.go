package protoconv

import (
	"errors"
	"log/slog"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Service 是协议转换模块的能力面：codec 注册表 + 账号协议查询 + transcoder。
//
// 它不含秘密：只按账号 id 查协议字符串，从不读取令牌内容。
type Service struct {
	codecs     *contracts.CodecRegistry
	creds      contracts.CredentialSource
	logger     *slog.Logger
	transcoder *Transcoder
}

// New 构造服务。codecs 与 creds 必填。
func New(codecs *contracts.CodecRegistry, creds contracts.CredentialSource, logger *slog.Logger) (*Service, error) {
	if codecs == nil {
		return nil, errors.New("protoconv: CodecRegistry 不能为空")
	}
	if creds == nil {
		return nil, errors.New("protoconv: CredentialSource 不能为空")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		codecs:     codecs,
		creds:      creds,
		logger:     logger,
		transcoder: &Transcoder{codecs: codecs, logger: logger},
	}, nil
}

// Codecs 返回 codec 注册表。
func (s *Service) Codecs() *contracts.CodecRegistry { return s.codecs }

// Transcoder 返回响应方向转换器（交给 transport 注入）。
func (s *Service) Transcoder() contracts.ResponseTranscoder { return s.transcoder }

// upstreamProtocol 返回选中账号声明的上游协议（空 = 未声明 / 无账号）。
func (s *Service) upstreamProtocol(ctx *contracts.Ctx) (contracts.Protocol, bool) {
	if ctx == nil || ctx.AccountRoute == nil || ctx.AccountRoute.Picked == nil {
		return "", false
	}
	credential, ok := s.creds.Credential(ctx.AccountRoute.Picked.AccountID)
	if !ok {
		return "", false
	}
	return contracts.Protocol(credential.Protocol), true
}

// logLossy 把有损映射写进日志：只记 reqId / 方向 / from / to / 字段名 / action，
// 绝不记内容（AGENTS.md §2.4 秘密边界）。
func (s *Service) logLossy(reqID string, notes []contracts.LossyNote) {
	for _, note := range notes {
		s.logger.Warn("协议转换有损映射",
			"reqId", reqID,
			"direction", note.Direction,
			"from", string(note.From),
			"to", string(note.To),
			"field", note.Field,
			"action", note.Action,
		)
	}
}
