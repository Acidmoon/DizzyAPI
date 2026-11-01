package transport

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// 客户端指纹（client mask）：把账号挂的档案头贴到上游请求上。
//
// 这一层只做三件事：**展开模板、跳过受保护的头、写上去**。档案本身（有哪些头）来自
// TS 的 client-mask 插件，经账号快照推进来。
//
// 三条硬约束：
//  1. **鉴权头与内容协商头永远不被覆盖**（`contracts.IsProtectedRequestHeader`）。这既是
//     安全边界（档案能改 `Authorization` 就等于顶掉账号令牌），也是正确性边界（`Accept`
//     一改，流式就废了）；
//  2. **不产生任何日志与错误信息里的头值**：值可能带会话 id，日志里没有它的位置；
//  3. **模板展开失败不影响请求**：算不出 `{{session}}` 就退化成「按账号稳定」的值，
//     而不是让这一条请求失败（伪装是增强，不是前置依赖）。

// clientMaskVars 是模板展开需要的东西。显式传进来（而不是全局取）：
// 单元测试要能控制时间与随机源。
type clientMaskVars struct {
	accountID string
	// body 是**即将发往上游**的请求字节（可能已被 protoconv 改写）。
	body []byte
	now  func() time.Time
	// uuid 生成器；nil 时用 crypto/rand 的 v4。
	uuid func() string
}

// applyClientMask 把档案头贴到请求上；UA 有值时覆盖网关默认 UA。
//
// 空档案（没挂 / 档案被禁用 / 插件没装）时它什么都不做 —— 调用方不需要判空。
func applyClientMask(request *http.Request, userAgent string, headers []contracts.AccountHeader, vars clientMaskVars) {
	if strings.TrimSpace(userAgent) != "" {
		// 档案声明的 UA 优先（这正是「伪装成某个客户端」的核心一步）。
		request.Header.Set("User-Agent", userAgent)
	}
	if len(headers) == 0 {
		return
	}
	if vars.now == nil {
		vars.now = time.Now
	}
	// `{{session}}` 每个请求只算一次：一个档案里可以有多个头引用它，必须同值。
	session := ""
	sessionReady := false
	for _, header := range headers {
		name := strings.TrimSpace(header.Name)
		if name == "" {
			continue
		}
		// 防御性再挡一次：装载阶段已经拒过受保护头，这里不依赖上游校验。
		if contracts.IsProtectedRequestHeader(name) {
			continue
		}
		if !sessionReady {
			session = sessionIDFor(vars.accountID, vars.body)
			sessionReady = true
		}
		request.Header.Set(name, expandClientHeaderValue(header.Value, vars, session))
	}
}

// expandClientHeaderValue 展开三种占位符；其它内容原样保留。
//
// 没被允许的 `{{...}}` 在装载阶段就被拒了，所以这里**不需要**再报错：
// 遇到不认识的占位符就当普通文本留着（宁可多带一段字面量，也不要让请求失败）。
func expandClientHeaderValue(value string, vars clientMaskVars, session string) string {
	if value == "" {
		return ""
	}
	expanded := value
	if strings.Contains(expanded, contracts.PlaceholderSession) {
		expanded = strings.ReplaceAll(expanded, contracts.PlaceholderSession, session)
	}
	if strings.Contains(expanded, contracts.PlaceholderTimestamp) {
		timestamp := strconv.FormatInt(vars.now().UnixMilli(), 10)
		expanded = strings.ReplaceAll(expanded, contracts.PlaceholderTimestamp, timestamp)
	}
	if strings.Contains(expanded, contracts.PlaceholderUUID) {
		uuid := ""
		if vars.uuid != nil {
			uuid = vars.uuid()
		} else {
			uuid = newUUIDv4()
		}
		expanded = strings.ReplaceAll(expanded, contracts.PlaceholderUUID, uuid)
	}
	return expanded
}

// sessionIDFor 算「稳定会话 id」：账号 + 首条用户消息。
//
// 为什么不是完全随机：opencode 那类上游要的是**会话亲和**（同一段对话路由到同一个会话），
// 随机值每次请求都不认。为什么不是整份请求体的哈希：对话越聊越长，体哈希每轮都变，亲和就断了。
// 所以取「首条 user 消息」——同一段对话里它不变。
//
// 拿不到用户文本时（不认识的协议 / 空体 / 不是 JSON）退化成「按账号稳定」：
// 仍然稳定，只是亲和粒度变成「这个账号的所有对话」。这比随机值有用，也比失败好。
func sessionIDFor(accountID string, body []byte) string {
	digest := sha256.New()
	digest.Write([]byte(accountID))
	digest.Write([]byte{0})
	digest.Write([]byte(firstUserText(body)))
	return hex.EncodeToString(digest.Sum(nil))[:32]
}

// firstUserText 从（上游协议形态的）请求体里取首条用户消息的文本。
//
// 四个入口协议的形状不同，但都落在三个键上：
//   - OpenAI chat / Anthropic：`messages[]`，元素 `{role, content}`（content 可以是字符串或分段数组）
//   - Gemini：`contents[]`，元素 `{role, parts[]}`（`parts[].text`）
//   - OpenAI responses：`input[]`，元素 `{role, content[]}`（`content[].text` / `input_text`）
//
// 解析失败一律返回空串（调用方退化成按账号稳定），**不报错**：伪装不该让请求失败。
func firstUserText(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	root, ok := payload.(map[string]any)
	if !ok {
		return ""
	}
	for _, key := range []string{"messages", "contents", "input"} {
		list, ok := root[key].([]any)
		if !ok {
			continue
		}
		for _, item := range list {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if !isUserRole(entry["role"]) {
				continue
			}
			if text := textOfEntry(entry); text != "" {
				return text
			}
		}
	}
	return ""
}

func isUserRole(value any) bool {
	role, ok := value.(string)
	if !ok {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "user", "human":
		return true
	default:
		return false
	}
}

// textOfEntry 从一个消息对象里取文本：`content`（字符串 / 分段数组）或 `parts`（分段数组）。
func textOfEntry(entry map[string]any) string {
	if text, ok := entry["content"].(string); ok && text != "" {
		return text
	}
	for _, key := range []string{"content", "parts"} {
		parts, ok := entry[key].([]any)
		if !ok {
			continue
		}
		for _, part := range parts {
			segment, ok := part.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := segment["text"].(string); ok && text != "" {
				return text
			}
		}
	}
	return ""
}

// newUUIDv4 生成 RFC 4122 v4 UUID。crypto/rand 失败时返回全零形状的值 —— 不可能发生，
// 而且返回错误比返回一个「不唯一」的值更糟：伪装头带个坏值不该让请求挂掉。
func newUUIDv4() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	buf[6] = (buf[6] & 0x0f) | 0x40 // version 4
	buf[8] = (buf[8] & 0x3f) | 0x80 // variant 10
	hexed := hex.EncodeToString(buf[:])
	return hexed[0:8] + "-" + hexed[8:12] + "-" + hexed[12:16] + "-" + hexed[16:20] + "-" + hexed[20:32]
}
