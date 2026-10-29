package usageprobe_test

import (
	"io"
	"strings"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/usageprobe"
	"github.com/Acidmoon/DizzyAPI/modules/protoconv"
)

func newRegistry(t *testing.T) *contracts.CodecRegistry {
	t.Helper()
	registry := contracts.NewCodecRegistry()
	codecs := []contracts.Codec{
		protoconv.NewChatCodec(),
		protoconv.NewResponsesCodec(),
		protoconv.NewAnthropicCodec(protoconv.AnthropicConfig{}),
		protoconv.NewGeminiCodec(),
	}
	for _, codec := range codecs {
		if err := registry.Register(codec); err != nil {
			t.Fatalf("Register(%s): %v", codec.Protocol(), err)
		}
	}
	return registry
}

func TestExtractNonStream(t *testing.T) {
	probe := usageprobe.New(newRegistry(t))

	t.Run("openai-chat 含缓存", func(t *testing.T) {
		body := []byte(`{"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":30}}}`)
		usage, present := probe.Extract(contracts.ProtocolOpenAIChat, body)
		if !present {
			t.Fatal("应识别到 usage")
		}
		if usage.InputTokens != 100 || usage.OutputTokens != 20 || usage.CacheReadInputTokens != 30 {
			t.Fatalf("原始口径不符：%+v", usage)
		}
		normalized := usageprobe.Normalize(usage, contracts.ProtocolOpenAIChat)
		if normalized.InputTokens != 70 || normalized.CacheReadInputTokens != 30 || normalized.CacheCreationInputTokens != 0 {
			t.Fatalf("OpenAI 归一化不符：%+v", normalized)
		}
		if total := usageprobe.TotalTokens(normalized); total != 120 {
			t.Fatalf("total = %d，期望 120", total)
		}
	})

	t.Run("openai-responses", func(t *testing.T) {
		body := []byte(`{"id":"r1","object":"response","model":"m","output":[],"usage":{"input_tokens":50,"output_tokens":10,"input_tokens_details":{"cached_tokens":5}}}`)
		usage, present := probe.Extract(contracts.ProtocolOpenAIResponses, body)
		if !present {
			t.Fatal("应识别到 usage")
		}
		if usage.InputTokens != 50 || usage.CacheReadInputTokens != 5 {
			t.Fatalf("解析结果不符：%+v", usage)
		}
		normalized := usageprobe.Normalize(usage, contracts.ProtocolOpenAIResponses)
		if normalized.InputTokens != 45 {
			t.Fatalf("归一化 input = %d，期望 45", normalized.InputTokens)
		}
	})

	t.Run("anthropic 不含缓存", func(t *testing.T) {
		body := []byte(`{"id":"a1","type":"message","model":"m","content":[],"usage":{"input_tokens":12,"output_tokens":7,"cache_creation_input_tokens":4,"cache_read_input_tokens":2}}`)
		usage, present := probe.Extract(contracts.ProtocolAnthropic, body)
		if !present {
			t.Fatal("应识别到 usage")
		}
		normalized := usageprobe.Normalize(usage, contracts.ProtocolAnthropic)
		if normalized.InputTokens != 12 || normalized.CacheCreationInputTokens != 4 || normalized.CacheReadInputTokens != 2 {
			t.Fatalf("Anthropic 归一化不符：%+v", normalized)
		}
		if total := usageprobe.TotalTokens(normalized); total != 25 {
			t.Fatalf("total = %d，期望 25", total)
		}
	})

	t.Run("gemini：promptTokenCount 含缓存，按上游协议做减法", func(t *testing.T) {
		body := []byte(`{"candidates":[],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"cachedContentTokenCount":30,"thoughtsTokenCount":8,"totalTokenCount":128}}`)
		usage, present := probe.Extract(contracts.ProtocolGemini, body)
		if !present {
			t.Fatal("应识别到 usage")
		}
		if usage.InputTokens != 100 || usage.OutputTokens != 20 {
			t.Fatalf("原始口径不符：%+v", usage)
		}
		if usage.CacheReadInputTokens != 30 || usage.ReasoningTokens != 8 {
			t.Fatalf("缓存 / 思考 token 不符：%+v", usage)
		}
		normalized := usageprobe.Normalize(usage, contracts.ProtocolGemini)
		if normalized.InputTokens != 70 || normalized.CacheReadInputTokens != 30 {
			t.Fatalf("Gemini 归一化不符：%+v", normalized)
		}
		if normalized.CacheCreationInputTokens != 0 {
			t.Fatalf("Gemini 没有写缓存：%+v", normalized)
		}
		if normalized.OutputTokens != 20 || normalized.ReasoningTokens != 8 {
			t.Fatalf("输出桶不该被减去：%+v", normalized)
		}
		// 不重复相加：reasoning 是 output 的子集。
		if total := usageprobe.TotalTokens(normalized); total != 120 {
			t.Fatalf("total = %d，期望 120", total)
		}
	})

	t.Run("三种协议都没有 usage 键", func(t *testing.T) {
		bodies := map[contracts.Protocol]string{
			contracts.ProtocolOpenAIChat:      `{"id":"c2","model":"m","choices":[]}`,
			contracts.ProtocolOpenAIResponses: `{"id":"r2","object":"response","model":"m","output":[]}`,
			contracts.ProtocolAnthropic:       `{"id":"a2","type":"message","model":"m","content":[]}`,
		}
		for protocol, body := range bodies {
			if _, present := probe.Extract(protocol, []byte(body)); present {
				t.Fatalf("%s 没有 usage 键时 present 应为 false", protocol)
			}
		}
	})

	t.Run("未知协议与坏 JSON", func(t *testing.T) {
		if _, present := probe.Extract(contracts.Protocol("unknown"), []byte(`{}`)); present {
			t.Fatal("未知协议不应提取到 usage")
		}
		if _, present := probe.Extract(contracts.ProtocolOpenAIChat, []byte(`{`)); present {
			t.Fatal("坏 JSON 不应提取到 usage")
		}
	})
}

