## 入口一览

| 方法 | 路径 | 协议 | 协议名 | 说明 |
| --- | --- | --- | --- | --- |
| POST | `/v1/chat/completions` | `openai-chat` | OpenAI Chat Completions | 最通用的入口：绝大多数 OpenAI SDK / 客户端默认打这里。 |
| POST | `/v1/responses` | `openai-responses` | OpenAI Responses API | OpenAI 新的 Responses 形状入口（Codex 等客户端使用）。 |
| POST | `/v1/messages` | `anthropic` | Anthropic Messages | Anthropic 官方形状入口：Claude SDK / Claude Code 直接可用。 |
| GET | `/v1/models` |  | 模型列表 | OpenAI 形状的模型列表：当前**可用**对外模型名的并集（由 Go 侧账号快照算）。 |
| POST | `/v1beta/models/{model}:generateContent` | `gemini` | Gemini generateContent | Google 官方的 Gemini 入口：**模型名在路径里**，请求体里没有 `model` 字段。 |
| POST | `/v1beta/models/{model}:streamGenerateContent` | `gemini` | Gemini streamGenerateContent | Gemini 的流式方法：同一个模型名在路径里，**必须带 `?alt=sse`**。 |
| POST | `/v1/embeddings` | `openai-chat` | OpenAI Embeddings | OpenAI 兼容的向量化入口：与 chat 同协议、同鉴权，但只有 OpenAI 兼容账号能处理。 |
| GET | `/healthz` |  | 运行期探针 | 网关存活探针，不分协议、不鉴权、不泄漏任何账号信息。 |
| GET | `/metrics` |  | 运行期指标 | Prometheus 文本格式指标：只在 gatewayd 的回环监听上暴露（nginx 不反代）。 |

## 入口详情

### POST /v1/chat/completions

**请求**

- `model` 必填，用**对外模型名**（见 /console/models）
- `messages` 是 `{role, content}` 数组
- `stream: true` 走 SSE 流式
- 其余采样参数原样转发（跨协议时有损字段见下）

**响应**

- OpenAI 形状：`{id, object: "chat.completion", choices[], usage}`
- 流式：`data: {...}` 帧，最后一帧是 `data: [DONE]`

### POST /v1/responses

**请求**

- `model` 必填；`input` 是字符串或消息数组
- `stream: true` 走 SSE 流式
- Responses 专有字段按 Responses 语义处理，转 Chat 时有损

**响应**

- OpenAI Responses 形状：`{id, object: "response", output[], usage}`
- 流式终止符是 `response.completed`（或 `response.incomplete` / `response.failed`），**不发 `[DONE]`**

### POST /v1/messages

**请求**

- `model` 必填；`messages` 是 `{role, content}` 数组；`system` 单独传
- `max_tokens` 官方必填：客户端没给时网关补默认值（会记有损日志）
- `tools` / `tool_choice` 按 Anthropic 形状解析，跨协议时工具 id 会被可逆改写

**响应**

- Anthropic 形状：`{id, type: "message", role, content[], usage}`
- 流式：`event: <类型>` + `data: {...}` 成对出现，终止符是 `message_stop`

### GET /v1/models

**请求**

- 无请求体
- 鉴权与 LLM 入口一致：`Authorization: Bearer <API key>`

**响应**

- `{object: "list", data: [{id, object: "model", created, owned_by}]}`
- 只给名字：**不含**价格与覆盖度（那是产品面的 `/api/models`）

### POST /v1beta/models/{model}:generateContent

**请求**

- 模型名在**路径**里：`/v1beta/models/<对外模型名>:generateContent`。模型名可带或不带 `models/` 前缀，两种都接受（`/v1beta/models/models/gemini-2.0-flash:generateContent` 与 `/v1beta/models/gemini-2.0-flash:generateContent` 等价）；带**多层**前缀或其它斜杠的路径一律 404
- `contents` 是 `{role, parts}` 数组；`systemInstruction` 单独传系统提示
- `generationConfig` 放采样参数（`temperature` / `maxOutputTokens` / `topP` 等）
- `tools` / `toolConfig` 按 Gemini 形状解析，跨协议时工具 id 会被可逆改写

**响应**

- Gemini 形状：`{candidates: [{content, finishReason}], usageMetadata, modelVersion}`
- `usageMetadata` 里 `promptTokenCount` **含**缓存命中，网关按上游协议归一成四桶记账

### POST /v1beta/models/{model}:streamGenerateContent

**请求**

- 路径同上，方法名换成 `:streamGenerateContent`，并带 `?alt=sse`（不带的话上游返回 JSON 数组而不是 SSE）
- 请求体与 `:generateContent` 完全一致

**响应**

- 每帧是 `data: {...}`，负载是**完整的** `GenerateContentResponse`（累计形态，不是增量文本）
- **不发 `data: [DONE]`**：以最后一帧里 candidate 的 `finishReason` 为准

### POST /v1/embeddings

**请求**

- `model` 必填；`input` 是字符串或字符串数组（最多 2048 条、总计 1048576 字符）
- `encoding_format` / `dimensions` / `user` 原样转发给上游
- **不支持流式**：`stream: true` 直接 400

**响应**

- OpenAI 形状：`{object: "list", data: [{object: "embedding", index, embedding[]}], model, usage}`
- `usage` 只有 `prompt_tokens` / `total_tokens`（输出与缓存桶恒 0）

### GET /healthz

**请求**

- 无请求体
- 不需要鉴权

**响应**

- `{status: "ok"}` 形状的轻量响应

### GET /metrics

**请求**

- 无请求体
- 不需要鉴权（只监听回环，运维面）

**响应**

- `# HELP` / `# TYPE` + 指标行；`dizzy_request_total{protocol,status}`、`dizzy_tokens_total{bucket}`、`dizzy_upstream_attempt_total` 等
- 标签只用固定枚举（协议名 / 状态码 / 失败码 / token 桶），**不含**账号 id、用户 id、IP 与模型名
