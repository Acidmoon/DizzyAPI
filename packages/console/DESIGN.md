# 前端宿主 · 设计规格与后端契约

> 状态：**结构已对齐参考页源码；视觉层仍是自有实现。**
> owner 已从登录态 Edge 会话提取参考页真实 DOM / CSS（React + Rspack，`ds-*` 设计系统）。
> 我们**没有**把参考页的 CSS / JS / 图片 / 字体 / 真实账户数据复制进仓库；
> 只取结构、尺寸与 token，用本项目自己的类名与组件重写。参考文件在
> `E:\vibecoding\DizzyAPI\temp\`（主仓库 gitignored），不要复制：
>
> - `deepseek-usage-source.html` / `deepseek-api-keys-source.html` / `deepseek-topup-source.html`
> - `deepseek-usage-dom.html` / `deepseek-api-keys-dom.html` / `deepseek-topup-dom.html`
> - `deepseek-usage-source_files/8191.07cf805714.css`、`deepseek-css-extract.txt`

## 1. 路由与页面

一个 SPA，两块路由区（D13）：`/console`（用户站）与 `/admin`（管理台）。
源码路由是 `/usage`、`/api_keys`、`/top_up`、`/transactions`、`/profile`；
在 D13 的区域内落成：

| 页面 | 路径 | 状态 |
|---|---|---|
| 用量信息 | `/console/usage` | 已实现（3 余额卡 + 过滤行 + 3 指标卡 + 成本柱状图 + 按模型区块） |
| API keys | `/console/api_keys` | 已实现（说明区、创建按钮、表格、掩码 key、编辑/删除） |
| 充值 | `/console/top_up` | 已实现（tab、金额 chips、自定义、支付方式、去支付、订单结果） |
| 账单 | `/console/transactions` | 占位：源码有路由，但没有提供账单 DOM |
| 个人资料 | `/console/profile` | 已实现（头像 / 用户名 / 邮箱 / 角色 / 余额可见性 / 改密码） |
| `/console` | — | 前端重定向到 `/console/usage`（history replace，不发 HTTP 302） |
| 管理台用户 | `/admin/users` | 已实现（启停、角色、余额可见性、调整余额、删除；只对 admin 显示） |
| 管理台 | `/admin`、`/admin/catalog`、`/admin/accounts`、`/admin/strategies`、`/admin/settings` | 已实现或占位，沿用同一设计系统 |

## 2. 源码派生 token

深色是参考页的唯一模式；以下值来自 `body[data-ds-dark-theme]` 变量。

| 角色 | 值 | 用途 |
|---|---|---|
| bg-base | `#151517` | 页面背景 |
| bg-layer-1 | `#232324` | 表格 / 次级面板 |
| bg-layer-2 | `#2C2C2E` | hover、次级抬升 |
| bg-layer-3 / module-platform | `#353638` | 卡片、图表卡 |
| border-l1 | `rgba(255,255,255,.06)` | 卡片与分隔线 |
| border-l2 | `rgba(255,255,255,.12)` | 输入框、较强边界 |
| border-l3 | `rgba(255,255,255,.16)` | 浮层、强调边界 |
| label-primary | `#F9FAFB` | 主文本 |
| label-secondary | `#CFD3D6` | 次文本 |
| label-tertiary | `#ADB2B8` | 三级文本 |
| label-caption | `#81858C` | 说明、占位 |
| brand-primary | `#F9FAFB` | 亮色动作按钮（深色文字） |
| info / business | `#679EFE` | 信息态（当前只保留 token） |
| success | `#22C55E` | 正常 |
| warn | `#F59E0B` | 警告 |
| error | `#F25A5A` | 错误 |
| sidebar fill | `#1B1B1C` | 侧栏背景 |
| sidebar nav active | `#43454A` | 激活菜单 |
| sidebar nav hover | `#2C2C2E` | 悬停菜单 |

