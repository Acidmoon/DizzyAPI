# 前端 ↔ `/api/*` 契约表

> 这份表是**前端数据层的唯一事实来源**：SPA 只能调 `/api/*`，不碰存储、不直连 SQLite / JSON、
> 不用服务端渲染那套「表单 POST + 303」。
>
> **事实来源**：`packages/api/src/http.ts` 的 `routeApi()` 分派 + `packages/api/src/routes/*.ts`
> 的逐个 handler + `packages/api/src/views/*.ts` 的响应归一化函数。
> 本表逐条对着代码抄，**不是凭印象**；与服务端代码不一致时以代码为准，并回来改这张表。

---

## 1. 四个硬约束（错一条就是 403 / 空数据，而且症状都很具欺骗性）

| # | 约束 | 违反的症状 |
|---|---|---|
| 1 | 每个 `/api/*` 请求都要带 **`X-Requested-With: dizzyapi`**（**GET 也要**） | `403 API_REQUEST_HEADER_REQUIRED`，看着像「没登录」 |
| 2 | **同源**：`Host` 必须是 `127.0.0.1:<port>` / `localhost:<port>`，`Origin` 同源，`Sec-Fetch-Site` 不能是 `cross-site` | `403 API_HOST_FORBIDDEN` / `403 API_ORIGIN_FORBIDDEN` |
| 3 | 会话只走 **HttpOnly cookie `dizzyapi_session`**（`SameSite=Lax`、`Path=/`） | 前端**读不到也存不了**它；必须 `credentials: 'include'` |
| 4 | 错误信封固定 `{ error: { code, message, requestId } }`（404 / 405 / 403 也是这个形状） | 按 `code` 分支，别猜状态码文案 |

另外两条：

- **`/api/*` 全部回 `sendJson`（JSON）**，`packages/api/src` 里唯一的 303 是 `/` → `/console/usage`，
  **没有任何一个 `/api/*` 会 303**。所以 SPA 里 `fetch` 到 3xx 一定是出了别的问题
  （反代 / 登录页），客户端层因此用 `redirect: 'manual'`。
- 响应**没有 ETag / 条件请求**，重复请求要前端自己防（见 §5）。

---

## 2. 路由总表（按文件分组；「管理员」= 服务端 `requireAdmin`）

### 2.1 公开 / 会话

| 文件 | 方法 路径 | 说明 | 权限 |
|---|---|---|---|
| `http.ts` | `GET /api/health` | `GatewayHealthView`。**公开**，但**仍要带 `X-Requested-With`** | 无 |
| `http.ts` | `GET /api/session` | `{ user, email, session, permissions:{admin} }` | 会话 |
| `http.ts` | `GET /api/console/manifest` | 旧 SPA 清单；新 SPA **不需要**。frontend 插件缺席 → `503 FRONTEND_UNAVAILABLE` | 无 |

### 2.2 鉴权（`routes/auth.ts`）

| 方法 路径 | 入参 | 出参 | 备注 |
|---|---|---|---|
| `POST /api/auth/register/request` | `{ email, password, name? }` | `{ email, expiresAt, resendAfterMs }` | 发验证码；返回工单 |
| `POST /api/auth/register/confirm` | `{ email, code }` | `{ user, session }` | 成功后建会话 |
| `POST /api/auth/login` | `{ email, password }` | `{ user, session }` | 失败 401 |
| `POST /api/auth/logout` | 无 body | `{ ok: true }` | **幂等** |
| `POST /api/auth/password/reset/request` | `{ email }` | 服务端原样透传 | |
| `POST /api/auth/password/reset/confirm` | `{ email, code, password }` | 服务端原样透传 | |

**密码 / 验证码只走 body**：不进 URL（会进历史 / Referer / 反代日志）。

### 2.3 个人资料（`routes/profile.ts`）

| 方法 路径 | 入参 | 出参 |
|---|---|---|
| `PATCH /api/profile` | `{ name?, avatar? }`（至少一个字段） | `SessionUserView` |
| `POST /api/profile/password` | `{ currentPassword, newPassword }` | 服务端原样透传 |

### 2.4 API key（`routes/keys.ts`，用户侧）

