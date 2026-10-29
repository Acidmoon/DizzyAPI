## 入口一览

下面这张表**是从代码读出来的**（`internal/httpapi/server.go` 的 `mux.HandleFunc` 注册处；
方法看 handler 体里的 `http.MethodPost` / `http.MethodGet`，协议看 `contracts.ProtocolXxx`）：

<!-- facts:entries -->

## 入口详情

每一节的路径必须与上面表里的真实入口对应；代码删了入口，这一节的说明会被判定为「过时」而报错。

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

### POST /v1/embeddings

**请求**

- `model` 必填；`input` 是字符串或字符串数组（最多 2048 条、总计 1048576 字符）
- `encoding_format` / `dimensions` / `user` 原样转发给上游
- **不支持流式**：`stream: true` 直接 400

**响应**

- OpenAI 形状：`{object: "list", data: [{object: "embedding", index, embedding[]}], model, usage}`
- `usage` 只有 `prompt_tokens` / `total_tokens`（输出与缓存桶恒 0）

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

### GET /v1/models

**请求**

- 无请求体
- 鉴权与 LLM 入口一致：`Authorization: Bearer <API key>`

**响应**

- `{object: "list", data: [{id, object: "model", created, owned_by}]}`
- 只给名字：**不含**价格与覆盖度（那是产品面的 `/api/models`）

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
