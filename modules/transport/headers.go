package transport

import (
	"net/http"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// 上游请求的**头**是怎么写上去的：鉴权 → 客户端指纹（档案）。
//
// 从 `transport.go` 拆出来的原因：那个文件已超 §5.6 的 500 行上限（只许缩短），
// 而「哪些头能写、按什么顺序写」本身就是一件独立的事，值得单独看、单独审。
//
// 顺序是有意义的：**先鉴权，再贴档案**。档案想覆盖鉴权头时会被 `applyClientMask`
// 自己的保护名单挡掉（`contracts.IsProtectedRequestHeader`），而不是靠调用顺序侥幸。

// applyUpstreamHeaders 把鉴权头与客户端指纹头一起写到上游请求上。
func applyUpstreamHeaders(
	request *http.Request,
	dialect Dialect,
	credential contracts.AccountCredential,
	accountID string,
	body []byte,
) {
	applyAuth(request, dialect, credential.AccessToken)
	applyClientMask(request, credential.ClientUserAgent, credential.ClientHeaders, clientMaskVars{
		accountID: accountID,
		body:      body,
	})
}

// applyAuth 按方言写鉴权头。客户端的 Authorization 永不转发。
func applyAuth(request *http.Request, dialect Dialect, token string) {
	switch dialect.Auth {
	case AuthXAPIKey:
		request.Header.Set("x-api-key", token)
	case AuthXGoogAPIKey:
		request.Header.Set("x-goog-api-key", token)
	default:
		request.Header.Set("Authorization", "Bearer "+token)
	}
	for name, value := range dialect.ExtraHeaders {
		if value == "" {
			continue
		}
		request.Header.Set(name, value)
	}
}