图表系列色单独取 `--chart-series`：深色 `#E0702A`、亮色 `#E06A1F`。
`#FD8D3C` 是 UI 强调色，但它在深色卡片上的 OKLCH 明度 0.752 超出图表明度带；
两个图表值都在卡片表面色上通过了 dataviz 校验（明度带 / chroma / 3:1 对比度）。
单序列不画图例；峰值直接标注，hover/focus tooltip 与表格视图都在。

**亮色模式**：源码没有提供。当前用镜像取值（纸面 `#F5F4F1`、卡片白、文字
`#1A1B1E`、边框 `#DCD9D2`），等 owner 确认后替换。

## 3. 排版与布局

- 字体：`Inter` + `system-ui` / `Segoe UI` / `Microsoft YaHei`；代码用
  `Menlo` / `Monaco` / `Consolas`。不 vendor 字体文件。
- 字号 / 行高：24/32（600，页面标题）、20/28（500）、16/24、14/22、
  13/20（正文）、12/18（说明）、11/14（caption）。
- 侧栏：`<aside>` 260px，padding 12px；菜单项 42px 高、14px 圆角、
  左右 16px、图标 21px + 10px 间距；菜单组 gap 2px；active `#43454A`，
  hover `#2C2C2E`。底部是四个次级链接 + 用户行（链接到 `/console/profile`）。
- 主列：滚动容器，padding 32px 40px；内容最大宽度 960px 居中；纵向节奏约 32px。
- 页面标题：24/32、600、margin-bottom 8px；说明 13/20、`#81858C`。
- 卡片：`bg-layer-3`、16px 圆角、20px padding、1px `border-l1`。
- 过滤行：margin 40px 0 24px，gap 16px；控件同排、导出右对齐。
- 指标行：gap 12px 16px，卡片 `flex: 1 0 304px`。
- 表格：面板 `bg-layer-1`，16px 圆角；表头 12/18，行高约 44px；
  行 hover `bg-layer-2`。
- 响应式：≤900px 侧栏折叠成顶部横向导航；≤640px 卡片单列、表格横向滚动。

## 4. 组件清单（按页面）

### 用量信息

1. 三张余额卡：充值余额 / 累计消费金额 / 赠送余额；第一张右侧“去充值”。
2. 过滤行：时间维度（7/30/90 天）、API Key、右对齐导出。
3. 三张指标卡：消费金额 / API 请求次数 / Tokens。
4. 成本柱状图卡：标题 + 当前指标合计 + 分段控件（调用类型 / API Key；
   当前实现用“消费金额 / 请求次数 / Tokens”切换，待后端支持分组维度后对齐）。
5. 按模型区块：每个模型一张卡片；源码里每个模型有请求次数面积图与
   Tokens 柱状图。当前先展示请求数 / Tokens / 消费金额；等 `UsageModelBreakdown`
   提供按日序列后补两张小图。
6. 账单 / 发票入口：`/console/transactions` 占位。

### API keys

1. 说明区：key 只在创建时可见一次，不要在浏览器/客户端代码里共享。
2. 右对齐亮色主按钮“创建 API key”；次级“按 API Key 查看用量”。
3. 表格：名称 / Tracking ID / 掩码 Key / 创建日期 / 最近使用 / 行内操作。
4. App-managed 条目带 `ds-tag` 风格的标记，编辑/删除禁用。
5. 创建对话框：名称输入 → 成功页显示完整 key 一次 + 复制 + “我已保存”。
   完整 key 只存在当前 dialog 的局部变量，关闭即丢；不写 localStorage / 日志 / URL。
6. 编辑只改名；删除二次确认。
7. 启停与轮换：停用 / 启用直接生效；轮换需要二次确认，成功后新 secret 只显示一次。

### 充值

1. 两个 tab：在线充值（实现）/ 对公汇款（占位，契约待定）。
2. 金额 chips：¥10 / ¥20 / ¥50 / ¥100 / ¥300 / ¥500 + 自定义；单笔 min/max 由
   `TopupOptions` 给出。
