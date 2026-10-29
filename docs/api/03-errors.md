## 错误体形状（按客户端协议不同）

出处：`contracts/protocol.go` 的 `RenderError`。三种形状都是「先不坏官方形状，网关稳定码只做纯增量」：
Anthropic 的 `code`、Gemini 的 `reason` 都是超集字段，空码时整键不输出。

| 适用协议 | 形状 | 键 | 说明 |
| --- | --- | --- | --- |
| 默认 / `openai-chat` / `openai-responses` | `{"error": {"message", "type", "code"}}` | error, message, type, code | `code` 是网关稳定码（如 `ALL_ACCOUNTS_SATURATED`）；`type` 按 HTTP 状态映射（`invalid_request_error` / `authentication_error` / `rate_limit_error` / `server_error`）。 |
| `anthropic` | `{"type": "error", "error": {"type", "message", "code"}}` | type, error, message, code | 官方 schema 只有 `type` / `message`；`code` 是**纯增量**（空码不输出该键），老客户端看到的形状不变。 |
| `gemini` | `{"error": {"code": 503, "message": "...", "status": "UNAVAILABLE", "reason": "..."}}` | error, code, message, status, reason | 官方 schema：`code` 是**整数** HTTP 状态（不是字符串码）、`status` 是 Google 枚举名（`INVALID_ARGUMENT` / `UNAUTHENTICATED` / `RESOURCE_EXHAUSTED` / `UNAVAILABLE` / `INTERNAL` 等）；网关稳定码放在**纯增量**的 `reason` 里（空码不输出该键）。 |

## 错误码（LLM 入口）

出处：`contracts/` 与 `modules/` 下各包的 errors.go、`internal/engine/engine.go`、`internal/httpapi/server.go`、`modules/keyauth/module.go`。

| code | HTTP | 含义 | 出处 |
| --- | --- | --- | --- |
| `MISSING_API_KEY` | 401 | 没有带 `Authorization: Bearer <key>` | modules/keyauth/module.go |
| `INVALID_API_KEY` | 401 | API key 无效（不存在 / 已停用 / 哈希不匹配） | modules/keyauth/module.go |
| `INSUFFICIENT_BALANCE` | 402 | 余额不足：被额度闸门在 pre 相位拦下，请求没有转发上游 | contracts/quota.go |
| `QUOTA_SNAPSHOT_UNAVAILABLE` | 503 | 严格模式下余额快照未就绪或已过期（默认策略是放行，只有开严格模式才会出现） | contracts/quota.go |
| `ALL_ACCOUNTS_SATURATED` | 503 | 所有候选账号都达到并发上限（不排队、不放行） | contracts/contracts.go |
| `ALL_ACCOUNTS_COOLING` | 503 | 所有候选账号都在 429 / 额度耗尽的短期冷却中 | contracts/contracts.go |
| `ACCOUNT_PRIORITY_NO_ELIGIBLE_ACCOUNT` | 503 | 没有任何账号通过策略过滤（禁用 / 标签 / 健康 / 模型等原因） | modules/accountpriority/errors.go |
| `NO_ELIGIBLE_ACCOUNT` | 503 | 找不到可用账号（策略未给出任何候选时的兜底码） | internal/engine/engine.go |
| `MODEL_NOT_SERVED` | 503 | 按 `models` 过滤后没有任何账号服务这个模型名 | modules/modelroute/errors.go |
| `MODEL_MAP_FAILED` | 400 | 请求体无法按模型映射重写（换账号也没用） | modules/modelroute/errors.go |
| `PROTOCOL_CONVERT_FAILED` | 400 | 请求体无法按客户端协议解析或渲染 | modules/protoconv/errors.go |
| `PROTOCOL_UNKNOWN` | 502 | 选中账号没有声明上游协议，无法做协议转换（换账号可能成功） | modules/protoconv/errors.go |
| `PROTOCOL_TRANSCODE_FAILED` | 502 | 上游响应无法解析 / 无法转回客户端协议（换账号可能成功） | modules/protoconv/errors.go |
| `PROTOCOL_CODEC_UNAVAILABLE` | 502 | 需要的协议编解码器未注册（部署缺少能力，fail-closed 不降级） | modules/protoconv/errors.go |
| `NO_GATEWAY_RESPONSE` | 502 | 上游没有返回响应 | internal/engine/engine.go |
| `MODELS_UNAVAILABLE` | 503 | `GET /v1/models` 没有装配鉴权器时的 fail-closed 响应 | internal/httpapi/server.go |
| `METHOD_NOT_ALLOWED` | 405 | 入口存在但不支持该 HTTP 方法（例如 `POST /v1/models`） | internal/httpapi/server.go |
| `GATEWAY_INTERNAL` | 500 | 网关内部错误（详情只进日志，不回显给客户端） | contracts/protocol.go |

## 错误码（产品接口 /api/*）