| 方法 路径 | 入参 | 出参 | 备注 |
|---|---|---|---|
| `GET /api/keys` | — | `{ items: ApiKeySummaryView[] }` | 只有掩码 |
| `POST /api/keys` | `{ name }` | `ApiKeySummaryView & { secret }` | **`secret` 只此一次** |
| `PATCH /api/keys/:id` | `{ name?, enabled?, expiresAt?, spendingLimitMicros?, concurrencyLimit? }` | `ApiKeySummaryView` | 三个上限传 `null` = 不限 / 永不过期；金额是**字符串** |
| `POST /api/keys/:id/rotate` | 无 body | `ApiKeySummaryView & { secret }` | **`secret` 只此一次** |
| `DELETE /api/keys/:id` | — | `{ removed: true }` | |

### 2.5 用量（`routes/usage.ts`，用户侧）

| 方法 路径 | 查询串 | 出参 |
|---|---|---|
| `GET /api/usage` | `range`(`7d`\|`30d`\|`90d`，默认 `30d`)、`apiKeyId`、`model`、`cursor`(keyset)、`limit`(≤200，默认 20) | `UsageView` |
| `GET /api/usage/:reqId` | — | `{ record: UsageDetailRowView }` |
| `GET /api/usage/export` | 同 `GET /api/usage` | `{ filename, content }`（**JSON，不是文件流**） |

三条必须记住的：

1. **分页是 keyset**：`records.nextCursor`（整数）就是下一页要传的 `cursor`，**不是 offset**。
2. `GET /api/usage/:reqId`：**「查不到」与「不是自己的」统一 404**，前端不要据此猜记录是否存在。
3. 列表行**没有** `ttftMs` / `reasoningTokens` / `usagePresent`；也没有 `accountId` / `profile` / `attempts`
   （那些是管理面字段）。详情行才有前四个。
4. **顺序依赖**：`/api/usage/export` 必须先于 `/api/usage/:reqId` 判定，所以拼 URL 时不要把 `export`
   当成 reqId（客户端层已经按固定路径分开）。

### 2.6 价格与模型广场（`routes/pricing.ts`、`routes/models.ts`）

| 方法 路径 | 权限 | 入参 | 出参 |
|---|---|---|---|
| `GET /api/pricing` | 会话（任何登录用户） | — | `{ items: ModelPriceView[] }`（**含 `model`**） |
| `GET /api/pricing/:model` | 会话 | — | `ModelPriceView`（没有则 404） |
| `PUT /api/pricing/:model` | **管理员** | 4 个单价，字符串或数字 | `ModelPriceView` |
| `DELETE /api/pricing/:model` | **管理员** | — | `{ removed }` |
| `GET /api/models` | 会话 | `search`、`availability`(`all`\|`available`\|`unavailable`)、`priced`(`all`\|`priced`\|`unpriced`) | `ModelCatalogView` |

两处口径：

- 价格是**每百万 token 的元数**，十进制字符串；`currency` 恒为 `'CNY'`。
- 模型目录里嵌的价格是 `modelPriceViewOf()` 的输出，**不含 `model` 字段**（模型名在外层那一行）。
- `summary` 的键是 `availableCount` / `unavailableCount` / `pricedCount`（**带 `Count` 后缀**），
  不是 `available` / `unavailable`。

### 2.7 充值（`routes/topup.ts`，用户侧）

| 方法 路径 | 入参 | 出参 |
|---|---|---|
| `GET /api/topup/options` | — | `TopupOptionsView`（`currency/providerId/providerLabel/online/minAmountMicros/maxAmountMicros/expiresMinutes/notice`） |
| `GET /api/topup/orders` | `limit`(≤100) | `{ items: TopupOrderView[], total }` |
| `POST /api/topup/orders` | `{ amountYuan, provider?, note? }` | `{ order, instructions }` |
| `GET /api/topup/orders/:orderNo` | — | `TopupOrderView` |
| `POST /api/topup/orders/:orderNo/cancel` | 无 body | `TopupOrderView` |

**本批没有在线支付**：下单后是 `pending`，要管理员确认才到账。
所以「创建订单成功」**不等于**「充值成功」，前端只能提示「订单已创建，等待确认」。

### 2.8 兑换（`routes/redeem.ts`，用户侧）

| 方法 路径 | 入参 | 出参 |
|---|---|---|
| `GET /api/redeem` | `limit`(≤100) | `{ items: RedemptionView[] }`（只有 `codeMask`） |
| `POST /api/redeem` | `{ code }` | `{ amountMinor, balanceMinor, batchName }` |

兑换失败是**状态类拒绝**（409），`code` 为 `REDEEM_CODE_*`；**码本身不出现在错误消息里**。

