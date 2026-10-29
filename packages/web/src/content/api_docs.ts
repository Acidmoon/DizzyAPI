/**
 * API 文档的**内容**（静态事实）。
 *
 * 为什么单独一个文件：页面只是渲染器，文档内容要能被测试逐条断言
 * （入口路径、错误码、流式终止符），所以内容是数据结构，不是拼在模板里的字符串。
 *
 * **这里每个错误码都在代码里有出处**（行号见注释）；改代码时同步改这里，
 * `packages/web/test/pages-docs.test.ts` 会守住「文档里的码必须在源码里存在」。
 */

/** 一个 LLM 入口。 */
export interface ApiEntry {
  readonly method: string
  readonly path: string
  /** 客户端协议（决定请求 / 响应形状与错误体形状）。 */
  readonly protocol: string
  readonly protocolLabel: string
  readonly summary: string
  /** 请求体要点。 */
  readonly request: readonly string[]
  /** 响应体要点。 */
  readonly response: readonly string[]
}

/**
 * LLM 入口清单。出处：`internal/httpapi/server.go` 的 `Handler()` 路由注册。
 *
 * 注意：新增协议（例如 Gemini）时这里必须同步加一条，否则文档就落后于代码。
 */
export const API_ENTRIES: readonly ApiEntry[] = [
  {
    method: 'POST',
    path: '/v1/chat/completions',
    protocol: 'openai-chat',
    protocolLabel: 'OpenAI Chat Completions',
    summary: '最通用的入口：绝大多数 OpenAI SDK / 客户端默认打这里。',
    request: [
      '`model` 必填，用**对外模型名**（见 /console/models）',
      '`messages` 是 `{role, content}` 数组',
      '`stream: true` 走 SSE 流式',
      '其余采样参数原样转发（跨协议时有损字段见下）',
    ],
    response: [
      'OpenAI 形状：`{id, object: "chat.completion", choices[], usage}`',
      '流式：`data: {...}` 帧，最后一帧是 `data: [DONE]`',
    ],
  },
  {
    method: 'POST',
    path: '/v1/responses',
    protocol: 'openai-responses',
    protocolLabel: 'OpenAI Responses API',
    summary: 'OpenAI 新的 Responses 形状入口（Codex 等客户端使用）。',
    request: [
      '`model` 必填；`input` 是字符串或消息数组',
      '`stream: true` 走 SSE 流式',
      'Responses 专有字段按 Responses 语义处理，转 Chat 时有损',
    ],
    response: [
      'OpenAI Responses 形状：`{id, object: "response", output[], usage}`',
      '流式终止符是 `response.completed`（或 `response.incomplete` / `response.failed`），**不发 `[DONE]`**',
    ],
  },
  {
    method: 'POST',
    path: '/v1/messages',
    protocol: 'anthropic',
    protocolLabel: 'Anthropic Messages',
    summary: 'Anthropic 官方形状入口：Claude SDK / Claude Code 直接可用。',
    request: [
      '`model` 必填；`messages` 是 `{role, content}` 数组；`system` 单独传',
      '`max_tokens` 官方必填：客户端没给时网关补默认值（会记有损日志）',
      '`tools` / `tool_choice` 按 Anthropic 形状解析，跨协议时工具 id 会被可逆改写',
    ],
    response: [
      'Anthropic 形状：`{id, type: "message", role, content[], usage}`',
      '流式：`event: <类型>` + `data: {...}` 成对出现，终止符是 `message_stop`',
    ],
  },
  {
    method: 'GET',
    path: '/v1/models',
    protocol: '',
    protocolLabel: '模型列表',
    summary: 'OpenAI 形状的模型列表：当前**可用**对外模型名的并集（由 Go 侧账号快照算）。',
    request: ['无请求体', '鉴权与 LLM 入口一致：`Authorization: Bearer <API key>`'],
    response: [
      '`{object: "list", data: [{id, object: "model", created, owned_by}]}`',
      '只给名字：**不含**价格与覆盖度（那是产品面的 `/api/models`）',
    ],
  },
  {
    method: 'POST',
    path: '/v1beta/models/{model}:generateContent',
    protocol: 'gemini',
    protocolLabel: 'Gemini generateContent',
    summary:
      'Google 官方的 Gemini 入口：**模型名在路径里**（`{model}` 段），请求体里没有 `model` 字段。',
    request: [
      '模型名在**路径**里：`/v1beta/models/<对外模型名>:generateContent`（模型名里不能带斜杠，带 `/` 的路径一律 404）',
      '`contents` 是 `{role, parts}` 数组；`systemInstruction` 单独传系统提示',
      '`generationConfig` 放采样参数（`temperature` / `maxOutputTokens` / `topP` 等）',
      '`tools` / `toolConfig` 按 Gemini 形状解析，跨协议时工具 id 会被可逆改写',
    ],
    response: [
      'Gemini 形状：`{candidates: [{content, finishReason}], usageMetadata, modelVersion}`',
      '`usageMetadata` 里 `promptTokenCount` **含**缓存命中，网关按上游协议归一成四桶记账',
    ],
  },
  {
    method: 'POST',
    path: '/v1beta/models/{model}:streamGenerateContent',
    protocol: 'gemini',
    protocolLabel: 'Gemini streamGenerateContent',
    summary: 'Gemini 的流式方法：同一个模型名在路径里，**必须带 `?alt=sse`**。',
    request: [
      '路径同上，方法名换成 `:streamGenerateContent`，并带 `?alt=sse`（不带的话上游返回 JSON 数组而不是 SSE）',
      '请求体与 `:generateContent` 完全一致',
    ],
    response: [
      '每帧是 `data: {...}`，负载是**完整的** `GenerateContentResponse`（累计形态，不是增量文本）',
      '**不发 `data: [DONE]`**：以最后一帧里 candidate 的 `finishReason` 为准',
    ],
  },
  {
    method: 'GET',
    path: '/healthz',
    protocol: '',
    protocolLabel: '运行期探针',
    summary: '网关存活探针，不分协议、不鉴权、不泄漏任何账号信息。',
    request: ['无请求体', '不需要鉴权'],
    response: ['`{status: "ok"}` 形状的轻量响应'],
  },
]

