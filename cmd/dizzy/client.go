package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// API 请求头名与取值。api 插件对**所有** /api/* 请求（含 GET）都要求这个头，
// 缺了就是 403 API_REQUEST_HEADER_REQUIRED
// （packages/api/src/http.ts:279）。
const (
	apiRequestHeaderName  = "X-Requested-With"
	apiRequestHeaderValue = "dizzyapi"
)

// requestIDHeaderName 是网关回写请求 id 的响应头。
//
// 它由 Go 侧 `internal/httpapi` 产出，**本批还没有**（走独立分支）。CLI 只读：
// 有就用它做精确对账，没有就退回「按时间窗 + 最大 id 排除」的近似匹配，
// 绝不因为缺这个头而失败。
const requestIDHeaderName = "X-Request-Id"

// maxErrorBodyBytes 是错误响应体最多读多少字节。
//
// 上游可能回一个巨大的 HTML 错误页；只读头部足够定位问题，也不会把
// 整个响应灌进内存。
const maxErrorBodyBytes = 8 << 10

// Client 是 CLI 的 HTTP 客户端。
//
// 两条鉴权路径**分开**处理，不混用：
//   - `/v1/*`：Bearer key（apiKey 非空才带）；
//   - `/api/*`：**每个**请求都要带 `X-Requested-With: dizzyapi`（登录前也要），
//     有会话时再带 HttpOnly cookie。
//
// 这三样都不进日志、不进 URL。
type Client struct {
	baseURL      *url.URL
	http         *http.Client
	apiKey       string
	sessionToken string
	// apiHeader 为真时每个请求都带 X-Requested-With（/api/* 必须）。
	//
	// 它与 sessionToken **独立**：登录、健康检查这些「还没有会话」的 /api/*
	// 请求同样必须带这个头，否则网关直接 403 API_REQUEST_HEADER_REQUIRED
	// （packages/api/src/http.ts:279）。
	apiHeader bool
	verbose   bool
	log       func(format string, args ...any)
}

// ClientOptions 是构造 Client 的参数。
type ClientOptions struct {
	// BaseURL 是入口地址（必填）。
	BaseURL string
	// Timeout 是单次请求超时；<=0 用默认值。
	Timeout time.Duration
	// APIKey 是 Bearer key；空 = 不带。
	APIKey string
	// SessionToken 是会话 token；空 = 不带 cookie。
	SessionToken string
	// APIRequestHeader 为真时带 X-Requested-With（访问 /api/* 必须为真）。
	APIRequestHeader bool
	// Verbose 为真时把请求概要打到 stderr（**不含任何秘密**）。
	Verbose bool
	// Log 是 verbose 日志的出口；为 nil 时丢弃。
	Log func(format string, args ...any)
}

// NewClient 构造客户端。BaseURL 非法时明确失败，不静默降级。
func NewClient(options ClientOptions) (*Client, error) {
	parsed, err := parseBaseURL(options.BaseURL)
	if err != nil {
		return nil, fmt.Errorf("%w：入口地址 %q 不合法：%v", ErrConfigInvalid, options.BaseURL, err)
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = time.Duration(defaultTimeoutSeconds) * time.Second
	}
	log := options.Log
	if log == nil {
		log = func(string, ...any) {}
	}
	return &Client{
		baseURL:      parsed,
		http:         &http.Client{Timeout: timeout},
		apiKey:       options.APIKey,
		sessionToken: options.SessionToken,
		apiHeader:    options.APIRequestHeader,
		verbose:      options.Verbose,
		log:          log,
	}, nil
}

// URL 拼出入口下的完整地址。
func (c *Client) URL(path string, query url.Values) string {
	target := *c.baseURL
	target.Path = c.baseURL.Path + path
	if len(query) > 0 {
		target.RawQuery = query.Encode()
	} else {
		target.RawQuery = ""
	}
	return target.String()
}