### 2.9 用户管理（`routes/admin_users.ts`，**需要管理员**）

路径**不带 `admin` 前缀**，很容易走错。

| 方法 路径 | 入参 | 出参 |
|---|---|---|
| `GET /api/users` | `status`(`enabled`\|`banned`)、`offset`、`limit` | `{ items: AdminUserView[] }` |
| `GET /api/users/:id` | — | `AdminUserView`（`balanceMinor` 是字符串） |
| `PATCH /api/users/:id` | `{ name?, role?, status?, balanceEnabled?, concurrencyLimit? }` | `AdminUserView` |
| `POST /api/users/:id/balance` | `{ delta, reason }`（`delta` 是**十进制整数字符串**，可负） | `{ balanceMinor }` |
| `DELETE /api/users/:id` | — | `{ removed: true }` |

`PATCH` 按字段逐项 diff：没变的字段不写、不留审计；`concurrencyLimit: null` = 不限。

### 2.10 上游账号（`routes/admin_accounts.ts`，**需要管理员**）

| 方法 路径 | 入参 | 出参 |
|---|---|---|
| `GET /api/accounts` | `provider`、`status`、`cursor`(偏移)、`limit` | `{ items: AccountViewLike[], nextCursor: string \| null }` |
| `POST /api/accounts` | 账号字段 + `credential?` | `AccountViewLike` |
| `POST /api/accounts/import` | `{ source, payload, defaults? }` | 导入结果（`normalizeBulkImport`） |
| `POST /api/accounts/import/preview` | 同上 | 预检结果 |
| `GET /api/accounts/:id` | — | `AccountViewLike` |
| `PATCH /api/accounts/:id` | 可改字段 | `AccountViewLike` |
| `POST /api/accounts/:id/test` | `{ model?, protocol? }` | 连通性测试结果（含耗时） |
| `POST /api/accounts/:id/credentials` | `{ payload, format? }` | `AccountViewLike` |
| `DELETE /api/accounts/:id` | — | `{ removed: true }` |

`cursor` 是**偏移量的字符串**（`nextCursor = String(offset + size)`），不是 keyset。
**凭据只走 body**；响应里永远没有 `credentialRef` / 令牌。

### 2.11 管理面运维（`/api/admin/*`，全部需要管理员）

| 文件 | 方法 路径 | 查询串 / 入参 | 出参 |
|---|---|---|---|
| `admin_usage.ts` | `GET /api/admin/usage` | `range`、`userId`、`apiKeyId`、`model`、`status`(精确 HTTP 码)、`cursor`(keyset)、`limit` | `AdminUsageView`（含隔离区第一页 + 计数） |
| `admin_usage.ts` | `GET /api/admin/usage/export` | 同上 | `{ filename, content }` |
| `admin_usage_rejected.ts` | `GET /api/admin/usage/rejected` | `status`、`limit`、`offset` | `{ items, total, pending }` |
| `admin_usage_rejected.ts` | `POST /api/admin/usage/rejected/:reqId/ignore` | — | `{ reqId, status }` |
| `admin_usage_rejected.ts` | `POST /api/admin/usage/rejected/:reqId/replay` | — | `{ reqId, status, inserted? }` |
| `admin_billing.ts` | `GET /api/admin/billing` | `status`、`limit`、`offset` | `AdminBillingView` |
| `admin_audit.ts` | `GET /api/admin/audit` | `actor`、`actorPlugin`、`action`、`targetType`、`targetId`、`from`、`to`、`limit`、`offset`、`stats=1` | `{ items, total, offset, limit, stats? }` |
| `admin_observability.ts` | `GET /api/admin/observability` | — | `ObservabilityReport`（原样透传） |
| `admin_stats.ts` | `GET /api/admin/stats` | — | `{ generatedAt, users, accounts, keys, usage }` |
| `admin_content_audit.ts` | `GET /api/admin/content-audit` | — | `{ items, status }` |
| `admin_content_audit.ts` | `POST /api/admin/content-audit` | `{ pattern, action?, category?, enabled?, note? }` | `{ rule }` |
| `admin_content_audit.ts` | `GET /api/admin/content-audit/:id` | — | `{ rule }` |
| `admin_content_audit.ts` | `PATCH /api/admin/content-audit/:id` | 可改字段（`category`/`note` 传 `null` = 清空） | `{ rule }` |
| `admin_content_audit.ts` | `DELETE /api/admin/content-audit/:id` | — | `{ removed }` |
| `admin_content_audit.ts` | `POST /api/admin/content-audit/push` | — | `{ revision }`（立刻推给 Go 一次） |

