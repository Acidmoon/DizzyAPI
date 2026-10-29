# DizzyAPI API 文档

DizzyAPI 是自托管的模型网关：**cordis 决定「什么在运行」，Go 决定「流量怎么走」**。
网关兼容 OpenAI Chat / OpenAI Responses / Anthropic Messages / Gemini 四种客户端协议，
**按入口路径决定客户端协议**，再按选中账号声明的上游协议自动转换。

## 认证与会话

- 所有 LLM 入口与 `GET /v1/models` 都要带 `Authorization: Bearer <API key>`。
- API key 在「API keys」页（`/console/api-keys`）创建，格式 `sk-dz-<trackingId>_<secret>`；
  key 只在创建时显示一次，丢了就轮换（**旧 key 不会复活**）。
- 缺 key 返回 401 `MISSING_API_KEY`；key 无效（不存在 / 已停用 / 哈希不匹配）返回 401 `INVALID_API_KEY`。
- `/api/*` 是**控制面**接口，用登录会话 Cookie（另需 `X-Requested-With: dizzyapi`），
  与 LLM 入口的 Bearer key 鉴权是**两套**，互不通用。

## 模型与价格

- 对外模型名、单价与可用性见「模型广场」（`/console/models`）。
- `GET /v1/models` 只返回当前**可用**模型名的并集，不含价格与覆盖度。
- 请求的 `model` 必须是**对外模型名**；网关按账号声明的 `modelMap` 改写成上游名。
