package protoconv

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// fakeCodec 是框架测试用的假 codec：行为可注入。
type fakeCodec struct {
	protocol contracts.Protocol
	parse    func([]byte) (*contracts.Request, error)
	render   func(*contracts.Request) ([]byte, error)
}

func (c fakeCodec) Protocol() contracts.Protocol { return c.protocol }

func (c fakeCodec) ParseRequest(body []byte) (*contracts.Request, error) {
	if c.parse != nil {
		return c.parse(body)
	}
	return &contracts.Request{}, nil
}

func (c fakeCodec) RenderRequest(request *contracts.Request) ([]byte, error) {
	if c.render != nil {
		return c.render(request)
	}
	return []byte(`{"rendered":true}`), nil
}

func (c fakeCodec) ParseResponse([]byte) (*contracts.Response, error) {
	return &contracts.Response{}, nil
}
func (c fakeCodec) RenderResponse(*contracts.Response) ([]byte, error) {
	return []byte(`{}`), nil
}
func (c fakeCodec) NewStreamDecoder() contracts.StreamDecoder { return noopDecoder{} }
func (c fakeCodec) NewStreamEncoder() contracts.StreamEncoder { return noopEncoder{} }

type noopDecoder struct{}

func (noopDecoder) Push([]byte, func(contracts.Event)) error { return nil }
func (noopDecoder) Close(func(contracts.Event)) error        { return nil }

type noopEncoder struct{}

func (noopEncoder) Encode(contracts.Event) ([][]byte, error)            { return nil, nil }
func (noopEncoder) EncodeError(contracts.StreamError) ([][]byte, error) { return nil, nil }
func (noopEncoder) Flush() ([][]byte, error)                            { return nil, nil }

// fakeCreds 是「账号 id → 协议」的假凭据源。
type fakeCreds map[string]string

func (c fakeCreds) Credential(accountID string) (contracts.AccountCredential, bool) {
	protocol, ok := c[accountID]
	if !ok {
		return contracts.AccountCredential{}, false
	}
	return contracts.AccountCredential{AccountID: accountID, Protocol: protocol}, true
}

func newStage(t *testing.T, codecs *contracts.CodecRegistry, creds contracts.CredentialSource) *Stage {
	t.Helper()
	service, err := New(codecs, creds, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return NewStage(service)
}

func requestCtx(client contracts.Protocol, accountID string) *contracts.Ctx {
	ctx := &contracts.Ctx{
		Context:        context.Background(),
		ReqID:          "req-test",
		Body:           contracts.BytesBody([]byte(`{"model":"m"}`)),
		ClientProtocol: client,
	}
	if accountID != "" {
		ctx.AccountRoute = &contracts.AccountRoute{Picked: &contracts.ScoredAccount{AccountID: accountID}}
	}
	return ctx
}

func registryWith(t *testing.T, codecs ...contracts.Codec) *contracts.CodecRegistry {
	t.Helper()
	registry := contracts.NewCodecRegistry()
	for _, codec := range codecs {
		if err := registry.Register(codec); err != nil {
			t.Fatalf("Register: %v", err)
		}
	}
	return registry
}

func TestStageLegacyPathIsPassthrough(t *testing.T) {
	stage := newStage(t, registryWith(t), fakeCreds{"a": "anthropic"})
	ctx := requestCtx("", "a")
	ctx.Upstream = &contracts.UpstreamRequest{Protocol: contracts.ProtocolAnthropic}

	decision, err := stage.Run(ctx)
	if err != nil || decision.Action != contracts.ActionContinue {
		t.Fatalf("旧路径应直通：%+v %v", decision, err)
	}
	if ctx.Upstream != nil {
		t.Fatal("旧路径必须把 Upstream 置 nil")
	}
}

func TestStageSameProtocolIsFastPath(t *testing.T) {
	stage := newStage(t, registryWith(t), fakeCreds{"a": "openai-chat"})
	ctx := requestCtx(contracts.ProtocolOpenAIChat, "a")

	_, err := stage.Run(ctx)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctx.Upstream != nil {
		t.Fatal("同协议必须直通（Upstream=nil）")
	}
}

func TestStageMissingAccountIsPassthrough(t *testing.T) {
	stage := newStage(t, registryWith(t), fakeCreds{})
	ctx := requestCtx(contracts.ProtocolAnthropic, "missing")

	_, err := stage.Run(ctx)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctx.Upstream != nil {
		t.Fatal("拿不到账号时应直通，让 transport 报账号错误")
	}
}

func TestStageConvertsAcrossProtocols(t *testing.T) {
	codecs := registryWith(t,
		fakeCodec{protocol: contracts.ProtocolOpenAIChat},
		// 出站 codec 是上游协议（anthropic）的：由它渲染上游请求体。
		fakeCodec{protocol: contracts.ProtocolAnthropic, render: func(*contracts.Request) ([]byte, error) {
			return []byte(`{"converted":"yes"}`), nil
		}},
	)
	stage := newStage(t, codecs, fakeCreds{"a": "anthropic"})
	ctx := requestCtx(contracts.ProtocolOpenAIChat, "a")

	_, err := stage.Run(ctx)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctx.Upstream == nil {
		t.Fatal("跨协议必须写入 Upstream")
	}
	if ctx.Upstream.Protocol != contracts.ProtocolAnthropic {
		t.Fatalf("上游协议不对：%s", ctx.Upstream.Protocol)
	}
	if string(ctx.Upstream.Body) != `{"converted":"yes"}` {
		t.Fatalf("上游请求体不对：%s", ctx.Upstream.Body)
	}
}

func TestStageFailClosedWhenUpstreamUnknown(t *testing.T) {
	stage := newStage(t, registryWith(t), fakeCreds{"a": ""})
	ctx := requestCtx(contracts.ProtocolAnthropic, "a")

	_, err := stage.Run(ctx)
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) {
		t.Fatalf("期望 StageError，得到 %v", err)
	}
	if stageErr.Code != CodeProtocolUnknown || stageErr.Status != 502 {
		t.Fatalf("fail-closed 错误不对：%+v", stageErr)
	}
	if ctx.Upstream != nil {
		t.Fatal("失败时不得写入 Upstream")
	}
}

