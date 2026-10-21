package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/accounts"
	"github.com/Acidmoon/DizzyAPI/internal/apikeys"
	"github.com/Acidmoon/DizzyAPI/internal/engine"
	"github.com/Acidmoon/DizzyAPI/internal/usageprobe"
	"github.com/Acidmoon/DizzyAPI/modules/accountpriority"
	"github.com/Acidmoon/DizzyAPI/modules/keyauth"
	"github.com/Acidmoon/DizzyAPI/modules/protoconv"
	"github.com/Acidmoon/DizzyAPI/modules/transport"
)

type usageCapture struct {
	mu      sync.Mutex
	records []contracts.UsageRecord
}

func (c *usageCapture) Append(record contracts.UsageRecord) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.records = append(c.records, record)
}

func (c *usageCapture) all(t *testing.T) []contracts.UsageRecord {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]contracts.UsageRecord(nil), c.records...)
}

func (c *usageCapture) single(t *testing.T) contracts.UsageRecord {
	t.Helper()
	records := c.all(t)
	if len(records) != 1 {
		t.Fatalf("期望 1 条用量记录，得到 %d 条", len(records))
	}
	return records[0]
}

func newUsageGateway(t *testing.T, keyConfig keyauth.Config, mutate func(*Config)) (gateway, *usageCapture) {
	t.Helper()
	cache := accounts.New()
	registry := contracts.NewRegistry()
	keyStage := keyauth.Register(registry, keyConfig)
	if _, err := accountpriority.Register(registry, accountpriority.Config{}); err != nil {
		t.Fatalf("accountpriority.Register: %v", err)
	}

	codecs := contracts.NewCodecRegistry()
	for _, codec := range []contracts.Codec{
		protoconv.NewChatCodec(),
		protoconv.NewResponsesCodec(),
		protoconv.NewAnthropicCodec(protoconv.AnthropicConfig{}),
	} {
		if err := codecs.Register(codec); err != nil {
			t.Fatalf("注册 %s codec: %v", codec.Protocol(), err)
		}
	}
	if _, err := transport.Register(registry, transport.Config{RequestTimeoutMs: 5_000}, cache, nil); err != nil {
		t.Fatalf("transport.Register: %v", err)
	}
	requestEngine, err := engine.New(registry.Stages(), nil)
	if err != nil {
		t.Fatalf("engine.New: %v", err)
	}

	sink := &usageCapture{}
	config := Config{
		Authorizer:        keyStage,
		UsageSink:         sink,
		UsageProbe:        usageprobe.New(codecs),
		RecordStreamUsage: true,
		TrustedProxyHops:  1,
	}
	if mutate != nil {
		mutate(&config)
	}
	server, err := New(requestEngine, cache, nil, config)
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	return gateway{handler: server.Handler(), accounts: cache}, sink
}

