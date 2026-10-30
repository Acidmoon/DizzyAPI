# 验收 · CLI 对 `/api/*` 的依赖清单（给前端换 SPA 用）

> 用途：`dizzy`（`cmd/dizzy`，独立 Go 二进制）对 `api` 插件 JSON 接口的**全部**依赖，
> 逐条带文件与行号。`交互` 那条线派后端补口活时，以这份清单为输入；
> `工具` 那条线做前端下线时，用它判断「哪些服务端契约不能动」。
>
> 基线：`origin/main` @ `0b82a54`（`pnpm test` 1021 用例）。
> 本文与 [`08-其余抽查项.md`](08-其余抽查项.md) 是同号不同文件（那份是上线验收附录 B）。
>
> 结论先放这：**22 个调用点全部已经是「200 + JSON」，没有一个依赖 303 / 302，也没有一个
> 依赖服务端渲染的 HTML。** 所以 SPA 化对 CLI 是**纯增量**，不需要为 CLI 补任何 JSON 端点。

---

## 1. 每条 `/api/*` 都先过五道闸

CLI 发的每个 `/api/*` 请求都会依次碰到下面这些检查。换前端不改变它们，但**改接口时要一起考虑**：

| # | 闸 | 规则 | 位置 |
|---|---|---|---|
| 1 | Host | `Host` 必须是 `127.0.0.1:<port>` 或 `localhost:<port>` | `packages/api/src/http.ts:193-199` |
| 2 | Origin | 带 `Origin` 时必须同源；`Sec-Fetch-Site: cross-site` 直接 403 | `packages/api/src/http.ts:201-213` |
| 3 | 请求头 | `X-Requested-With: dizzyapi`，**GET / 登录前也必须带** | `packages/api/src/http.ts:215-224` |
| 4 | 会话 | cookie `dizzyapi_session` → `auth.verifySession`；失效 401、封禁 403 | `packages/api/src/http_session.ts:17-46` |
| 5 | 管理员 | 角色不是 `admin` → 403 | `packages/api/src/http_session.ts:48-53` |

CLI 侧怎么满足：

- **1**：生产由 nginx 把 `Host` 改写成 `127.0.0.1:7791`（`AGENTS.md:668-671`）；本地直连就是回环地址。
- **2**：CLI **不发 `Origin`**（`cmd/dizzy/client.go:176-202` 只设 `Accept` / `Content-Type` /
  `Authorization` / `X-Requested-With` / cookie），所以闸 2 对它不生效。**新 SPA 会发 `Origin`**，
  所以 nginx 对 `/api/*` 也得改写 `Origin`（现在 `AGENTS.md:671` 只写了 `/` 那条）——
  这条是给 `工具` / 部署线的，不是 CLI 的问题。
- **3**：`ClientOptions.APIRequestHeader` **无条件为真**（`cmd/dizzy/main.go:139-178`），
  登录与 `/api/health` 也带（`cmd/dizzy/cmd_auth.go:49-53`、`cmd/dizzy/cmd_health.go:46-48`）。
- **4/5**：cookie 值 `dizzyapi_session`（`cmd/dizzy/client.go:260`）；会话只发 `/v1/*` 之外的 `/api/*`。

---

## 2. 调用清单（22 个调用点，21 个唯一端点）

约定：「期望响应」列是 **CLI 代码实际解析的字段**；「服务端实际」列是**当前实现回的东西**
（行号都在 `packages/api/src/` 下）。

### 2.1 认证与会话

| # | 文件:行 | 方法 路径 | 请求 | 期望响应（CLI 解析） | 服务端实际 |
|---|---|---|---|---|---|
| 1 | `cmd/dizzy/cmd_auth.go:56-64` | `POST /api/auth/login` | `{email,password}`；`CaptureCookie: dizzyapi_session` | `200` + `{user,session}` + `Set-Cookie` | `routes/auth.ts:42-54` → `200 loginResponse`（`http_session.ts:66-77`）+ `setSessionCookie`（`http_session.ts:90-105`） |
| 2 | `cmd/dizzy/cmd_auth.go:187` | `POST /api/auth/logout` | 无 body | 忽略 body；**<500 一律当成功** | `routes/auth.ts:56-69` → `200 {ok:true}` + 清 cookie（令牌无效也 200） |
| 3 | `cmd/dizzy/cmd_auth.go:231` | `GET /api/session` | 无 | `{user,email,session,permissions}` | `http.ts:254-259` → `200 sessionResponse`（`http_session.ts:55-64`） |