/** 一条错误码事实。 */
export interface ApiErrorDoc {
  readonly code: string
  readonly status: number
  readonly meaning: string
  /** 出处（源码位置），给人看，也用来提醒「文档不是凭记忆写的」。 */
  readonly source: string
}

/**
 * 错误体形状：**按客户端协议不同**。
 *
 * 出处：`contracts/protocol.go` 的 `RenderError`。三种形状都是「先不坏官方形状，
 * 网关稳定码只做纯增量」：Anthropic 的 `code`、Gemini 的 `reason` 都是超集字段，
 * 空码时整键不输出。
 */
export interface ApiErrorShape {
  /** 适用协议（`''` = 默认 / OpenAI 形状）。 */
  readonly protocols: readonly string[]
  readonly shape: string
  /** 错误体里出现的键（用来和源码核对，防止文档凭空写字段）。 */
  readonly keys: readonly string[]
  readonly note: string
}

export const ERROR_SHAPES: readonly ApiErrorShape[] = [
  {
    protocols: ['', 'openai-chat', 'openai-responses'],
    shape: '`{"error": {"message", "type", "code"}}`',
    keys: ['error', 'message', 'type', 'code'],
    note: '`code` 是网关稳定码（如 `ALL_ACCOUNTS_SATURATED`）；`type` 按 HTTP 状态映射（`invalid_request_error` / `authentication_error` / `rate_limit_error` / `server_error`）。',
  },
  {
    protocols: ['anthropic'],
    shape: '`{"type": "error", "error": {"type", "message", "code"}}`',
    keys: ['type', 'error', 'message', 'code'],
    note: '官方 schema 只有 `type` / `message`；`code` 是**纯增量**（空码不输出该键），老客户端看到的形状不变。',
  },
  {
    protocols: ['gemini'],
    shape: '`{"error": {"code": 503, "message": "...", "status": "UNAVAILABLE", "reason": "..."}}`',
    keys: ['error', 'code', 'message', 'status', 'reason'],
    note:
      '官方 schema：`code` 是**整数 HTTP 状态**（不是字符串码）、`status` 是 Google 枚举名' +
      '（`INVALID_ARGUMENT` / `UNAUTHENTICATED` / `RESOURCE_EXHAUSTED` / `UNAVAILABLE` / `INTERNAL` 等）；' +
      '网关稳定码放在**纯增量**的 `reason` 里（空码不输出该键）。',
  },
]

/**
 * LLM 入口（Go gatewayd）的稳定错误码。
 *
 * 出处：`contracts/` 与 `modules/` 下各包的 errors.go、`internal/engine/engine.go`、
 * `internal/httpapi/server.go`、`modules/keyauth/module.go`。
 */
