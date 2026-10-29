// 假上游：一个最小的 OpenAI 兼容服务端，用来验证 dizzy 真的打通了网关。
//
// 它不是测试用例的一部分（用例不 mock 网络），而是**手工端到端实测**用的夹具：
// 起真 gatewayd + 真桥推账号快照 + 这个假上游，然后用 dizzy 打一条真请求。
//
// 用法：go run ./cmd/dizzy/testdata/fake-upstream -addr 127.0.0.1:18081
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:18081", "监听地址（回环）")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/chat/completions", handleChat)
	mux.HandleFunc("/v1/models", handleModels)

	server := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	logger := log.New(os.Stderr, "fake-upstream: ", 0)
	logger.Printf("listening on %s", *addr)
	if err := server.ListenAndServe(); err != nil {
		logger.Fatal(err)
	}
}

// chatRequest 是假上游关心的那几个字段。
type chatRequest struct {
	Model    string `json:"model"`
	Stream   bool   `json:"stream"`
	Messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
	StreamOptions *struct {
		IncludeUsage bool `json:"include_usage"`
	} `json:"stream_options"`
}

func handleChat(w http.ResponseWriter, r *http.Request) {
	var request chatRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, `{"error":{"message":"bad json"}}`, http.StatusBadRequest)
		return
	}

	lastUser := ""
	for _, message := range request.Messages {
		if message.Role == "user" {
			lastUser = message.Content
		}
	}
	answer := "假的模型回复：收到 " + fmt.Sprintf("%q", lastUser)

	if request.Stream {
		writeStream(w, request, answer)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id":      "chatcmpl-fake-1",
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   request.Model,
		"choices": []any{map[string]any{
			"index":         0,
			"message":       map[string]any{"role": "assistant", "content": answer},
			"finish_reason": "stop",
		}},
		// 固定用量：输入 100（其中缓存命中 20）、输出 50。
		"usage": map[string]any{
			"prompt_tokens":     100,
			"completion_tokens": 50,
			"total_tokens":      150,
			"prompt_tokens_details": map[string]any{
				"cached_tokens": 20,
			},
		},
	})
}

// writeStream 按 OpenAI SSE 形状发流，最后带 usage 帧。
func writeStream(w http.ResponseWriter, request chatRequest, answer string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, _ := w.(http.Flusher)

	send := func(payload any) {
		raw, _ := json.Marshal(payload)
		fmt.Fprintf(w, "data: %s\n\n", raw)
		if flusher != nil {
			flusher.Flush()
		}
	}

	// 把回复拆成几块发，验证 dizzy 会逐块打印。
	for _, piece := range splitRunes(answer, 4) {
		send(map[string]any{
			"id":      "chatcmpl-fake-stream",
			"object":  "chat.completion.chunk",
			"created": time.Now().Unix(),
			"model":   request.Model,
			"choices": []any{map[string]any{
				"index": 0,
				"delta": map[string]any{"content": piece},
			}},
		})
	}
	send(map[string]any{
		"id":      "chatcmpl-fake-stream",
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   request.Model,
		"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"}},
	})
	// 只有客户端要求 include_usage 时才发 usage 帧（与真实 OpenAI 一致）。
	if request.StreamOptions != nil && request.StreamOptions.IncludeUsage {
		send(map[string]any{
			"id":      "chatcmpl-fake-stream",
			"object":  "chat.completion.chunk",
			"created": time.Now().Unix(),
			"model":   request.Model,
			"choices": []any{},
			"usage": map[string]any{
				"prompt_tokens":     100,
				"completion_tokens": 50,
				"total_tokens":      150,
				"prompt_tokens_details": map[string]any{
					"cached_tokens": 20,
				},
			},
		})
	}
	fmt.Fprint(w, "data: [DONE]\n\n")
	if flusher != nil {
		flusher.Flush()
	}
}

func handleModels(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"object": "list",
		"data": []any{
			map[string]any{"id": "fake-model", "object": "model", "owned_by": "fake"},
		},
	})
}

// splitRunes 把字符串按固定长度切开（按 rune，不切断多字节字符）。
func splitRunes(text string, size int) []string {
	runes := []rune(text)
	pieces := []string{}
	for start := 0; start < len(runes); start += size {
		end := start + size
		if end > len(runes) {
			end = len(runes)
		}
		pieces = append(pieces, string(runes[start:end]))
	}
	if len(pieces) == 0 {
		pieces = append(pieces, strings.TrimSpace(text))
	}
	return pieces
}