**登录的关键事实**：会话 cookie 是 `HttpOnly`，**只在 `Set-Cookie` 里，不进 JSON 体**
（`http_session.ts:103`；`cmd/dizzy/client.go:130-135` 的注释与 `captureCookie` 就是照这个写的）。
登录成功但拿不到 cookie 时 CLI 明确报错（`cmd_auth.go:75-78`），不静默当成功。

### 2.2 健康与模型

| # | 文件:行 | 方法 路径 | 请求 | 期望响应 | 服务端实际 |
|---|---|---|---|---|---|
| 4 | `cmd/dizzy/cmd_health.go:71` | `GET /api/health` | 无（公开，但仍然要闸 3） | `{...}` 原样打 | `http.ts:237-241` → `200 health(...)` |
| 5 | `cmd/dizzy/cmd_models.go:141` | `GET /api/models` | `?search&availability&priced` | `{available[],unavailable[],summary{total,availableCount,unavailableCount,pricedCount,accountCount}}` | `routes/models.ts:30,59` → `200 modelCatalogOf(...)` |

### 2.3 API key（全在 `/api/keys`）

| # | 文件:行 | 方法 路径 | 请求 | 期望响应 | 服务端实际 |
|---|---|---|---|---|---|
| 6 | `cmd/dizzy/cmd_keys.go:85` | `GET /api/keys` | 无 | `{items[]}`（`id,name,maskedKey,enabled,…`） | `routes/keys.ts:19-22` → `200 {items: normalizeKeyList(...)}` |
| 7 | `cmd/dizzy/cmd_keys.go:130` | `POST /api/keys` | `{name}` | 单条 created（含一次性 `secret`，默认被 CLI 掩码） | `routes/keys.ts:24-30` → `200 normalizeCreatedKey(...)` |
| 8 | `cmd/dizzy/cmd_keys.go:176` | `POST /api/keys/:id/rotate` | 无 body | 同 7（新的 `secret`） | `routes/keys.ts:82-87` → `200 normalizeCreatedKey(...)` |
| 9 | `cmd/dizzy/cmd_keys.go:221` | `PATCH /api/keys/:id` | `{enabled:bool}` | 单条 summary | `routes/keys.ts:37-71` → `200 normalizeKeySummary(...)` |
| 10 | `cmd/dizzy/cmd_keys.go:255` | `DELETE /api/keys/:id` | 无 | body 忽略（只想拿成功状态） | `routes/keys.ts:72-77` → `200 {removed:true}` |

> `PATCH` 的 JSON 体只放 `enabled` 是 CLI 的当前能力；服务端还接受 `name` / `expiresAt` /
> `spendingLimitMicros` / `concurrencyLimit`（`routes/keys.ts:40-68`），CLI 尚未暴露——纯增量。

### 2.4 用量（CLI 的对账核心）

| # | 文件:行 | 方法 路径 | 请求 | 期望响应 | 服务端实际 |
|---|---|---|---|---|---|
| 11 | `cmd/dizzy/cmd_usage.go:91` | `GET /api/usage` | `?range=7d\|30d\|90d&limit=1..200&model&apiKeyId` | `{range,from,to,totals,daily[],models[],records{items[],nextCursor},pricingAvailable,generatedAt}` | `http.ts:268-272` → `routes/usage.ts:19` 的 `usage(...)` → `200` |
| 12 | `cmd/dizzy/cmd_usage.go:313` | `GET /api/usage/export` | `?range&format=csv&model&apiKeyId` | `{filename,content}`（**JSON 包 CSV 文本**，不是 `text/csv`） | `routes/usage.ts:94-134` → `200 usage.exportCsv(...)` |
| 13 | `cmd/dizzy/cmd_usage.go:432` | `GET /api/usage/:reqId` | 无 | `{record{…,costMicros,ttftMs,…}}` | `routes/usage.ts:147-160` → `200 {record: usageDetailOf(row)}` |
| 14 | `cmd/dizzy/usage_cost.go:62-75` | `GET /api/usage/:reqId`（同一个端点，**轮询**） | 无 | 同上，只要 `record.reqId` 与 `record.costMicros` | 同上 |

两个细节：

- **#12 必须是 JSON**：CLI 读 `{filename, content}` 再自己落盘（`cmd_usage.go:316-328`）。
  服务端**另一个** CSV 出口是 `web` 插件的 `/console/usage/export.csv`（直接 `text/csv`），
  那不属于 `/api/*`，CLI 不走它。**如果**有人把 `/api/usage/export` 改成直接回
  `text/csv`，CLI 会当场坏掉 —— 这条是**真契约**。