export const GATEWAY_ERRORS: readonly ApiErrorDoc[] = [
  {
    code: 'MISSING_API_KEY',
    status: 401,
    meaning: '没有带 `Authorization: Bearer <key>`',
    source: 'modules/keyauth/module.go',
  },
  {
    code: 'INVALID_API_KEY',
    status: 401,
    meaning: 'API key 无效（不存在 / 已停用 / 哈希不匹配）',
    source: 'modules/keyauth/module.go',
  },
  {
    code: 'INSUFFICIENT_BALANCE',
    status: 402,
    meaning: '余额不足：被额度闸门在 pre 相位拦下，请求没有转发上游',
    source: 'contracts/quota.go',
  },
  {
    code: 'QUOTA_SNAPSHOT_UNAVAILABLE',
    status: 503,
    meaning: '严格模式下余额快照未就绪或已过期（默认策略是放行，只有开严格模式才会出现）',
    source: 'contracts/quota.go',
  },
  {
    code: 'ALL_ACCOUNTS_SATURATED',
    status: 503,
    meaning: '所有候选账号都达到并发上限（不排队、不放行）',
    source: 'contracts/contracts.go',
  },
  {
    code: 'ALL_ACCOUNTS_COOLING',
    status: 503,
    meaning: '所有候选账号都在 429 / 额度耗尽的短期冷却中',
    source: 'contracts/contracts.go',
  },
  {
    code: 'ACCOUNT_PRIORITY_NO_ELIGIBLE_ACCOUNT',
    status: 503,
    meaning: '没有任何账号通过策略过滤（禁用 / 标签 / 健康 / 模型等原因）',
    source: 'modules/accountpriority/errors.go',
  },
  {
    code: 'NO_ELIGIBLE_ACCOUNT',
    status: 503,
    meaning: '找不到可用账号（策略未给出任何候选时的兜底码）',
    source: 'internal/engine/engine.go',
  },
  {
    code: 'MODEL_NOT_SERVED',
    status: 503,
    meaning: '按 `models` 过滤后没有任何账号服务这个模型名',
    source: 'modules/modelroute/errors.go',
  },
  {
    code: 'MODEL_MAP_FAILED',
    status: 400,
    meaning: '请求体无法按模型映射重写（换账号也没用）',
    source: 'modules/modelroute/errors.go',
  },
  {
    code: 'PROTOCOL_CONVERT_FAILED',
    status: 400,
    meaning: '请求体无法按客户端协议解析或渲染',
    source: 'modules/protoconv/errors.go',
  },
  {
    code: 'PROTOCOL_UNKNOWN',
    status: 502,
    meaning: '选中账号没有声明上游协议，无法做协议转换（换账号可能成功）',
    source: 'modules/protoconv/errors.go',
  },
  {
    code: 'PROTOCOL_TRANSCODE_FAILED',
    status: 502,
    meaning: '上游响应无法解析 / 无法转回客户端协议（换账号可能成功）',
    source: 'modules/protoconv/errors.go',
  },
  {
    code: 'PROTOCOL_CODEC_UNAVAILABLE',
    status: 502,
    meaning: '需要的协议编解码器未注册（部署缺少能力，fail-closed 不降级）',
    source: 'modules/protoconv/errors.go',
  },
  {
    code: 'NO_GATEWAY_RESPONSE',
    status: 502,
    meaning: '上游没有返回响应',
    source: 'internal/engine/engine.go',
  },
  {
    code: 'MODELS_UNAVAILABLE',
    status: 503,
    meaning: '`GET /v1/models` 没有装配鉴权器时的 fail-closed 响应',
    source: 'internal/httpapi/server.go',
  },
  {
    code: 'METHOD_NOT_ALLOWED',
    status: 405,
    meaning: '入口存在但不支持该 HTTP 方法（例如 `POST /v1/models`）',
    source: 'internal/httpapi/server.go',
  },
  {
    code: 'GATEWAY_INTERNAL',
    status: 500,
    meaning: '网关内部错误（详情只进日志，不回显给客户端）',
    source: 'internal/engine/engine.go',
  },
]

/**
 * 产品 HTTP 入口（`/api/*`，由 TS 的 `api` 插件提供）的稳定错误码。
 *
 * 这些是**控制面**接口的错误码：同一套 `{error: {code, message, requestId}}` 信封。
 * 出处：`packages/api/src/errors.ts` 与各插件的 `errors.ts`。
 */