// Request 是一次 HTTP 调用的描述。
type Request struct {
	Method string
	Path   string
	Query  url.Values
	// Body 是 JSON 请求体；nil = 不带 body。
	Body any
	// RawBody 是原始请求体；与 Body 互斥（RawBody 优先）。
	RawBody []byte
	// ContentType 是原始请求体的类型；默认 application/json。
	ContentType string
	// Accept 是 Accept 头；默认 application/json。
	Accept string
	// Stream 为真时返回流式响应体（调用方负责读）。
	Stream bool
	// CaptureCookie 是要捕获的 cookie 名。响应里的 Set-Cookie 命中它时，
	// 值写进 Response.Cookie。
	//
	// 会话 cookie 是 HttpOnly 的，**只在响应头里**，不进 JSON 体
	// （packages/api/src/http.ts:2677）。所以登录必须捕获它。
	CaptureCookie string
}

// Response 是一次 HTTP 调用的结果。
type Response struct {
	Status int
	Header http.Header
	Body   []byte
	// Stream 非 nil 时是流式响应体，调用方读完必须 Close。
	Stream io.ReadCloser
	// Cookie 是捕获到的 cookie 值（见 Request.CaptureCookie）。
	Cookie string
	// RequestID 是响应头 X-Request-Id 的值（服务端没发就是空串）。
	//
	// 它是「这一条用量记录」的权威标识：有它就能直接对上 /api/usage 的
	// reqId，不必猜「哪条才是刚打的那次」。
	RequestID string
}

// Do 发一次请求。**不**在出错时把响应体吞掉：错误响应会转成 APIError。
func (c *Client) Do(request Request) (*Response, error) {
	var payload []byte
	contentType := request.ContentType
	switch {
	case request.RawBody != nil:
		payload = request.RawBody
	case request.Body != nil:
		encoded, err := json.Marshal(request.Body)
		if err != nil {
			return nil, fmt.Errorf("序列化请求体失败：%w", err)
		}
		payload = encoded
	}
	if payload != nil && contentType == "" {
		contentType = "application/json"
	}

	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	httpRequest, err := http.NewRequest(request.Method, c.URL(request.Path, request.Query), reader)
	if err != nil {
		return nil, fmt.Errorf("构造请求失败：%w", err)
	}
	if payload != nil {
		httpRequest.ContentLength = int64(len(payload))
	}
	accept := request.Accept
	if accept == "" {
		accept = "application/json"
	}
	httpRequest.Header.Set("Accept", accept)
	if contentType != "" {
		httpRequest.Header.Set("Content-Type", contentType)
	}

	// 两条鉴权路径：Bearer 与会话 cookie + 自定义头。
	if c.apiKey != "" {
		httpRequest.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	// X-Requested-With 是 /api/* 的**无条件要求**（登录前也要），与有没有会话无关。
	if c.apiHeader {
		httpRequest.Header.Set(apiRequestHeaderName, apiRequestHeaderValue)
	}
	if c.sessionToken != "" {
		httpRequest.AddCookie(&http.Cookie{Name: sessionCookieName, Value: c.sessionToken})
	}

	if c.verbose {
		// 只打方法与路径：**不打 key、不打 cookie**。
		c.log("%s %s", request.Method, c.URL(request.Path, request.Query))
	}

	httpResponse, err := c.http.Do(httpRequest)
	if err != nil {
		return nil, fmt.Errorf("请求 %s %s 失败：%w", request.Method, request.Path, err)
	}

	if httpResponse.StatusCode >= 400 {
		defer httpResponse.Body.Close()
		return nil, newAPIError(httpResponse)
	}

	if request.Stream {
		return &Response{
			Status:    httpResponse.StatusCode,
			Header:    httpResponse.Header,
			Stream:    httpResponse.Body,
			Cookie:    captureCookie(httpResponse, request.CaptureCookie),
			RequestID: strings.TrimSpace(httpResponse.Header.Get(requestIDHeaderName)),
		}, nil
	}
	defer httpResponse.Body.Close()
	body, err := io.ReadAll(httpResponse.Body)
	if err != nil {
		return nil, fmt.Errorf("读取响应体失败：%w", err)
	}
	return &Response{
		Status:    httpResponse.StatusCode,
		Header:    httpResponse.Header,
		Body:      body,
		Cookie:    captureCookie(httpResponse, request.CaptureCookie),
		RequestID: strings.TrimSpace(httpResponse.Header.Get(requestIDHeaderName)),
	}, nil
}

// captureCookie 从响应里取指定 cookie 的值。
//
// 会话 cookie 是 HttpOnly 的，只在 Set-Cookie 头里（不进 JSON 体）。
// 取不到就是空字符串（不是错误）：调用方自己判断「有没有登录上」。
func captureCookie(response *http.Response, name string) string {
	if name == "" {
		return ""
	}
	for _, cookie := range response.Cookies() {
		if cookie.Name == name {
			return cookie.Value
		}
	}
	return ""
}

// sessionCookieName 是 api 插件的会话 cookie 名（默认 dizzyapi_session，
// 见 packages/api/src/config.ts:44）。
const sessionCookieName = "dizzyapi_session"

// DoJSON 发一次请求并把响应解析成 out。
func (c *Client) DoJSON(request Request, out any) error {
	response, err := c.Do(request)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if len(response.Body) == 0 {
		return nil
	}
	if err := json.Unmarshal(response.Body, out); err != nil {
		return fmt.Errorf("解析响应 JSON 失败：%w", err)
	}
	return nil
}

// APIError 是网关返回的错误。
//
// 网关的错误体有两种形状：
//   - /api/*：{"error":{"code","message","requestId"}}（packages/api/src/errors.ts）
//   - /v1/*：{"error":{"message","type","code"}}（contracts.RenderError）
//
// 两者都把稳定 code 放在 error.code，message 也都在 error.message，
// 所以一个解析器就能吃下两种形状。
type APIError struct {
	Status    int
	Code      string
	Message   string
	RequestID string
	Body      string
}

func (e *APIError) Error() string {
	code := e.Code
	if code == "" {
		code = "UNKNOWN"
	}
	message := e.Message
	if message == "" {
		message = "请求失败"
	}
	return fmt.Sprintf("%s（HTTP %d）：%s", code, e.Status, message)
}

// newAPIError 从错误响应里抽出稳定 code 与消息。
func newAPIError(response *http.Response) *APIError {
	raw, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBodyBytes))
	result := &APIError{Status: response.StatusCode, Body: string(raw)}

	var envelope struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"requestId"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &envelope); err == nil && envelope.Error.Message != "" {
		result.Code = envelope.Error.Code
		result.Message = envelope.Error.Message
		result.RequestID = envelope.Error.RequestID
		return result
	}
	// 不是标准信封：把原始响应截断后当作消息（可能是 HTML 错误页）。
	result.Message = strings.TrimSpace(truncate(string(raw), 512))
	return result
}