- **#14 的 404 是正常路径**：用量是异步落库（Go 环形缓冲 → TS 每秒轮询 → SQLite），
  请求刚返回时那条记录还查不到。CLI 轮询 8 次 × 500 ms（`usage_cost.go:14-17`），
  404 只是「这一轮落空」，不是错误；查不到就明说「未取回费用」，不退化成猜测
  （`usage_cost.go:19-56`）。

### 2.5 管理面（`admin` 子命令，全部要 `admin` 角色）

| # | 文件:行 | 方法 路径 | 请求 | 期望响应 | 服务端实际 |
|---|---|---|---|---|---|
| 15 | `cmd/dizzy/cmd_admin.go:106` | `GET /api/accounts` | `?provider&status&limit` | `{items[]}`（`id,label,provider,kind,status,enabled,…`） | `routes/admin_accounts.ts:106-126` → `200 {items,nextCursor}` |
| 16 | `cmd/dizzy/cmd_admin.go:131` | `GET /api/accounts/:id` | 无 | 单条 account | `routes/admin_accounts.ts:214-216` → `200 accountOf(...)` |
| 17 | `cmd/dizzy/cmd_admin.go:162-168` | `POST /api/accounts/:id/test` | `{model?}`（可为空对象） | 宽松 map，只找 `ok/model/latencyMs/error/message` | `routes/admin_accounts.ts:312-326` → `200 testConnection(...)` |
| 18 | `cmd/dizzy/cmd_admin.go:187-191` | `PATCH /api/accounts/:id` | `{enabled:bool}` | 单条 account | `routes/admin_accounts.ts:218-290` → `200 accountOf(...)` |
| 19 | `cmd/dizzy/cmd_admin.go:230` | `GET /api/users` | 无 | `{items[{id,name,status,role,balanceMinor}]}` | `routes/admin_users.ts:38` → `200 {items: users.map(adminUserOf)}` |
| 20 | `cmd/dizzy/cmd_admin.go:270` | `GET /api/pricing` | 无 | `{items[{inputPerMillion,outputPerMillion,cacheReadPerMillion,cacheWritePerMillion,currency}]}` | `routes/pricing.ts:66-70` → `200 {items: pricing.list().map(viewOf)}` |
| 21 | `cmd/dizzy/cmd_admin.go:287-296` | `PUT /api/pricing/:model` | `{inputPerMillion,outputPerMillion}`（**十进制字符串，金额不经浮点**） | 单条 price | `routes/pricing.ts:86-119` → `200 viewOf(written)` |
| 22 | `cmd/dizzy/cmd_admin.go:321` | `GET /api/admin/stats` | 无 | 宽松 map，只挑 `users/accounts/keys/usage` | `routes/admin_stats.ts:24-81` → `200 {...}` |

> #21 用 `PUT`（不是 `PATCH`）：服务端只对 `PUT` 做写入（`routes/pricing.ts:86`）——
> 换前端时别顺手把方法名改掉。

---

## 3. SPA 化会不会让 CLI 坏：逐条判断

### 3.1 结论

