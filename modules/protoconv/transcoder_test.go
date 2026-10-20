package protoconv

import (
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

func newTranscoder(t *testing.T) *Transcoder {
	t.Helper()
	codecs := contracts.NewCodecRegistry()
	if err := codecs.Register(NewChatCodec()); err != nil {
		t.Fatalf("Register: %v", err)
	}
	return &Transcoder{codecs: codecs, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func TestTranscoderNonStream(t *testing.T) {
	transcoder := newTranscoder(t)
	ctx := &contracts.Ctx{
		ReqID:          "r",
		ClientProtocol: contracts.ProtocolOpenAIChat,
		Upstream:       &contracts.UpstreamRequest{Protocol: contracts.ProtocolOpenAIChat},
	}
	body := `{"id":"chatcmpl-1","model":"gpt-4","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`
	decision, err := transcoder.TranscodeResponse(ctx, contracts.UpstreamResponse{Status: 200, Body: []byte(body)})
	if err != nil {
		t.Fatalf("TranscodeResponse: %v", err)
	}
	if decision.Status != 200 || !strings.Contains(string(decision.Body), `"hi"`) {
		t.Fatalf("转换结果不对：%+v", decision)
	}
}

func TestTranscoderStream(t *testing.T) {
	transcoder := newTranscoder(t)
	ctx := &contracts.Ctx{
		ReqID:          "r",
		Meta:           contracts.RequestMeta{Stream: true},
		ClientProtocol: contracts.ProtocolOpenAIChat,
		Upstream:       &contracts.UpstreamRequest{Protocol: contracts.ProtocolOpenAIChat},
	}
	source := io.NopCloser(strings.NewReader(strings.Join([]string{
		`data: {"id":"c","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}`,
		``,
		`data: {"id":"c","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")))

	decision, err := transcoder.TranscodeResponse(ctx, contracts.UpstreamResponse{Status: 200, Stream: source})
	if err != nil {
		t.Fatalf("TranscodeResponse: %v", err)
	}
	if decision.Stream == nil {
		t.Fatal("流式转换必须返回 Stream")
	}
	defer decision.Stream.Close()
	payload, err := io.ReadAll(decision.Stream)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	out := string(payload)
	if !strings.Contains(out, `"content":"hi"`) || !strings.Contains(out, "data: [DONE]") {
		t.Fatalf("流式转换结果不对：%s", out)
	}
}

func TestTranscoderMissingContext(t *testing.T) {
	transcoder := newTranscoder(t)
	if _, err := transcoder.TranscodeResponse(&contracts.Ctx{}, contracts.UpstreamResponse{}); err == nil {
		t.Fatal("缺少 Upstream 必须报错")
	}
}