export const PRODUCT_ERRORS: readonly ApiErrorDoc[] = [
  { code: 'API_UNAUTHORIZED', status: 401, meaning: '需要登录（会话 Cookie 缺失或失效）', source: 'packages/api/src/errors.ts' },
  { code: 'API_FORBIDDEN', status: 403, meaning: '当前账号没有管理员权限', source: 'packages/api/src/errors.ts' },
  { code: 'API_BAD_REQUEST', status: 400, meaning: '请求参数不合法', source: 'packages/api/src/errors.ts' },
  { code: 'API_NOT_FOUND', status: 404, meaning: '没有这个接口', source: 'packages/api/src/errors.ts' },
  { code: 'API_METHOD_NOT_ALLOWED', status: 405, meaning: '接口存在但不支持该 HTTP 方法', source: 'packages/api/src/errors.ts' },
  { code: 'API_BODY_TOO_LARGE', status: 413, meaning: '请求体超过上限', source: 'packages/api/src/errors.ts' },
  { code: 'API_INVALID_JSON', status: 400, meaning: '请求体不是合法 JSON', source: 'packages/api/src/errors.ts' },
  { code: 'API_INTERNAL', status: 500, meaning: '内部错误（详情只进日志）', source: 'packages/api/src/errors.ts' },
  { code: 'MODELHUB_UNAVAILABLE', status: 503, meaning: '模型广场服务不在运行', source: 'packages/api/src/errors.ts' },
  { code: 'API_USAGE_UNAVAILABLE', status: 503, meaning: '用量插件不在运行', source: 'packages/api/src/http.ts' },
  { code: 'USAGE_QUERY_INVALID', status: 400, meaning: '用量查询参数不合法', source: 'packages/api/src/errors.ts' },
  { code: 'USAGE_REJECTED_STATE', status: 409, meaning: '隔离记录的当前状态不允许该操作', source: 'packages/api/src/errors.ts' },
  { code: 'USAGE_REJECTED_FAILED', status: 409, meaning: '隔离记录重放失败（记录保持 pending，可修好后再试）', source: 'packages/api/src/errors.ts' },
  { code: 'USAGE_SETTLE_UNAVAILABLE', status: 503, meaning: '重放要补结算但结算插件不在运行（fail-closed）', source: 'packages/api/src/errors.ts' },
  { code: 'TOPUP_UNAVAILABLE', status: 503, meaning: '充值订单服务不在运行', source: 'packages/api/src/errors.ts' },
  { code: 'TOPUP_AMOUNT_INVALID', status: 400, meaning: '充值金额格式不合法', source: 'packages/api/src/errors.ts' },
  { code: 'TOPUP_AMOUNT_OUT_OF_RANGE', status: 400, meaning: '充值金额超出允许范围', source: 'packages/api/src/errors.ts' },
  { code: 'TOPUP_PROVIDER_UNKNOWN', status: 400, meaning: '指定了未启用的支付通道', source: 'packages/api/src/errors.ts' },
  { code: 'TOPUP_PROVIDER_FAILED', status: 502, meaning: '支付通道创建支付失败', source: 'packages/api/src/errors.ts' },
  { code: 'TOPUP_ORDER_NOT_FOUND', status: 404, meaning: '没有这笔充值订单（或不是自己的）', source: 'packages/api/src/errors.ts' },
  { code: 'TOPUP_ORDER_STATE', status: 409, meaning: '订单当前状态不允许该操作', source: 'packages/api/src/errors.ts' },
  { code: 'TOPUP_BALANCE_FAILED', status: 503, meaning: '加余额失败：订单已退回待确认，可重试', source: 'packages/api/src/errors.ts' },
  { code: 'TOPUP_NOT_READY', status: 503, meaning: '充值订单插件尚未装载完成', source: 'packages/api/src/errors.ts' },
  { code: 'TOPUP_ACTOR_FORBIDDEN', status: 403, meaning: '调用方不在充值订单管理白名单里', source: 'packages/api/src/errors.ts' },
  { code: 'REDEEM_CODE_INVALID', status: 400, meaning: '兑换码格式不合法', source: 'packages/api/src/errors.ts' },
  { code: 'REDEEM_CODE_NOT_FOUND', status: 404, meaning: '没有这个兑换码', source: 'packages/api/src/errors.ts' },
  { code: 'REDEEM_CODE_DISABLED', status: 409, meaning: '兑换码已停用', source: 'packages/api/src/errors.ts' },
  { code: 'REDEEM_CODE_EXPIRED', status: 409, meaning: '兑换码已过期', source: 'packages/api/src/errors.ts' },
  { code: 'REDEEM_CODE_USED', status: 409, meaning: '兑换码已被使用', source: 'packages/api/src/errors.ts' },
  { code: 'REDEEM_CODE_REDEEMING', status: 409, meaning: '兑换码正在被兑换（并发抢占失败）', source: 'packages/api/src/errors.ts' },
  { code: 'REDEEM_CODE_BALANCE_FAILED', status: 503, meaning: '加余额失败：码已回退为可用，可重试', source: 'packages/api/src/errors.ts' },
  { code: 'PRICING_PRICE_INVALID', status: 400, meaning: '价格不是合法的非负十进制数', source: 'packages/api/src/errors.ts' },
  { code: 'PRICING_MODEL_INVALID', status: 400, meaning: '模型名不合法', source: 'packages/api/src/errors.ts' },
  { code: 'PRICING_NOT_FOUND', status: 404, meaning: '没有这个模型的价格', source: 'packages/api/src/http.ts' },
  { code: 'PRICING_FORBIDDEN', status: 403, meaning: '调用方不在价格表管理白名单里', source: 'packages/api/src/errors.ts' },
]