func TestStageUpstreamUnknownClientChatIsPassthrough(t *testing.T) {
	stage := newStage(t, registryWith(t), fakeCreds{"a": ""})
	ctx := requestCtx(contracts.ProtocolOpenAIChat, "a")

	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctx.Upstream != nil {
		t.Fatal("openai-chat 客户端 + 未声明上游协议应直通")
	}
}

func TestStageResetsUpstreamEachAttempt(t *testing.T) {
	stage := newStage(t, registryWith(t), fakeCreds{"a": "openai-chat"})
	ctx := requestCtx(contracts.ProtocolOpenAIChat, "a")
	// 模拟上一次 attempt 残留。
	ctx.Upstream = &contracts.UpstreamRequest{Protocol: contracts.ProtocolAnthropic, Body: []byte("stale")}

	if _, err := stage.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctx.Upstream != nil {
		t.Fatalf("每个 attempt 必须重置 Upstream，残留=%+v", ctx.Upstream)
	}
}

func TestStageConvertFailureIsNotRetryable(t *testing.T) {
	codecs := registryWith(t,
		fakeCodec{protocol: contracts.ProtocolOpenAIChat, parse: func([]byte) (*contracts.Request, error) {
			return nil, errors.New("bad body")
		}},
		fakeCodec{protocol: contracts.ProtocolAnthropic},
	)
	stage := newStage(t, codecs, fakeCreds{"a": "anthropic"})
	ctx := requestCtx(contracts.ProtocolOpenAIChat, "a")

	_, err := stage.Run(ctx)
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) {
		t.Fatalf("期望 StageError，得到 %v", err)
	}
	if stageErr.Code != CodeConvertFailed || stageErr.Status != 400 || stageErr.Retryable {
		t.Fatalf("转换失败应 400 且不可重试：%+v", stageErr)
	}
}

func TestStageCodecUnavailableWhenNotRegistered(t *testing.T) {
	// 只注册 chat codec；上游 anthropic 的 codec 未注册。
	stage := newStage(t, registryWith(t, fakeCodec{protocol: contracts.ProtocolOpenAIChat}), fakeCreds{"a": "anthropic"})
	ctx := requestCtx(contracts.ProtocolOpenAIChat, "a")

	_, err := stage.Run(ctx)
	var stageErr *contracts.StageError
	if !errors.As(err, &stageErr) {
		t.Fatalf("期望 StageError，得到 %v", err)
	}
	if stageErr.Code != CodeCodecUnavailable || stageErr.Status != 502 {
		t.Fatalf("缺少 codec 应 502：%+v", stageErr)
	}
}