| 类别 | 数量 | 要不要后端补 JSON | 对 CLI |
|---|---|---|---|
| CLI 已经在用的 `/api/*`（上表 22 条） | 22 | **不要**，本来就是 JSON | 不受影响 |
| 旧 SSR `web` 的页面写操作（`POST <page>?action=…` → 303） | 约 20+ 个 action | 看 `交互` 的契约表：SPA 要调的要么已有 `/api/*` 等价物，要么**新增 /api/* 路由** | 不受影响（CLI 从不碰页面路由） |
| `/console/api-docs.md`、`/llms.txt` | 2 条 | 不是 `/api/*`，由 `web`（将来是新前端插件）发 | 不受影响（CLI 不引用，见 §4） |

为什么「旧页面 303 → JSON」这件事对 CLI 天然无害：

- 那些 303 在 **`web` 插件的页面路由**上：表单 POST 到页面路径（`?action=` 取动作），
  成功 `303` 回跳、失败 `303` 带 `?err=&field=` 回跳，`fetch` 提交（侧栏拖动）回 `204`
  —— 都在 `packages/web/src/service.ts:326-382`。
- CLI 的 22 个调用点**没有一个**指向页面路径：全部是 `/api/` 前缀（可用 §5 的命令复现）。
- `/api/*` 里唯一的重定向是 `/` → `/console/usage`（`packages/api/src/http.ts:171-175`），
  那是浏览器入口页，CLI 从不请求。

### 3.2 唯一会让 CLI 坏的三类改动（写给 `交互` / `工具` 当红线）

1. **把 `/api/*` 的某个端点改成「浏览器友好」的 302/303**（例如未登录改成跳 `/login`）。
   CLI 的 `http.Client` **没有设 `CheckRedirect`**（`cmd/dizzy/client.go:94`），会静默跟随，
   POST 被降级成 GET，最后拿到 HTML 200 → 报「解析响应 JSON 失败」（退出码 1），
   而不是清晰的未登录（3/4）。要改先给 CLI 加「不跟随重定向」。
2. **改 `/api/usage/export` 的响应形状**（`{filename,content}` → `text/csv` 或别的字段名）。
   理由见 §2.4 第 12 条。
3. **改 `X-Requested-With` 的取值、或让 `/api/*` 对缺这个头的请求放行**。
   前者直接 403（`http.ts:215-224`），后者会削弱 CSRF 面。CLI 与 SPA 现在都用
   `dizzyapi`（`cmd/dizzy/client.go:19-22`），保持一致就没有冲突。

### 3.3 `X-Request-Id` 有两个来源（别混）

| 来源 | 谁发 | 值 | CLI 怎么用 |
|---|---|---|---|
| `GET/POST /v1/*` 的响应头 | Go `internal/httpapi` | 用量 `reqId`，如 `req-1793285027879642600-1` | `chat` 用它回查 `/api/usage/<reqId>`（`cmd_chat.go:218`、`usage_cost.go:62-75`） |
| 所有 `/api/*` 的响应头 | `api` 插件 | 8 字节随机 hex（`packages/api/src/http.ts:152`） | **不用**（与用量 reqId 无关） |

`api` 插件对**每个**响应都设这个头，所以「`/api/*` 也回 `X-Request-Id`」不等于「能拿去对账」。
CLI 只在 `/v1/*` 的响应上读它（`cmd/dizzy/client.go:147-151,225,238`），这是刻意的。

---

## 4. `/console/api-docs.md` 与 `/llms.txt`：CLI 侧零依赖

- **CLI 代码里没有任何引用**：`cmd/dizzy/*.go` 搜 `api-docs` / `llms.txt` / `console` 全部零命中
  （§5 命令可复现）。`--help`、错误提示、文档 `docs/cli.md` 也都不指向它们。
- 它们是**非 `/api/*`** 的机器友好副本，当前由 `web` 插件发（`packages/web/src/service.ts:250-259`），
  迁移到新前端插件后 **CLI 不受影响**——但只要它们还叫「给 agent 抓的」，建议新插件保住这两个路径
  （这是 `工具` 那条线的清单项，不需要 CLI 配合）。

---

## 5. 怎么复现这份清单

```powershell
cd E:\vibecoding\.dizzyapi-wt\cli-align
# 1) 所有 /api/ 调用点（去掉 _test.go 与注释行）
Select-String -Path cmd\dizzy\*.go -Pattern '"/api' | Where-Object { $_.Filename -notlike '*_test.go' }
# 2) API 插件里的全部重定向（期望只有 http.ts:171-175 一处 303）
Select-String -Path packages\api\src\*.ts,packages\api\src\routes\*.ts -Pattern 'writeHead\(30[23]|Location:'
# 3) CLI 是否引用文档副本（期望零命中）
Select-String -Path cmd\dizzy\*.go -Pattern 'api-docs|llms\.txt'
```

`cmd/dizzy` 的 `Client.Do` 对 `>=400` 一律转成 `APIError`（`cmd/dizzy/client.go:214-217`），
所以上表所有端点的**错误路径**都走同一个信封：`/api/*` 是 `{error:{code,message,requestId}}`
（`packages/api/src/errors.ts:5`），`/v1/*` 是 OpenAI 形状 `{error:{message,type,code}}`。

---

## 6. 未验证 / 不在本批次范围

- **未在真机生产验证**：以上判断来自代码与本地实测（`pnpm test` / e2e 全链路），
  没有对 `https://<站点域名>` 发真请求。生产 nginx 对 `/api/*` 的 `Host` 改写
  在 `AGENTS.md:668-671` 有记载；**`Origin` 对 `/api/*` 的改写我没核到配置**（仓库里没有 nginx 配置），
  这条留给部署线用真浏览器验。
- **不做**：本批次不改 CLI 代码、不改 `packages/api`、不改新前端工程、不碰 `app.yml` / nginx。
  上表里列出的「建议改」（如 `CheckRedirect`）都只是建议，没落地。
- **`chat` 只覆盖 `/v1/chat/completions`**：Anthropic / Responses / Gemini / Embeddings 四个入口
  没有 CLI 命令（`docs/cli.md` §9 已写明），所以「CLI 全绿」**不等于**「四个协议入口都验过」。