`range` 只支持 `7d` / `30d` / `90d`（`USAGE_RANGE_DAYS`），**没有「今天 / 昨天」**。

### 2.12 充值订单 / 兑换码（管理面）

| 文件 | 方法 路径 | 入参 | 出参 |
|---|---|---|---|
| `admin_topup.ts` | `GET /api/admin/topup-orders` | `status`、`userId`、`from`、`to`、`limit`、`offset` | `{ items, total }` |
| `admin_topup.ts` | `GET /api/admin/topup-orders/stats` | — | `TopupStatsView`（只给数字，不给金额分布） |
| `admin_topup.ts` | `POST /api/admin/topup-orders/:orderNo/confirm` | — | `{ order, credited }` ← **真的加余额**，幂等 |
| `admin_topup.ts` | `POST /api/admin/topup-orders/:orderNo/cancel` | — | `TopupOrderView` |
| `admin_redeem.ts` | `GET /api/admin/redeem-codes` | `batch`(**不是 `batchId`**)、`status`、`keyword`、`limit`、`offset` | `{ items, total }` |
| `admin_redeem.ts` | `POST /api/admin/redeem-codes` | `{ name, amountMicro, count, expiresAt?, notes? }` | `{ batch, codes }` ← **`codes` 是明文，只此一次** |
| `admin_redeem.ts` | `DELETE /api/admin/redeem-codes` | **body `{ ids }`**（不是 `DELETE /:id`） | `{ deleted, rejected: [{id, reason}] }` |
| `admin_redeem.ts` | `POST /api/admin/redeem-codes/status` | body `{ id, status }`（不是 PATCH） | `{ ...code }` |
| `admin_redeem.ts` | `POST /api/admin/redeem-codes/resolve` | body `{ id, outcome }` | `{ ...code }` |
| `admin_redeem.ts` | `GET /api/admin/redeem-batches` | `limit`、`offset` | `{ items }` |
| `admin_redeem.ts` | `GET /api/admin/redeem-batches/:id` | — | 单个批次 |
| `admin_redeem.ts` | `GET /api/admin/redeem-stats` | — | `RedeemStatsView` |

`count` 在服务端是**必填**（1..100）：`optionalInteger` 之后还有一道 `undefined` → `badRequest`。

### 2.13 设置与目录

| 方法 路径 | 权限 | 入参 | 出参 |
|---|---|---|---|
| `GET /api/settings` | **管理员** | — | `{ namespaces: [{ id, title, fields: [{ key, label, type, value, writable }] }] }` |
| `POST /api/settings/:ns` | **管理员** | `{ patch, expectedRevision? }` | 更新后的命名空间 |
| `DELETE /api/settings/:ns` | **管理员** | — | 重置成 `app.yml` 基线后的命名空间 |
| `GET /api/catalog/modules` | **管理员** | — | `{ generatedAt, modules: CatalogModuleView[] }` |

`expectedRevision` 是**可选乐观锁**：版本变了回 `409 SETTINGS_CONFLICT`，前端应重新拉一次再让人改。
不带这个键时**不要把 `expectedRevision: undefined` 塞进 body**（服务端按 `Object.hasOwn` 判「给没给」）。

---

## 3. 一次性 secret 清单（**只出现在响应里，前端不许落任何存储**）

| 接口 | 字段 | 说明 |
|---|---|---|
| `POST /api/keys` | `secret` | 新建 API key 的明文 |
| `POST /api/keys/:id/rotate` | `secret` | 轮换后的新明文 |
| `POST /api/admin/redeem-codes` | `codes[]` | 兑换码批次的明文码 |

其余接口一律只给掩码（`maskedKey` / `codeMask`）。
**不许进 localStorage / sessionStorage / URL / console / 日志**——这是 §5.1 秘密纪律。

---

## 4. 后端缺口清单（前端绕不过去，要后端补；按价值排序）

1. **响应 DTO 是匿名返回类型，前端 import 不到**（最大的一条）。
   `views/*.ts` 里 `usageRowOf()` / `usageTotalsOf()` / `topupOrderOf()` / `redeemResultOf()` /
   `settleRecordOf()` / `rejectedRowOf()` / `modelCatalogOf()` / `contentAuditRuleOf()` 全是
   **直接返回对象字面量**，没有命名类型 → 前端只能**手抄**（本目录 `types/*.ts` 就是手抄的）。
   **建议**：把这些返回类型提成 `export interface XxxView`，从 `packages/api/src/index.ts` 导出。
   手抄的代价是「后端改了字段，前端编译不报错」——这正是本表要盯住的漂移。