func postWithHeaders(t *testing.T, handler http.Handler, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer gateway-key")
	for name, value := range headers {
		if value == "" {
			request.Header.Del(name)
			continue
		}
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestNonStreamUsageRecord(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"c1","model":"gpt-test","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":30}}}`)
	}))
	defer upstream.Close()

	world, sink := newUsageGateway(t, keyauth.Config{}, nil)
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "token-1",
		Protocol: "openai-chat", Priority: 1,
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postWithHeaders(t, world.handler, "/v1/chat/completions",
		`{"model":"gpt-test","messages":[{"role":"user","content":"hi"}]}`,
		map[string]string{"X-Forwarded-For": "198.51.100.7"})
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}

	record := sink.single(t)
	if record.InputTokens != 70 || record.OutputTokens != 20 || record.CacheReadTokens != 30 {
		t.Fatalf("token 桶不符（OpenAI 应扣掉缓存命中）：%+v", record)
	}
	if record.CacheWriteTokens != 0 || record.ReasoningTokens != 0 || record.TotalTokens != 120 {
		t.Fatalf("其余桶不符：%+v", record)
	}
	if record.Model != "gpt-test" {
		t.Fatalf("model = %q", record.Model)
	}
	if record.Protocol != contracts.ProtocolOpenAIChat || record.UpstreamProtocol != contracts.ProtocolOpenAIChat {
		t.Fatalf("协议字段不符：%q → %q", record.Protocol, record.UpstreamProtocol)
	}
	if record.AccountID != "acc-1" {
		t.Fatalf("accountId = %q", record.AccountID)
	}
	if record.KeyID == "" || record.UserID != "" {
		t.Fatalf("静态 key 应只有 keyId：%+v", record)
	}
	if record.ClientIP != "198.51.100.7" {
		t.Fatalf("clientIp = %q", record.ClientIP)
	}
	if record.Status != http.StatusOK || record.ErrorCode != "" || record.Stream {
		t.Fatalf("状态字段不符：%+v", record)
	}
	if !record.UsagePresent || !record.UsageComplete {
		t.Fatalf("非流式 usage 应 present 且 complete：%+v", record)
	}
	if record.Attempts != 1 || record.StartedAt.IsZero() {
		t.Fatalf("attempts / startedAt 不符：%+v", record)
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("记录无法序列化：%v", err)
	}
	if strings.Contains(string(encoded), "token-1") {
		t.Fatal("用量记录泄漏了上游令牌")
	}
}

func TestClientIPResolution(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"c1","model":"gpt-test","choices":[]}`)
	}))
	defer upstream.Close()

	world, sink := newUsageGateway(t, keyauth.Config{}, nil)
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "t", Priority: 1,
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	body := `{"model":"gpt-test","messages":[]}`
	cases := []struct {
		name    string
		headers map[string]string
		want    string
	}{
		// 从右往左第 1 跳 = 最右边的条目。
		{"XFF 右起第 1 跳", map[string]string{"X-Forwarded-For": "198.51.100.7, 203.0.113.9"}, "203.0.113.9"},
		{"X-Real-IP", map[string]string{"X-Real-IP": "198.51.100.8"}, "198.51.100.8"},
		{"RemoteAddr 回退", map[string]string{}, "192.0.2.1"},
		{"XFF 不合法时回退", map[string]string{
			"X-Forwarded-For": `198.51.100.7<script>`,
			"X-Real-IP":       "198.51.100.9",
		}, "198.51.100.9"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := postWithHeaders(t, world.handler, "/v1/chat/completions", body, tc.headers)
			if recorder.Code != http.StatusOK {
				t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
			}
			records := sink.all(t)
			record := records[len(records)-1]
			if record.ClientIP != tc.want {
				t.Fatalf("clientIp = %q，期望 %q", record.ClientIP, tc.want)
			}
		})
	}
}