3. “查看价格”入口（当前 toast 占位）。
4. 支付方式：支付宝 / 微信支付，单选卡片；选中用强调色描边。
5. 整行亮色“去支付”按钮；订单结果卡展示订单号、金额、方式、状态、有效期。
6. 提示文案：充值到账与发票由 Go 支付模块负责；前端不接触支付凭据。

## 5. 还需要 owner 提供

1. **亮色模式**的参考（源码只有深色）。
2. **账单 / 发票页**的 DOM（路由是 `/transactions`，但源码没有提供页面内容）。
3. **个人资料页**的参考版式（页面已按通用表单实现，DOM 参考仍缺）。
4. 字体与图标：如果 Inter / 图标 sprite 是自托管资源，给路径；否则继续用系统字体与
   我们自己的线稿图标。
5. 登录 / 会话：已按 owner 方案实现（cookie 会话、401 回登录页、登出、admin 才能进
   `/admin`）；登录页的视觉参考仍缺。
6. 支付：真实渠道、订单轮询/回调、发票入口；对公汇款是否需要凭证上传。
7. 用量时区（参考页是 GMT+8）与数据延迟（参考页是 5 分钟）。
8. 导出格式与自定义时间范围。
9. 是否允许 API key 下载 / 多次查看（当前假设“只显示一次”）。

## 6. 后端接口（当前由 TS `api` 插件实现）

同源、会话 cookie；前端**不**发送 actor / 用户 id / 上游凭据。
所有 `/api/*` 都要 `X-Requested-With: dizzyapi`；Host / Origin / Sec-Fetch-Site 与面板
同一套闸，不发 CORS 头。错误统一 `{ "error": { "code": "…", "message": "…", "requestId": "…" } }`，
响应头带 `x-request-id`。金额一律整数分（D10）。