这些是**控制面**接口的错误码：同一套 `{error: {code, message, requestId}}` 信封。
出处：`packages/api/src/errors.ts` 与各插件的 `errors.ts`。

| code | HTTP | 含义 | 出处 |
| --- | --- | --- | --- |
| `API_UNAUTHORIZED` | 401 | 需要登录（会话 Cookie 缺失或失效） | packages/api/src/errors.ts |
| `API_FORBIDDEN` | 403 | 当前账号没有管理员权限 | packages/api/src/errors.ts |
| `API_BAD_REQUEST` | 400 | 请求参数不合法 | packages/api/src/errors.ts |
| `API_NOT_FOUND` | 404 | 没有这个接口 | packages/api/src/errors.ts |
| `API_METHOD_NOT_ALLOWED` | 405 | 接口存在但不支持该 HTTP 方法 | packages/api/src/errors.ts |
| `API_BODY_TOO_LARGE` | 413 | 请求体超过上限 | packages/api/src/errors.ts |
| `API_INVALID_JSON` | 400 | 请求体不是合法 JSON | packages/api/src/errors.ts |
| `API_INTERNAL` | 500 | 内部错误（详情只进日志） | packages/api/src/errors.ts |
| `MODELHUB_UNAVAILABLE` | 503 | 模型广场服务不在运行 | packages/api/src/errors.ts |
| `API_USAGE_UNAVAILABLE` | 503 | 用量插件不在运行 | packages/api/src/http.ts |
| `USAGE_QUERY_INVALID` | 400 | 用量查询参数不合法 | packages/usage/src/errors.ts |
| `USAGE_REJECTED_STATE` | 409 | 隔离记录的当前状态不允许该操作 | packages/usage/src/errors.ts |
| `USAGE_REJECTED_FAILED` | 409 | 隔离记录重放失败（记录保持 pending，可修好后再试） | packages/usage/src/errors.ts |
| `USAGE_SETTLE_UNAVAILABLE` | 503 | 重放要补结算但结算插件不在运行（fail-closed） | packages/usage/src/errors.ts |
| `TOPUP_UNAVAILABLE` | 503 | 充值订单服务不在运行 | packages/api/src/errors.ts |
| `TOPUP_AMOUNT_INVALID` | 400 | 充值金额格式不合法 | packages/topup/src/errors.ts |
| `TOPUP_AMOUNT_OUT_OF_RANGE` | 400 | 充值金额超出允许范围 | packages/topup/src/errors.ts |
| `TOPUP_PROVIDER_UNKNOWN` | 400 | 指定了未启用的支付通道 | packages/topup/src/errors.ts |
| `TOPUP_PROVIDER_FAILED` | 502 | 支付通道创建支付失败 | packages/topup/src/errors.ts |
| `TOPUP_ORDER_NOT_FOUND` | 404 | 没有这笔充值订单（或不是自己的） | packages/topup/src/errors.ts |
| `TOPUP_ORDER_STATE` | 409 | 订单当前状态不允许该操作 | packages/topup/src/errors.ts |
| `TOPUP_BALANCE_FAILED` | 503 | 加余额失败：订单已退回待确认，可重试 | packages/topup/src/errors.ts |
| `TOPUP_NOT_READY` | 503 | 充值订单插件尚未装载完成 | packages/topup/src/errors.ts |
| `TOPUP_ACTOR_FORBIDDEN` | 403 | 调用方不在充值订单管理白名单里 | packages/topup/src/errors.ts |
| `REDEEM_CODE_INVALID` | 400 | 兑换码格式不合法 | packages/redeem/src/errors.ts |
| `REDEEM_CODE_NOT_FOUND` | 404 | 没有这个兑换码 | packages/redeem/src/errors.ts |
| `REDEEM_CODE_DISABLED` | 409 | 兑换码已停用 | packages/redeem/src/errors.ts |
| `REDEEM_CODE_EXPIRED` | 409 | 兑换码已过期 | packages/redeem/src/errors.ts |
| `REDEEM_CODE_USED` | 409 | 兑换码已被使用 | packages/redeem/src/errors.ts |
| `REDEEM_CODE_REDEEMING` | 409 | 兑换码正在被兑换（并发抢占失败） | packages/redeem/src/errors.ts |
| `REDEEM_CODE_BALANCE_FAILED` | 503 | 加余额失败：码已回退为可用，可重试 | packages/redeem/src/errors.ts |
| `PRICING_PRICE_INVALID` | 400 | 价格不是合法的非负十进制数 | packages/pricing/src/errors.ts |
| `PRICING_MODEL_INVALID` | 400 | 模型名不合法 | packages/pricing/src/errors.ts |
| `PRICING_NOT_FOUND` | 404 | 没有这个模型的价格 | packages/pricing/src/errors.ts |
| `PRICING_FORBIDDEN` | 403 | 调用方不在价格表管理白名单里 | packages/pricing/src/errors.ts |

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
