package contracts

import (
	"sort"
	"strings"
)

// 客户端指纹（client mask）的共享约定。
//
// 为什么这几条放在 contracts 而不是放在某个模块里：
//   - `internal/accounts`（装载快照）与 `modules/transport`（发请求）**都要**判断
//     「这个头名能不能贴」，两处必须逐字一致 —— 一处严一处松，松的那处就是绕过口；
//   - `modules/*` 只允许 import `contracts/`（AGENTS.md §2.3），所以共享物只能在这里。
//
// 值本身（UA / 头值模板）不在这里展开：`{{session}}` 要用请求体算，只有 transport 知道。

const (
	// MaxClientHeaders 单个账号最多几个客户端指纹头。
	MaxClientHeaders = 24
	// MaxClientHeaderNameBytes 头名长度上限。
	MaxClientHeaderNameBytes = 128
	// MaxClientHeaderValueBytes 头值长度上限（模板算在内）。
	MaxClientHeaderValueBytes = 512
	// MaxClientUserAgentBytes UA 长度上限。
	MaxClientUserAgentBytes = 512
)

// 头值模板占位符：**只有这三个**，其余 `{{...}}` 一律非法。
const (
	PlaceholderUUID      = "{{uuid}}"
	PlaceholderSession   = "{{session}}"
	PlaceholderTimestamp = "{{timestamp}}"
)

// protectedRequestHeaders 是**客户端档案永远不许覆盖**的请求头。
//
// 理由分三类：
//   - 鉴权：`authorization` / `x-api-key` / `x-goog-api-key` —— 这几个位置只由网关自己写，
//     档案能改它们就等于把账号令牌的位置换成编造的值（或反过来泄露/顶掉令牌）；
//   - 内容协商：`content-type` / `accept` / `accept-encoding` / `content-length` /
//     `transfer-encoding` —— 由请求形态与上游协议决定，改了会毁掉流式与编解码；
//   - 身份绑定：`host`（TLS SNI 与 Host 必须一致）、`cookie` / `set-cookie`（会话凭据不是档案编造的）、
//     `user-agent`（UA 有专用字段，两处声明会打架）。
//
// 注意这里比较的是**小写头名**：HTTP 头名大小写不敏感，`Authorization` 与 `authorization` 是同一个头。
var protectedRequestHeaders = map[string]struct{}{
	"authorization":     {},
	"x-api-key":         {},
	"x-goog-api-key":    {},
	"content-type":      {},
	"content-length":    {},
	"accept":            {},
	"accept-encoding":   {},
	"transfer-encoding": {},
	"host":              {},
	"cookie":            {},
	"set-cookie":        {},
	"user-agent":        {},
}

// IsProtectedRequestHeader 判断一个头名是否属于「档案不许覆盖」的那一组。
//
// 空白与大小写都在这里归一：调用方只管把头名原样传进来。
func IsProtectedRequestHeader(name string) bool {
	_, blocked := protectedRequestHeaders[strings.ToLower(strings.TrimSpace(name))]
	return blocked
}

// ProtectedRequestHeaderNames 返回受保护头名的稳定副本（排障 / 错误信息用）。
func ProtectedRequestHeaderNames() []string {
	out := make([]string, 0, len(protectedRequestHeaders))
	for name := range protectedRequestHeaders {
		out = append(out, name)
	}
	// 固定顺序，避免错误信息与日志顺序漂移（map 遍历是随机的）。
	sort.Strings(out)
	return out
}