// splitReader 让第一次 Read 只返回前半段，用来验证跨 chunk 的半截 SSE 帧。
type splitReader struct {
	sentFirst bool
	first     []byte
	second    []byte
}

func (r *splitReader) Read(p []byte) (int, error) {
	if !r.sentFirst {
		r.sentFirst = true
		n := copy(p, r.first)
		return n, nil
	}
	if len(r.second) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.second)
	r.second = r.second[n:]
	return n, nil
}

func TestWatchSplitsSSEFrameAcrossReads(t *testing.T) {
	stream := "data: {\"id\":\"c1\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\n" +
		"data: {\"id\":\"c1\",\"model\":\"m\",\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n" +
		"data: [DONE]\n\n"
	// 在第二帧中间切开，模拟网络分块。
	cut := strings.Index(stream, "\"usage\"") + 3
	source := &splitReader{first: []byte(stream[:cut]), second: []byte(stream[cut:])}

	probe := usageprobe.New(newRegistry(t))
	reader, settle := probe.Watch(contracts.ProtocolOpenAIChat, source)
	payload, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if string(payload) != stream {
		t.Fatal("包装后的 reader 必须原样透传字节")
	}
	usage, present, errorCode := settle()
	if !present {
		t.Fatal("应采集到 usage")
	}
	if usage.InputTokens != 10 || usage.OutputTokens != 5 {
		t.Fatalf("usage 不符：%+v", usage)
	}
	if errorCode != "" {
		t.Fatalf("不应有错误码，得到 %q", errorCode)
	}
}

func TestWatchAnthropicMergesTwoEvents(t *testing.T) {
	stream := "event: message_start\n" +
		"data: {\"type\":\"message_start\",\"message\":{\"id\":\"a1\",\"model\":\"m\",\"usage\":{\"input_tokens\":100,\"output_tokens\":1,\"cache_creation_input_tokens\":5,\"cache_read_input_tokens\":20}}}\n\n" +
		"event: message_delta\n" +
		"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":50}}\n\n" +
		"event: message_stop\n" +
		"data: {\"type\":\"message_stop\"}\n\n"

	probe := usageprobe.New(newRegistry(t))
	reader, settle := probe.Watch(contracts.ProtocolAnthropic, strings.NewReader(stream))
	if _, err := io.ReadAll(reader); err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	usage, present, errorCode := settle()
	if !present {
		t.Fatal("应采集到 usage")
	}
	// max 合并：input / cache 来自 message_start，output 来自 message_delta。
	if usage.InputTokens != 100 || usage.OutputTokens != 50 {
		t.Fatalf("合并结果不符：%+v", usage)
	}
	if usage.CacheCreationInputTokens != 5 || usage.CacheReadInputTokens != 20 {
		t.Fatalf("缓存桶丢失：%+v", usage)
	}
	if errorCode != "" {
		t.Fatalf("不应有错误码，得到 %q", errorCode)
	}
}

func TestWatchRecordsStreamError(t *testing.T) {
	stream := "event: error\n" +
		"data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"busy\"}}\n\n"

	probe := usageprobe.New(newRegistry(t))
	reader, settle := probe.Watch(contracts.ProtocolAnthropic, strings.NewReader(stream))
	if _, err := io.ReadAll(reader); err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	_, present, errorCode := settle()
	if present {
		t.Fatal("错误流不应有 usage")
	}
	if errorCode != protoconv.CodeTranscodeFailed {
		t.Fatalf("errorCode = %q，期望 %q", errorCode, protoconv.CodeTranscodeFailed)
	}
}

func TestWatchMalformedFrameDoesNotBreakCaller(t *testing.T) {
	stream := "data: {not json}\n\ndata: [DONE]\n\n"

	probe := usageprobe.New(newRegistry(t))
	reader, settle := probe.Watch(contracts.ProtocolOpenAIChat, strings.NewReader(stream))
	payload, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if string(payload) != stream {
		t.Fatal("解析失败也必须原样透传字节")
	}
	_, present, errorCode := settle()
	if present {
		t.Fatal("坏帧不应产生 usage")
	}
	if errorCode != protoconv.CodeTranscodeFailed {
		t.Fatalf("errorCode = %q，期望 %q", errorCode, protoconv.CodeTranscodeFailed)
	}
}

func TestWatchWithoutCodecIsTransparent(t *testing.T) {
	probe := usageprobe.New(newRegistry(t))
	source := strings.NewReader("not-sse")
	reader, settle := probe.Watch(contracts.Protocol("unknown"), source)
	payload, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if string(payload) != "not-sse" {
		t.Fatalf("未知协议应原样透传，得到 %q", payload)
	}
	usage, present, errorCode := settle()
	if present || errorCode != "" || usage.InputTokens != 0 {
		t.Fatalf("未知协议不应产生用量：%+v %v %q", usage, present, errorCode)
	}
}