// truncate 截断字符串，标明被截断。
func truncate(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit] + "…（已截断）"
}

// ExitCode 返回 APIError 对应的退出码。
func (e *APIError) ExitCode() int {
	switch e.Status {
	case http.StatusUnauthorized:
		return exitUnauthorized
	case http.StatusForbidden:
		return exitForbidden
	case http.StatusNotFound:
		return exitNotFound
	case http.StatusPaymentRequired:
		return exitPaymentRequired
	case http.StatusTooManyRequests:
		return exitRateLimited
	}
	if e.Status >= 500 {
		return exitUpstream
	}
	if e.Status >= 400 {
		return exitUsage
	}
	return exitFailure
}

// 退出码。给 agent 判断成败用：不同原因给不同码，脚本才能分支。
const (
	exitSuccess         = 0
	exitFailure         = 1
	exitUsage           = 2
	exitNotLoggedIn     = 3
	exitUnauthorized    = 4
	exitForbidden       = 5
	exitNotFound        = 6
	exitPaymentRequired = 7
	exitRateLimited     = 8
	exitUpstream        = 9
)

// exitCodeOf 从错误里推出退出码。
func exitCodeOf(err error) int {
	if err == nil {
		return exitSuccess
	}
	var apiError *APIError
	if errors.As(err, &apiError) {
		return apiError.ExitCode()
	}
	if errors.Is(err, ErrCredentialsMissing) {
		return exitNotLoggedIn
	}
	return exitFailure
}

// scanLines 逐行读取流（用于 SSE）。
//
// 返回的 Scanner 缓冲区上限调到 1 MiB：SSE 帧可能很大（base64 图片那种）。
func scanLines(reader io.Reader) *bufio.Scanner {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
	return scanner
}