func TestTrustedProxyHopsTwo(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"c1","model":"gpt-test","choices":[]}`)
	}))
	defer upstream.Close()

	world, sink := newUsageGateway(t, keyauth.Config{}, func(config *Config) {
		config.TrustedProxyHops = 2
	})
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "t", Priority: 1,
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postWithHeaders(t, world.handler, "/v1/chat/completions",
		`{"model":"gpt-test","messages":[]}`,
		map[string]string{"X-Forwarded-For": "198.51.100.7, 203.0.113.9"})
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d", recorder.Code)
	}
	if record := sink.single(t); record.ClientIP != "198.51.100.7" {
		t.Fatalf("clientIp = %q，期望 198.51.100.7", record.ClientIP)
	}
}

func TestUnauthorizedIsNotRecorded(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("未鉴权的请求不应到达上游")
	}))
	defer upstream.Close()

	world, sink := newUsageGateway(t, keyauth.Config{Keys: []string{"right-key"}}, nil)
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "t", Priority: 1,
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postWithHeaders(t, world.handler, "/v1/chat/completions",
		`{"model":"gpt-test","messages":[]}`,
		map[string]string{"Authorization": "Bearer wrong-key"})
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("期望 401，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if records := sink.all(t); len(records) != 0 {
		t.Fatalf("401 不应记录用量，得到 %d 条", len(records))
	}
}

func TestRecordStreamUsageFlag(t *testing.T) {
	const requestBody = "{\"stream\":true, \"model\":\"gpt-test\",  \"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
	const sse = "data: {\"id\":\"c1\",\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\n" +
		"data: {\"id\":\"c1\",\"model\":\"gpt-test\",\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n" +
		"data: [DONE]\n\n"

	t.Run("关闭时不改一个字节", func(t *testing.T) {
		var received []byte
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			received, _ = io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, sse)
		}))
		defer upstream.Close()

		world, sink := newUsageGateway(t, keyauth.Config{}, func(config *Config) {
			config.RecordStreamUsage = false
		})
		if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
			AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "t", Priority: 1,
		})); err != nil {
			t.Fatalf("Replace: %v", err)
		}

		recorder := postWithHeaders(t, world.handler, "/v1/chat/completions", requestBody, nil)
		if recorder.Code != http.StatusOK {
			t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
		}
		if !bytes.Equal(received, []byte(requestBody)) {
			t.Fatalf("关闭 include_usage 注入后请求体被改写：\n得到 %s\n期望 %s", received, requestBody)
		}
		if recorder.Body.String() != sse {
			t.Fatal("流式响应必须原样透传")
		}
		if record := sink.single(t); !record.UsagePresent || record.InputTokens != 10 || record.OutputTokens != 5 {
			t.Fatalf("用量记录不符：%+v", record)
		}
	})

	t.Run("开启时补 include_usage", func(t *testing.T) {
		var received []byte
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			received, _ = io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, sse)
		}))
		defer upstream.Close()

		world, sink := newUsageGateway(t, keyauth.Config{}, nil)
		if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
			AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "t", Priority: 1,
		})); err != nil {
			t.Fatalf("Replace: %v", err)
		}

		recorder := postWithHeaders(t, world.handler, "/v1/chat/completions", requestBody, nil)
		if recorder.Code != http.StatusOK {
			t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
		}

		var sent map[string]any
		if err := json.Unmarshal(received, &sent); err != nil {
			t.Fatalf("上游收到的不是 JSON：%v：%s", err, received)
		}
		options, _ := sent["stream_options"].(map[string]any)
		if options == nil || options["include_usage"] != true {
			t.Fatalf("上游没有收到 stream_options.include_usage=true：%s", received)
		}
		if sent["model"] != "gpt-test" {
			t.Fatalf("其它字段没有保持：%s", received)
		}
		if record := sink.single(t); !record.UsagePresent || !record.UsageComplete || record.TotalTokens != 15 {
			t.Fatalf("用量记录不符：%+v", record)
		}
	})
}

func TestStreamUsageAnthropicMergesEventsAfterStreamEnds(t *testing.T) {
	const sse = "event: message_start\n" +
		"data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-3\",\"usage\":{\"input_tokens\":100,\"output_tokens\":1,\"cache_creation_input_tokens\":5,\"cache_read_input_tokens\":20}}}\n\n" +
		"event: content_block_delta\n" +
		"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n" +
		"event: message_delta\n" +
		"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":50}}\n\n" +
		"event: message_stop\n" +
		"data: {\"type\":\"message_stop\"}\n\n"

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, sse)
	}))
	defer upstream.Close()

	world, sink := newUsageGateway(t, keyauth.Config{}, nil)
	if _, err := world.accounts.Replace(snapshot(upstream.URL+"/v1", accounts.Account{
		AccountID: "acc-1", Provider: "anthropic", Kind: "api_key", Token: "t",
		Protocol: "anthropic", Priority: 1,
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	recorder := postWithHeaders(t, world.handler, "/v1/messages",
		`{"model":"claude-3","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"hi"}]}`, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.String() != sse {
		t.Fatal("流式响应必须原样透传")
	}

	record := sink.single(t)
	if !record.UsagePresent || !record.UsageComplete || !record.Stream {
		t.Fatalf("流式用量标记不符：%+v", record)
	}
	// Anthropic 的 input 不含缓存；两个事件的字段按 max 合并。
	if record.InputTokens != 100 || record.OutputTokens != 50 {
		t.Fatalf("input/output 合并错误：%+v", record)
	}
	if record.CacheReadTokens != 20 || record.CacheWriteTokens != 5 {
		t.Fatalf("缓存桶丢失：%+v", record)
	}
	if record.TotalTokens != 175 || record.Protocol != contracts.ProtocolAnthropic || record.UpstreamProtocol != contracts.ProtocolAnthropic {
		t.Fatalf("记录不符：%+v", record)
	}
}

// 确保动态 key 快照下的用户字段也能落进记录。
func TestUsageRecordCarriesDynamicKeyIdentity(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"c1","model":"gpt-test","choices":[]}`)
	}))
	defer upstream.Close()

	keyCache := apikeys.New()
	world, sink := newUsageGateway(t, keyauth.Config{Verifier: keyCache}, nil)
	if _, err := world.accounts.Replace(snapshot(upstream.URL, accounts.Account{
		AccountID: "acc-1", Provider: "openai", Kind: "api_key", Token: "t", Priority: 1,
	})); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	// 动态快照：只认 sha256 哈希。
	sum := sha256.Sum256([]byte("dynamic-key"))
	if _, err := keyCache.Replace(apikeys.Snapshot{
		Version: apikeys.SnapshotVersion,
		Keys: []apikeys.Key{{
			KeyID: "key-1", UserID: 42, KeyHash: hex.EncodeToString(sum[:]), Name: "生产 key", Profile: "billed",
		}},
	}); err != nil {
		t.Fatalf("keys Replace: %v", err)
	}

	recorder := postWithHeaders(t, world.handler, "/v1/chat/completions",
		`{"model":"gpt-test","messages":[]}`,
		map[string]string{"Authorization": "Bearer dynamic-key"})
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	record := sink.single(t)
	if record.UserID != "42" || record.KeyID != "key-1" || record.KeyName != "生产 key" || record.Profile != "billed" {
		t.Fatalf("动态 key 身份没有进记录：%+v", record)
	}
}