2. **`index.ts` 只导出了部分 `*Like`**。已导出：`AccountViewLike` / `AdminUserView` /
   `ApiKeySummaryView` / `CatalogModuleView` / `GatewayHealthView` / `SessionUserView` /
   `SessionInfoView` / `Redeem*Like` / `TicketLike` / `UserLike` / `UserStatusLike` 等。
   **没导出**：`UsageRowLike`、`UsageTotalsLike`、`UsageQueryLike`、`TopupOrderLike`、`TopupOptionsLike`、
   `TopupStatsLike`、`SettleRecordLike`、`SettleTotalsLike`、`SettlePageLike`、`SettleSummaryLike`、
   `AuditRecordLike`、`AuditStatsLike`、`ContentAuditRuleLike`、`ContentAuditStatusLike`、
   `ModelCatalogLike`、`ModelEntryLike`、`ModelPriceLike`、`ModelUnavailableEntryLike`、`ObservabilityPort`。
   建议一并补进 `index.ts` 的 `export type {}`。
3. **`/api/admin/observability` 的 `ObservabilityReport` 定义在 `packages/observability` 里**，
   前端不依赖那个包 → 又得手抄一份（本目录 `types/admin.ts` 的 `AdminObservabilityView`）。
   建议由 `api` 包 re-export 这个类型。
4. **`GET /api/usage` 的 `balances.grantedCents` / `spentCents` 恒为 0**（服务端注释自己写
   「不在这里伪造」）。前端不要拿它们当历史消费，用 `totals.costMicros`。若产品要「累计消费」，
   需要后端补真实口径（现在只能自己 sum，而 sum 会被 `range` 截断）。
5. **响应无 `Cache-Control` / `no-store` 约定不一致**：`/api/console/manifest` 显式 `NO_STORE`，
   其余 `/api/*` 没有任何缓存头。SPA 里浏览器可能对 GET 做启发式缓存 →
   建议 `/api/*` 统一补 `Cache-Control: no-store`（尤其带会话数据的那批）。
6. **`/api/admin/redeem-codes` 的 `status` 查询串与 `POST .../status` 的 body 同名字段**：
   语义不同（筛选用状态 vs 要改成的状态）。不是 bug，但前端容易混；若后端愿意，
   `status` 查询串可以留、body 那个改叫 `nextStatus` 更清楚。
7. **没有「我的用量单条」与「导出」的限流 / 幂等**：导出上限 `ADMIN_USAGE_EXPORT_LIMIT` 只在
   管理面有常量，用户侧导出上限没在路由层写明。

---

## 5. 前端必须自己守住的事（后端不管）

1. **`X-Requested-With` 与 cookie 只能在一处集中做**：`app/src/lib/api/client.ts`。
   页面里**不许**自己 `fetch('/api/…')`。
2. **SPA 不能依赖服务端渲染的重定向**：写操作一律 `/api/*` 的 JSON 调用 +
   客户端三策略（`rollback` / `refetch` / `manual`，见 `mutations.ts`），
   同 key 串行（连点两下不会互相覆盖）。
3. **金额全程字符串 / BigInt**：`spendingLimitMicros` / `amountMicro` / `delta` / `costMicros` /
   `amountMinor` 都是十进制字符串。显示用 `money.ts`，**不许 `Number(x) / 1e6`**。
4. **一次性 secret 用完即弃**：只在一个弹窗里展示，关闭即清；不进 URL、不进存储。
5. **分页两套口径别混**：用量是 keyset（`nextCursor` 整数）；用户 / 账号 / 审计 / 结算 /
   充值订单 / 兑换码是 offset（`offset` + `limit`），`/api/accounts` 的 `nextCursor` 是**偏移量的字符串**。
6. **`export` 是保留子路径**：`/api/usage/export`、`/api/admin/usage/export` 不能被当成 `:reqId`。
7. **同源**：生产靠 nginx 把 `/api/*` 反代到 `api` 的 7791；本地开发**不要**让 Next 跨端口直连 7791
   （会 403）。要本地联通就让 Next 的 dev server 也走同源代理。
