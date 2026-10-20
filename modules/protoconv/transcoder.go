package protoconv

import (
	"io"
	"log/slog"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Transcoder 实现 contracts.ResponseTranscoder：把上游协议的响应转成客户端协议。
//
// 上游协议 = ctx.Upstream.Protocol（它的 codec 解析上游响应）；
// 客户端协议 = ctx.ClientProtocol（它的 codec 渲染客户端响应）。
type Transcoder struct {
	codecs *contracts.CodecRegistry
	logger *slog.Logger
}

// TranscodeResponse 转换一次上游响应。
func (t *Transcoder) TranscodeResponse(ctx *contracts.Ctx, up contracts.UpstreamResponse) (contracts.Decision, error) {
	if ctx == nil || ctx.Upstream == nil {
		return contracts.Decision{}, contracts.Errorf(500, "PROTOCOL_CONVERT_INVALID_REQUEST", "缺少转换上下文")
	}
	upstreamCodec, ok := t.codecs.Lookup(ctx.Upstream.Protocol)
	if !ok {
		return contracts.Decision{}, codecUnavailable()
	}
	clientCodec, ok := t.codecs.Lookup(ctx.ClientProtocol)
	if !ok {
		return contracts.Decision{}, codecUnavailable()
	}
	if ctx.Meta.Stream {
		return t.transcodeStream(ctx, up, upstreamCodec, clientCodec)
	}
	return t.transcodeBody(ctx, up, upstreamCodec, clientCodec)
}

func (t *Transcoder) transcodeBody(
	ctx *contracts.Ctx,
	up contracts.UpstreamResponse,
	upstreamCodec, clientCodec contracts.Codec,
) (contracts.Decision, error) {
	if up.Stream != nil {
		defer up.Stream.Close()
	}
	response, err := upstreamCodec.ParseResponse(up.Body)
	if err != nil {
		return contracts.Decision{}, transcodeFailed()
	}
	t.fillLossy(ctx, response.Lossy)
	body, err := clientCodec.RenderResponse(response)
	if err != nil {
		return contracts.Decision{}, transcodeFailed()
	}
	t.logLossy(ctx.ReqID, response.Lossy)
	return contracts.Decision{
		Action:  contracts.ActionRespond,
		Status:  normalizeStatus(up.Status),
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    body,
	}, nil
}

func (t *Transcoder) transcodeStream(
	ctx *contracts.Ctx,
	up contracts.UpstreamResponse,
	upstreamCodec, clientCodec contracts.Codec,
) (contracts.Decision, error) {
	if up.Stream == nil {
		return contracts.Decision{}, transcodeFailed()
	}
	reader, writer := io.Pipe()
	decoder := upstreamCodec.NewStreamDecoder()
	encoder := clientCodec.NewStreamEncoder()
	go t.pump(ctx, up.Stream, writer, decoder, encoder)
	return contracts.Decision{
		Action:  contracts.ActionRespond,
		Status:  normalizeStatus(up.Status),
		Headers: map[string]string{"Content-Type": "text/event-stream"},
		Stream:  reader,
	}, nil
}

// pump 把上游流经 decoder → 事件 → encoder → 转换后的字节写进管道。
//
// 它由 Decision.Stream 的读取方驱动：读取方关闭 pipe 时 Write 会失败，
// goroutine 随即停止读取、退出并关闭上游流（不把上游排空）。
func (t *Transcoder) pump(
	ctx *contracts.Ctx,
	source io.ReadCloser,
	sink *io.PipeWriter,
	decoder contracts.StreamDecoder,
	encoder contracts.StreamEncoder,
) {
	defer source.Close()

	var writeErr error
	emit := func(event contracts.Event) {
		if writeErr != nil {
			return
		}
		frames, err := encoder.Encode(event)
		if err != nil {
			return
		}
		writeErr = writeFrames(sink, frames)
	}

	buffer := make([]byte, 32<<10)
	for writeErr == nil {
		read, err := source.Read(buffer)
		if read > 0 {
			if pushErr := decoder.Push(buffer[:read], emit); pushErr != nil {
				_ = writeFrames(sink, mustFrames(encoder.EncodeError(contracts.StreamError{
					Type:    "api_error",
					Code:    CodeTranscodeFailed,
					Message: "上游流解析失败",
				})))
				break
			}
		}
		if err != nil {
			break
		}
	}
	if writeErr == nil {
		_ = decoder.Close(emit)
		_ = writeFrames(sink, mustFrames(encoder.Flush()))
	}
	_ = sink.CloseWithError(writeErr)
}

func writeFrames(sink io.Writer, frames [][]byte) error {
	for _, frame := range frames {
		if _, err := sink.Write(frame); err != nil {
			return err
		}
	}
	return nil
}

func mustFrames(frames [][]byte, err error) [][]byte {
	if err != nil {
		return nil
	}
	return frames
}

// fillLossy 补齐响应方向 LossyNote 的端点（codec 只知道自己的协议）。
func (t *Transcoder) fillLossy(ctx *contracts.Ctx, notes []contracts.LossyNote) {
	for index := range notes {
		if notes[index].Direction == "" {
			notes[index].Direction = "response"
		}
		if notes[index].From == "" {
			notes[index].From = ctx.Upstream.Protocol
		}
		if notes[index].To == "" {
			notes[index].To = ctx.ClientProtocol
		}
	}
}

func (t *Transcoder) logLossy(reqID string, notes []contracts.LossyNote) {
	for _, note := range notes {
		t.logger.Warn("协议转换有损映射",
			"reqId", reqID,
			"direction", note.Direction,
			"from", string(note.From),
			"to", string(note.To),
			"field", note.Field,
			"action", note.Action,
		)
	}
}

func normalizeStatus(status int) int {
	if status < 200 || status > 299 {
		return 200
	}
	return status
}