### 清单 / 静态资源

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/console/manifest` | 页面 / 设置卡 / 插槽，`no-store` |
| GET | `/assets/frontend/<version>/*` | 版本化资源，immutable |
| GET | `/console/*`、`/admin/*` | history fallback 到当前 `index.html`，`no-store` |

### 用量

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/usage?range=7d\|30d\|90d&apiKeyId=…` | `UsageResponse` |
| GET | `/api/usage/export?range=…&apiKeyId=…` | 导出流（格式待定） |

`UsageResponse`：`range / from / to / apiKeyId / balances{paidCents, grantedCents,
spentCents} / totals{costCents, requests, tokens} / daily[]{date, costCents, requests,
tokens} / models[]{model, requests, tokens, costCents, daily?} / generatedAt`。
`daily?` 是给按模型小图用的可选序列。

### API keys

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/keys` | `{ items }`，永不返回完整 key |
| POST | `/api/keys` | `{ name }` → `CreatedApiKey`（服务返回 `{ key, secret }`，HTTP 层展开；仅此一次含 `secret`） |
| PATCH | `/api/keys/:id` | `{ name?, enabled? }`，改名 / 启停 |
| POST | `/api/keys/:id/rotate` | 轮换。服务返回 `{ key, secret }`，HTTP 层展开成扁平 `CreatedApiKey`（仅此一次含 `secret`） |
| DELETE | `/api/keys/:id` | 吊销，`{ removed: true }` |

### 充值

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/topup/options` | 金额 chips、min/max、支付方式、提示 |
| POST | `/api/topup/orders` | `{ amountCents, method }` → `TopupOrder` |
| GET | `/api/topup/orders/:id` | 轮询状态（待实现） |

### 管理台

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/accounts?provider=&status=&cursor=&limit=` | 账号元数据，无 token / credentialRef |
| POST | `/api/accounts` | `{ provider, kind, label, credential? }` 新建账号；凭据可留空 |
| GET/PATCH/DELETE | `/api/accounts/:id` | 元数据、启停、移除 |
| GET | `/api/catalog/modules` | 插件 / 模块状态与贡献页面 |
| GET | `/api/settings` | `{ namespaces }` 原样透传（秘密只有 `configured`） |
| POST | `/api/settings/:ns` | `{ patch, expectedRevision? }`，actor 由服务端会话决定 |
| DELETE | `/api/settings/:ns` | 恢复基线 |
| GET | `/api/health` | 网关状态、版本、描述符 revision、桥、组件 |
| GET | `/api/session` | `{ user, email, session, permissions:{admin} }`；余额只在允许时返回 |
| PATCH | `/api/profile` | `{ name?, avatar? }` → `SessionUser`。头像接受 `http(s)://` URL（≤2048）或 png/jpeg/webp/gif data URL（解码后 ≤256 KiB）；CSP 只放行 https 外链 |
| POST | `/api/profile/password` | `{ currentPassword, newPassword }` |
| GET | `/api/users?status=&offset=&limit=` | 管理台用户列表；余额是最小单位字符串 |
| GET/PATCH/DELETE | `/api/users/:id` | 用户详情 / 状态 / 角色 / 余额开关 / 删除 |
| POST | `/api/users/:id/balance` | `{ delta, reason }`，delta 是十进制最小单位字符串 |
| POST | `/api/accounts/:id/credentials` | 导入凭据；响应不含令牌 |
| POST | `/api/accounts/import` / `import/preview` | 批量导入 / 预检；响应不含令牌 |

## 7. 清单模型与自动隐藏

- 内置清单在 `src/manifest.ts`；插件也可运行期
  `frontend.registerContributions(owner, { pages, settingsCards, slots })`。
- owner 可以是 app.yml entry id 或包名；服务从 `ctx.loader.entries()` 取启用集。
  禁用插件的页面 / 设置卡 / 插槽自动消失，不需要改前端代码。
- `PageView` 支持 `overview / usage / keys / topup / redirect / accounts / catalog /
  settings / placeholder / remote`。`remote` 给插件自带同源 ESM 模块：默认导出
  `mount(root, { api, page, manifest, href, navigate })`，可返回 cleanup。
- 设置卡只声明 `namespace`，通用设置渲染器读取 `/api/settings`。

## 8. 静态资源与产品 HTTP 入口 / 反代集成

前端插件把内置资源安装到 `<dataPath>/versions/<version>/`，原子写
`<dataPath>/current.json`（`{ current, previous, updatedAt }`），并写
`manifest.json` / `state.json`。推荐规则：

1. `/assets/frontend/<version>/*` → `versions/<version>/*`，跳过点文件，
   `Cache-Control: public, max-age=31536000, immutable`。
2. `/console/*`、`/admin/*` → `versions/<current>/index.html`，`no-store`。
3. `/api/console/manifest` → `manifest.json`，`no-store`。
4. CSP：`default-src 'self'; script-src 'self'; style-src 'self';
   img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'`。
   头像允许 `data:` 与 `https:` 外链；`http://` 头像不支持。
5. 前端插件被禁用时 `state.json.enabled=false`；`api` 插件据此对静态与 SPA 返回 404
   （`/api/health` 仍可用），反代也可据此硬门禁。
6. 不要把 LLM 请求、凭据或控制桥挂在同一条路径上。

`packages/api` 已按上面 1..6 实现；Go / 反代将来接同一份文件契约即可。

回滚只改 `current.json` 指针；旧版本默认保留一个，`keepVersions` 控制总数。

## 9. 开发预览

```bash
pnpm preview:console
# http://127.0.0.1:7790/console
```

只绑 `127.0.0.1`、强制 mock 数据、不提供 `/api/*`、不读凭据。它是开发工具，
不是产品运行时。

## 10. 非目标

- 不 vendor / 复制参考项目的 CSS、JS、图片、字体、logo 或真实账户数据。
- 不在 `frontend` 宿主里起产品 HTTP 服务；产品入口是独立的 `api` 插件（owner 2026-10-19 定）。
- 不在前端存储或转发上游 OAuth 令牌、SMTP 授权码、支付凭据。
- 不把 API key 完整值写进 localStorage、日志、URL 或错误上报。
