package protoconv

import (
	"bytes"
	"strings"
	"testing"
)

func TestSSEFramerHandlesSplitDataLine(t *testing.T) {
	stream := "data: {\"a\":1}\n\ndata: {\"b\":2}\n\n"
	framer := newSSEFramer()

	// 逐字节喂入，强制把 data: 行切碎。
	var frames []sseFrame
	for index := 0; index < len(stream); index++ {
		got, err := framer.push([]byte{stream[index]})
		if err != nil {
			t.Fatalf("push(%d): %v", index, err)
		}
		frames = append(frames, got...)
	}
	if len(frames) != 2 {
		t.Fatalf("期望 2 个帧，得到 %d：%+v", len(frames), frames)
	}
	if string(frames[0].Data) != `{"a":1}` || string(frames[1].Data) != `{"b":2}` {
		t.Fatalf("帧数据不对：%+v", frames)
	}
}

func TestSSEFramerDetectsDoneAndCRLF(t *testing.T) {
	framer := newSSEFramer()
	frames, err := framer.push([]byte("data: [DONE]\r\n\r\n"))
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	if len(frames) != 1 || !frames[0].Done {
		t.Fatalf("应识别 [DONE]：%+v", frames)
	}
}

func TestSSEFramerEmitsTrailingFrameOnClose(t *testing.T) {
	framer := newSSEFramer()
	if frames, _ := framer.push([]byte("data: {\"x\":1}")); len(frames) != 0 {
		t.Fatalf("未以空行结束不应成帧：%+v", frames)
	}
	frames, err := framer.close()
	if err != nil {
		t.Fatalf("close: %v", err)
	}
	if len(frames) != 1 || string(frames[0].Data) != `{"x":1}` {
		t.Fatalf("close 应吐出尾部事件：%+v", frames)
	}
}

func TestSSEFramerJoinsMultilineDataAndIgnoresComments(t *testing.T) {
	framer := newSSEFramer()
	frames, err := framer.push([]byte(": keep-alive\nevent: ping\ndata: line1\ndata: line2\n\n"))
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	if len(frames) != 1 {
		t.Fatalf("期望 1 帧：%+v", frames)
	}
	if frames[0].Event != "ping" || string(frames[0].Data) != "line1\nline2" {
		t.Fatalf("多行 data / event 解析不对：%+v", frames[0])
	}
}

func TestSSEFramerRejectsOverflow(t *testing.T) {
	framer := newSSEFramer()
	// 一段永不换行的超大块，必须报错而不是无限增长。
	chunk := bytes.Repeat([]byte("x"), MaxStreamBuffer+1)
	if _, err := framer.push(chunk); err == nil {
		t.Fatal("超限必须报错")
	}
}

func TestEncodeSSEFrame(t *testing.T) {
	frame := encodeSSEFrame("", []byte("[DONE]"))
	if !strings.HasSuffix(string(frame), "\n\n") || !strings.HasPrefix(string(frame), "data: [DONE]") {
		t.Fatalf("编码不对：%q", frame)
	}
}
