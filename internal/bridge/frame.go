package bridge

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

// MaxFrameBytes 是单帧上限。控制消息应当是低频率、小体积的；
// LLM 请求永远不走桥（AGENTS.md D3 / §2.3），所以 16 MiB 足够管理面使用。
const MaxFrameBytes = 16 << 20

func readFrame(reader io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return nil, err
	}
	length := binary.BigEndian.Uint32(header[:])
	if length == 0 {
		return nil, fmt.Errorf("bridge: 空帧")
	}
	if length > MaxFrameBytes {
		return nil, fmt.Errorf("bridge: 帧过大（%d 字节，上限 %d）", length, MaxFrameBytes)
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func writeFrame(writer io.Writer, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("bridge: 序列化失败：%w", err)
	}
	if len(payload) > MaxFrameBytes {
		return fmt.Errorf("bridge: 响应帧过大（%d 字节，上限 %d）", len(payload), MaxFrameBytes)
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := writer.Write(header[:]); err != nil {
		return err
	}
	_, err = writer.Write(payload)
	return err
}
