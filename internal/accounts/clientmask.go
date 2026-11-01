package accounts

import (
	"strings"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// 客户端指纹档案（client mask）在「装载」这一侧的校验。
//
// 为什么在 Go 里还要再校验一遍（TS 的 client-mask 插件已经校验过了）：
// **不能只信推过来的东西**。桥帧的另一端可能是旧版本、手工拼的测试帧、或者哪天 TS 侧的校验
// 被改松了；这些头会原样贴到发往上游的请求上，一个换行就是 HTTP 头注入。
// 与既有口径一致：**任何一条不合法 → 整份快照拒绝**，绝不部分应用。

// validateClientMask 校验一个账号的客户端指纹头与 UA。
func validateClientMask(accountID string, headers []contracts.AccountHeader, userAgent string) error {
	if len(headers) > contracts.MaxClientHeaders {
		return newError("ACCOUNTS_INVALID_ACCOUNT",
			"账号 %s 的 clientHeaders 最多 %d 个，收到 %d 个",
			accountID, contracts.MaxClientHeaders, len(headers))
	}
	if len(userAgent) > contracts.MaxClientUserAgentBytes {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 clientUserAgent 过长", accountID)
	}
	if hasControlCharacter(userAgent) {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 clientUserAgent 含控制字符", accountID)
	}

	seen := make(map[string]struct{}, len(headers))
	for _, header := range headers {
		name := strings.TrimSpace(header.Name)
		if name == "" {
			return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 clientHeaders 里有空头名", accountID)
		}
		if len(name) > contracts.MaxClientHeaderNameBytes {
			return newError("ACCOUNTS_INVALID_ACCOUNT",
				"账号 %s 的 clientHeaders 头名过长：%s", accountID, name)
		}
		if !isHeaderToken(name) {
			return newError("ACCOUNTS_INVALID_ACCOUNT",
				"账号 %s 的 clientHeaders 头名不合法：%q", accountID, name)
		}
		// 受保护头在装载阶段就拒：这些位置只由网关自己写（见 contracts/clientmask.go 的注释）。
		if contracts.IsProtectedRequestHeader(name) {
			return newError("ACCOUNTS_INVALID_ACCOUNT",
				"账号 %s 的 clientHeaders 试图覆盖受保护的头：%s（受保护：%s）",
				accountID, name, strings.Join(contracts.ProtectedRequestHeaderNames(), " / "))
		}
		lower := strings.ToLower(name)
		if _, duplicated := seen[lower]; duplicated {
			return newError("ACCOUNTS_INVALID_ACCOUNT",
				"账号 %s 的 clientHeaders 里 %s 重复声明", accountID, name)
		}
		seen[lower] = struct{}{}

		if len(header.Value) > contracts.MaxClientHeaderValueBytes {
			return newError("ACCOUNTS_INVALID_ACCOUNT",
				"账号 %s 的 clientHeaders 头值过长：%s", accountID, name)
		}
		// 换行 / NUL 就是头注入；其它控制字符也没有正当用途。
		if hasControlCharacter(header.Value) {
			return newError("ACCOUNTS_INVALID_ACCOUNT",
				"账号 %s 的 clientHeaders 头值含控制字符：%s", accountID, name)
		}
		if err := validateHeaderTemplate(accountID, name, header.Value); err != nil {
			return err
		}
	}
	return nil
}

// validateHeaderTemplate 只允许三个占位符，其余 `{{...}}` 一律拒绝。
//
// 为什么不能放行任意 `{{...}}`：将来有人给模板加一个 `{{token}}`，它就会在这里
// 悄悄变成「从上下文取令牌填进去」的位置 —— 秘密的出口必须只有一处，不能靠模板机制开口子。
func validateHeaderTemplate(accountID, name, value string) error {
	rest := value
	for _, placeholder := range []string{
		contracts.PlaceholderUUID,
		contracts.PlaceholderSession,
		contracts.PlaceholderTimestamp,
	} {
		rest = strings.ReplaceAll(rest, placeholder, "")
	}
	if strings.Contains(rest, "{{") || strings.Contains(rest, "}}") {
		return newError("ACCOUNTS_INVALID_ACCOUNT",
			"账号 %s 的 %s 头值里有不认识的占位符（只允许 %s / %s / %s）",
			accountID, name, contracts.PlaceholderUUID, contracts.PlaceholderSession, contracts.PlaceholderTimestamp)
	}
	return nil
}

// isHeaderToken 判断头名是否符合 RFC 7230 的 token 规则。
func isHeaderToken(name string) bool {
	for i := 0; i < len(name); i++ {
		if !isTokenChar(name[i]) {
			return false
		}
	}
	return len(name) > 0
}

func isTokenChar(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	switch c {
	case '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~':
		return true
	}
	return false
}

// hasControlCharacter 判断是否含 C0 控制字符或 DEL。
func hasControlCharacter(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] < 0x20 || value[i] == 0x7f {
			return true
		}
	}
	return false
}

// cloneAccountHeaders 复制一份（快照是不可变的：调用方拿到的切片不能和缓存共享底层数组）。
func cloneAccountHeaders(headers []contracts.AccountHeader) []contracts.AccountHeader {
	if len(headers) == 0 {
		return nil
	}
	out := make([]contracts.AccountHeader, len(headers))
	copy(out, headers)
	return out
}
