## 错误体形状（按客户端协议不同）

出处：`contracts/protocol.go` 的 `RenderError`。三种形状都是「先不坏官方形状，网关稳定码只做纯增量」：
Anthropic 的 `code`、Gemini 的 `reason` 都是超集字段，空码时整键不输出。

| 适用协议 | 形状 | 键 | 说明 |
| --- | --- | --- | --- |
| 默认 / `openai-chat` / `openai-responses` | `{"error": {"message", "type", "code"}}` | error, message, type, code | `code` 是网关稳定码（如 `ALL_ACCOUNTS_SATURATED`）；`type` 按 HTTP 状态映射（`invalid_request_error` / `authentication_error` / `rate_limit_error` / `server_error`）。 |
| `anthropic` | `{"type": "error", "error": {"type", "message", "code"}}` | type, error, message, code | 官方 schema 只有 `type` / `message`；`code` 是**纯增量**（空码不输出该键），老客户端看到的形状不变。 |
| `gemini` | `{"error": {"code": 503, "message": "...", "status": "UNAVAILABLE", "reason": "..."}}` | error, code, message, status, reason | 官方 schema：`code` 是**整数** HTTP 状态（不是字符串码）、`status` 是 Google 枚举名（`INVALID_ARGUMENT` / `UNAUTHENTICATED` / `RESOURCE_EXHAUSTED` / `UNAVAILABLE` / `INTERNAL` 等）；网关稳定码放在**纯增量**的 `reason` 里（空码不输出该键）。 |

## 错误码（LLM 入口）

下面这张表**是从 Go 源码读出来的**（三种构造都扫：`contracts.Errorf(http.StatusXxx, "CODE", "说明")`、
`writeErrorFor(…, http.StatusXxx, "CODE", "说明")`、`&contracts.StageError{Status: …, Code: …}`）。
状态码、说明、出处全部来自代码——**新增错误码会自动出现在这里**，不会腐烂。

<!-- facts:gateway-errors -->

## 错误码（产品接口 /api/*）

控制面接口的错误码，同一套 `{error: {code, message, requestId}}` 信封。
这张表**也是从代码读出来的**：`packages/api/src/errors.ts` 的 `ApiErrorCode` 联合、
`EXPLICIT_STATUS` 显式状态表、`statusOfCode()` 的后缀兜底规则，加上各插件的
`new ApiError('CODE', 状态码, '消息')` 字面量。产品面的消息多数是运行时拼的，
所以「说明」只填代码里写死的字面量，读不到就显示 `—`（不编）；「出处」是定义该码的文件。

<!-- facts:product-errors -->

## 流式终止符（按协议不同）

| 协议 | 终止符 |
| --- | --- |
| `openai-chat` | 帧形如 `data: {...}`，**最后发 `data: [DONE]`**；遇到 `[DONE]` 就结束读取。 |
| `openai-responses` | 事件流以 `response.completed`（或 `response.incomplete` / `response.failed`）结束，**网关不发 `data: [DONE]`**（上游真发了也只会被当普通帧吞掉，不会转发给客户端）。 |
| `anthropic` | 每帧是 `event: <类型>` + `data: {...}` 两行；终止符是 `message_stop`，同样**不发 `[DONE]`**。 |
| `gemini` | 流式端点必须带 `alt=sse`；每帧只有 `data: {...}`（完整的 `GenerateContentResponse`，累计形态），**不发 `data: [DONE]`**，以最后一帧 candidate 的 `finishReason` 作为结束信号。 |

## 有损转换

- `thinking.signature` 不回传（跨协议时无法表达）。
- `cache_control` 在跨协议时会被丢弃。
- OpenAI 专有采样参数（如 `logit_bias`）转 Anthropic 时丢弃。
- Anthropic 的 `max_tokens` 必填：客户端没给时网关补默认值。
- Gemini 的 `generationConfig.candidateCount > 1` 明确拒绝（网关只承载单候选）。
- Gemini 的 `thoughtsTokenCount` 记入思考 token，**不重复**计入输出 token。
- 模型映射只改**请求**里的模型名：响应里的 `model` 保持上游原名。
