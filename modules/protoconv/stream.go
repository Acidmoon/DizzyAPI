package protoconv

import (
	"bytes"
	"errors"
)

// MaxStreamBuffer 是 SSE 解析缓冲上限（1 MiB）。
//
// 它同时约束「未成帧的残留字节」与「单个事件累积的 data 字节」：
// 超过即判定上游流不可信，报 EventError 而不是无限增长内存。
const MaxStreamBuffer = 1 << 20

// errStreamOverflow 表示 SSE 缓冲超限。
var errStreamOverflow = errors.New("protoconv: SSE 缓冲超过上限")

// sseFrame 是一个完整的 SSE 事件帧。
type sseFrame struct {
	// Event 是 "event:" 字段（无则空）。
	Event string
	// Data 是 "data:" 字段按行拼接（用 \n 连接）。
	Data []byte
	// Done 表示 data == "[DONE]"（OpenAI 流结束哨兵）。
	Done bool
}

// sseFramer 把任意切分的字节流重新切成完整 SSE 事件。
//
// 它按行扫描：一行以 '\n' 结束；行尾的 '\r' 被剥掉；空行结束一个事件。
// 没有遇到 '\n' 的尾部字节留在缓冲里，等下一个 chunk —— 这就是「跨 chunk 半截」的
// 处理方式。所有行都是流式扫描的，不依赖完整 JSON。
type sseFramer struct {
	buffer    []byte
	event     string
	data      [][]byte
	dataBytes int
	max       int
}

func newSSEFramer() *sseFramer {
	return &sseFramer{max: MaxStreamBuffer}
}

// push 喂入一段字节，返回其中已经完整的事件帧。
func (f *sseFramer) push(chunk []byte) ([]sseFrame, error) {
	f.buffer = append(f.buffer, chunk...)
	var frames []sseFrame
	for {
		index := bytes.IndexByte(f.buffer, '\n')
		if index < 0 {
			break
		}
		line := f.buffer[:index]
		f.buffer = f.buffer[index+1:]
		line = bytes.TrimSuffix(line, []byte{'\r'})
		if frame, ok := f.consumeLine(line); ok {
			frames = append(frames, frame)
		}
	}
	if len(f.buffer)+f.dataBytes > f.max {
		return frames, errStreamOverflow
	}
	return frames, nil
}

// close 收尾：把没有以空行结束的尾部事件也吐出来。
func (f *sseFramer) close() ([]sseFrame, error) {
	var frames []sseFrame
	if len(f.buffer) > 0 {
		line := bytes.TrimSuffix(f.buffer, []byte{'\r'})
		f.buffer = nil
		if frame, ok := f.consumeLine(line); ok {
			frames = append(frames, frame)
		}
	}
	if f.event != "" || len(f.data) > 0 {
		frames = append(frames, f.finish())
	}
	return frames, nil
}

// consumeLine 处理一行；返回一个已完成的事件帧（当且仅当遇到空行且事件非空）。
func (f *sseFramer) consumeLine(line []byte) (sseFrame, bool) {
	if len(line) == 0 {
		if f.event == "" && len(f.data) == 0 {
			return sseFrame{}, false
		}
		return f.finish(), true
	}
	if line[0] == ':' {
		// 注释行，忽略。
		return sseFrame{}, false
	}
	field := line
	value := []byte(nil)
	if index := bytes.IndexByte(line, ':'); index >= 0 {
		field = line[:index]
		value = line[index+1:]
		if len(value) > 0 && value[0] == ' ' {
			value = value[1:]
		}
	}
	switch string(field) {
	case "event":
		f.event = string(value)
	case "data":
		f.data = append(f.data, append([]byte(nil), value...))
		f.dataBytes += len(value)
	}
	return sseFrame{}, false
}

func (f *sseFramer) finish() sseFrame {
	data := bytes.Join(f.data, []byte{'\n'})
	frame := sseFrame{
		Event: f.event,
		Data:  data,
		Done:  string(bytes.TrimSpace(data)) == "[DONE]",
	}
	f.event = ""
	f.data = nil
	f.dataBytes = 0
	return frame
}

// encodeSSEFrame 把一个事件编码成 SSE 帧字节。
func encodeSSEFrame(event string, data []byte) []byte {
	var out bytes.Buffer
	if event != "" {
		out.WriteString("event: ")
		out.WriteString(event)
		out.WriteByte('\n')
	}
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		out.WriteString("data: ")
		out.Write(line)
		out.WriteByte('\n')
	}
	out.WriteByte('\n')
	return out.Bytes()
}