/** 流式响应的差异（三条入口各不同，最容易踩坑的地方）。 */
export const STREAM_NOTES: readonly { readonly protocol: string; readonly note: string }[] = [
  {
    protocol: 'openai-chat',
    note: '帧形如 `data: {...}`，**最后发 `data: [DONE]`**；遇到 `[DONE]` 就结束读取。',
  },
  {
    protocol: 'openai-responses',
    note:
      '事件流以 `response.completed`（或 `response.incomplete` / `response.failed`）结束，' +
      '**网关不发 `data: [DONE]`**（上游真发了也只会被当普通帧吞掉，不会转发给客户端）。',
  },
  {
    protocol: 'anthropic',
    note: '每帧是 `event: <类型>` + `data: {...}` 两行；终止符是 `message_stop`，同样**不发 `[DONE]`**。',
  },
  {
    protocol: 'gemini',
    note:
      '流式端点必须带 `?alt=sse`；每帧只有 `data: {...}`（完整的 `GenerateContentResponse`，累计形态），' +
      '**不发 `data: [DONE]`**，以最后一帧 candidate 的 `finishReason` 作为结束信号。',
  },
]

/** 最小可用示例（curl）。 */
export const CURL_EXAMPLES: readonly { readonly title: string; readonly command: string }[] = [
  {
    title: 'OpenAI Chat（非流式）',
    command: `curl https://<站点域名>/v1/chat/completions \\
  -H "Authorization: Bearer $DIZZY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "你好"}]
  }'`,
  },
  {
    title: 'OpenAI Chat（流式）',
    command: `curl -N https://<站点域名>/v1/chat/completions \\
  -H "Authorization: Bearer $DIZZY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "deepseek-chat", "stream": true,
       "messages": [{"role": "user", "content": "你好"}]}'`,
  },
  {
    title: 'Anthropic Messages',
    command: `curl https://<站点域名>/v1/messages \\
  -H "Authorization: Bearer $DIZZY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "你好"}]
  }'`,
  },
  {
    title: 'Gemini generateContent',
    command: `curl https://<站点域名>/v1beta/models/gemini-2.0-flash:generateContent \\
  -H "Authorization: Bearer $DIZZY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "你好"}]}],
    "generationConfig": {"temperature": 0.7, "maxOutputTokens": 256}
  }'`,
  },
  {
    title: 'Gemini 流式（必须带 alt=sse）',
    command: `curl -N "https://<站点域名>/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse" \\
  -H "Authorization: Bearer $DIZZY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"contents": [{"role": "user", "parts": [{"text": "你好"}]}]}'`,
  },
  {
    title: '列出模型',
    command: `curl https://<站点域名>/v1/models \\
  -H "Authorization: Bearer $DIZZY_API_KEY"`,
  },
]

/** 有损转换提示（跨协议时哪些字段表达不了）。 */
export const LOSSY_NOTES: readonly string[] = [
  '`thinking.signature` 不回传（跨协议时无法表达）。',
  '`cache_control` 在跨协议时会被丢弃。',
  'OpenAI 专有采样参数（如 `logit_bias`）转 Anthropic 时丢弃。',
  'Anthropic 的 `max_tokens` 必填：客户端没给时网关补默认值。',
  'Gemini 的 `generationConfig.candidateCount > 1` 明确拒绝（网关只承载单候选）。',
  'Gemini 的 `thoughtsTokenCount` 记入思考 token，**不重复**计入输出 token。',
  '模型映射只改**请求**里的模型名：响应里的 `model` 保持上游原名。',
]
