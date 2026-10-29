# DizzyAPI · Agent 开发手册

> **Owner 主导开发。** 本文件是 agent 的工作规范与项目地图：怎么拆任务、怎么建 worktree、
> 哪些边界不能碰、怎么验证。设计判断以 owner 的指示为准；本文件与代码不一致时以代码为准，
> 并顺手把本文件改对。记录性事实直接改；涉及设计判断的先问 owner。

**一句话**：DizzyAPI 是自托管模型网关——**cordis 决定「什么在运行」，Go 决定「流量怎么走」**。
开发一律遵循 cordis「万物皆插件」：能力做成插件，可启用 / 禁用 / 热重载，禁用后不留残余。

---

## 1. 开发方式

### 1.1 Owner 主导

- 需求由 owner 提出；agent 负责把需求落成插件 / 模块 / 测试。
- 架构取舍（新增一层、改数据归属、改协议）先问 owner，不自行拍板。
- 不要凭本文件去推翻 owner 的决定或已在运行的代码。
- 记录性修正（现状、命令、踩坑）直接写进本文件；设计说明不往这里堆。

### 1.2 worktree + 子代理（默认开发范式）

owner 说「实现若干个插件 / 功能」时，按下面流程：

1. **拆任务**：结合 owner 的想法和当前代码，列出插件边界、依赖顺序、每个 worktree 的范围。
   先给 owner 一个简短拆分方案，确认后再分派。
2. **建 worktree**：每个插件 / 功能一个 worktree，一个子代理。
   - 并行派多个时用子代理自带的 worktree 隔离（Agent 工具创建），**不要**用主会话的
     `EnterWorktree`：后者会把主会话自己挪进那个 worktree，一次只能待一个，做不了并行。
   - **子代理的 worktree 从 `origin/main` 切，不是本地 `main`**。派活前先 `git push`，
     否则子代理会在旧基底上开工——本项目踩过：TS 侧那个代理在一棵还没有 `protocol` 的树上
     做了 `models` 字段，合并时 61 处冲突要靠手工解。
     （Go 侧那个代理自己发现并 `git merge --ff-only main` 修好了，可以在 prompt 里直接写上这句。）
   - 分支命名与 owner 的意图一致（如 `feat/user-system`）。
   - **子代理默认继承主会话模型**：分派时不要传 `model` 覆盖。
3. **写子代理 prompt**：必须自包含，至少包含：
   - 目标插件 / 功能、做什么、不做什么；
   - 相关现有插件、服务名、文件路径；
   - 必须遵守的边界（秘密、存储写者、禁用回收、错误码）；
   - 必须跑的验证（`pnpm typecheck` / `pnpm test` / `pnpm test:go`）；
   - 提交规则（见 §1.3）。
4. **逐分支审查合并**：owner 要求「先逐分支审查合并」时，逐个分支看 diff、跑测试、
   再合并；不要一次性全合。
5. **清理**：已合并的 worktree 可删除，分支保留，除非 owner 另有指示。

### 1.3 提交规则

- 提交署名是 owner 本人（`Dzy`）。
- **禁止** `Co-Authored-By`、`Signed-off-by`、"coworker" 或任何署名 trailer。
- 只有 owner 明确说「提交 / 推送 / 部署」才执行对应动作。

---

## 2. 技术路线

### 2.1 三层职责

| 层 | 负责 | 不负责 |
|---|---|---|
| cordis（TS） | 插件生命周期、启用 / 禁用、依赖顺序、可逆回收、管理台、设置 | 请求处理、转发、计费、直连业务库 |
| Go gatewayd | LLM 请求链路、上游转发与流式、鉴权、额度与计费、用量落库 | 决定启用哪些模块 |
| 前端插件 | 静态资源版本与挂载、聚合管理页与设置卡 | 静态字节之外的请求路径 |

三类流量术语固定为 **LLM 请求**、**控制消息**、**界面请求**；「请求」单独出现时只指 LLM 请求。
桥不承载 LLM 请求；三类流量不共用队列、锁、限流器、连接池与日志。

### 2.2 万物皆插件（TS 侧）

- 每个能力一个包：`packages/<name>`，对外是 cordis Service。
- 插件基本形态：

```ts
export class FooService extends Service {
  static Config = FOO_CONFIG_SCHEMA
  static inject = ['user', 'mailer']
  static catalog = { capabilities: ['foo'], events: [], bridge: [] } as const

  constructor(ctx: Context, config: ResolvedFooConfig) {
    super(ctx, 'foo')
    // 注册即副作用：定时器 / 监听 / 子进程 / DB 连接都挂 ctx.effect
    ctx.effect(() => () => this.close(), 'foo.store')
  }
}

export default FooService
```

- 依赖用 `static inject`；依赖没满足时 fiber 停在 PENDING，不构造也不报错。
- 注册的一切必须可逆：卸载 / 禁用时回收监听、定时器、子进程、数据库连接。
- **禁用必须同时闸住四个入口**：链路阶段、HTTP 路由、后台任务、桥命令。
- 插件间只通过服务接口 / 进程内事件通信，不直接 import 另一个插件的实现。
- 服务类成员用 TS `private`，**不要用 `#` 私有字段**（cordis 用 Proxy 作 receiver）。

### 2.3 Go 侧

- `contracts/` 只依赖标准库，是唯一可被所有模块 import 的包。
- `modules/*` 只 import `contracts/`，**严禁**互相 import。
- `cmd/gatewayd/main.go` 是唯一组装点；去掉一行 `Register` 即少一个模块。
- 阶段型模块按 pre → dispatch → post 顺序执行；每个阶段显式声明失败策略，默认 deny。
- 数据面模块不决定启用集；启用集由 cordis 下发（v1 目前是固定阶段集，描述符仍待实现）。

### 2.4 硬边界

1. **秘密只在 `credentials`**：账号记录、设置、`app.yml`、日志、HTTP / 桥响应不得出现秘密值。
   `credentials.resolve` 与 `identity.getAccessToken` 是进程内 seam，**不得挂 HTTP**。
2. **一个数据一个写者**：用户 / 余额 / 凭证 / 会话 / API key / 上游账号各有唯一写者；
   需要读时用服务接口或桥命令，绝不跨层直连写入。
3. **余额用整数最小单位 / bigint**，禁止浮点。
4. **计费不得事件驱动**；扣费在 post 相位按真实 usage 结算。
5. **配置非法时明确失败**，不静默降级；默认 fail-closed。
6. **许可证纪律**：new-api 是 AGPL-3.0、sub2api 是 LGPL-3.0，只能读设计，不得复制代码；
   cordis / magpie 是 MIT，可借鉴与 vendor。

---

## 3. 可以参考的项目

| 项目 | 许可 | 参考什么 |
|---|---|---|
| [sub2api](https://github.com/Wei-Shaw/sub2api) | LGPL-3.0 | 账号池、订阅配额分发、渠道管理、前端表单的信息架构 |
| [new-api](https://github.com/QuantumNous/new-api) | AGPL-3.0 | 多渠道聚合、模型映射、额度与计费、渠道配置字段 |
| [yetone/magpie](https://github.com/yetone/magpie) | MIT | provider / account 模型、本地优先、网关进程管理 |
| [cordiverse/cordis](https://github.com/cordiverse/cordis) | MIT | 插件生命周期、Service、inject、effect、HMR |

参考时**看源码里的 schema / 表单 / API 字段**，不要只看截图或 README 摘要。
只能借鉴设计，不能复制 AGPL / LGPL 代码。

---

## 4. 现状地图

### 4.1 TS 插件（29 个包；`console` 是已禁用的 SPA，`kit` 是共用底座）

| 包 | 服务 | 职责 |
|---|---|---|
| `@dizzyapi/plugin-user` | `user` | 用户表单（名称 / 状态 / 角色 / 余额 / 余额开关 / 头像）唯一写者；SQLite `users.db` |
| `@dizzyapi/plugin-auth` | `auth` | 注册（邮箱验证码）/ 登录 / 会话 / 改密 / 重置；SQLite `auth.db` |
| `@dizzyapi/plugin-api-key` | `apiKey` | API key 唯一写者；SQLite `api-keys.db`；完整 key 落库，用户列表可复制 |
| `@dizzyapi/plugin-mailer` | `mailer` | 发邮件；`log` / `smtp` 两种投递 |
| `@dizzyapi/plugin-credentials` | `credentials` | 秘密唯一存放处；别的插件只持有引用名 |
| `@dizzyapi/plugin-identity` | `identity` | 上游账号与令牌刷新；`accounts.json` + `credentials` |
| `@dizzyapi/plugin-account-admin` | `accountAdmin` | identity 的管理门面：新建 / 修改 / 导入凭据 / 启停 / 删除 / 批量改字段 / 标签与健康过滤 |
| `@dizzyapi/plugin-account-health` | `accountHealth` | 定时健康检查：连续失败自动停用、一次成功即恢复；**只经 account-admin 门面写**，自己不存数据 |
| `@dizzyapi/plugin-account-priority` | `accountPriority` | 策略组唯一写者；拉起 gatewayd；推送账号与 key 快照 |
| `@dizzyapi/plugin-redeem` | `redeem` | 兑换码唯一写者：批次 / 生成 / 兑换 / 启停 / 人工核查；SQLite `data/redeem.db`；**只落 sha256 与末 4 位掩码**，明文只在生成响应出现一次；加余额只经 `user.adjustBalance` |
| `@dizzyapi/plugin-billing` | `billing` | 真实扣费的唯一执行者：`usage` 每轮拉到用量后调 `settle`，按 `req_id` 幂等（CAS `pending → settling → settled`）、用 `pricing` 复算整数微元、只经 `user.adjustBalance` 扣款（余额允许为负 = 后付费，记 `overdrawn` + 扣后余额）；SQLite `data/billing.db`；**不预扣、无支付通道** |
| `@dizzyapi/plugin-topup` | `topup` | 充值订单唯一写者：`manual` 人工到账（下单 / 我的订单 / 取消 / 管理面确认到账与统计），`pending → paid / canceled / expired` 条件更新，到账只经 `user.adjustBalance`；SQLite `data/topup.db`；**支付通道只留 `PaymentProvider` seam，不接真实渠道、不挂回调路由** |
| `@dizzyapi/plugin-quota` | `quota` | 余额只读快照推送：把 `user` 的全量余额**心跳式**周期（默认 5s，内容不变也推、`generation` 递增）+ 变更后 debounce（1s）推给 Go 的额度闸门（桥命令 `quota.replace`）；`status()` 报 `heartbeats` / `failureStreak` / `goTtlMs` / `heartbeatTooSlow`；**不存数据、不写余额、不做判断**，也不拥有控制桥（桥在 `account-priority`） |
| `@dizzyapi/plugin-modelhub` | `modelhub` | 模型广场聚合（**只读、不落盘**）：把 `pricing` 的价格 + 账号声明的 `models`/`modelMap` + `protocol`/`health`/凭据状态合成模型目录，区分 `available` / `unavailable`（带原因）；`/api/models` 与 `/console/models` 的数据源；账号 id / label / baseUrl 一律不出 |
| `@dizzyapi/plugin-audit` | `audit` | 审计日志唯一写者：`data/audit.db`；`record`（不限）/`list`/`stats`（要 actor 在 `adminPlugins`）；高危管理员写操作在**成功后**接线留痕（actor / action / target / 结果 / 脱敏 metadata），每日按 `retentionDays`（默认 180）分批清理；**不 inject**，审计失败不影响业务 |
| `@dizzyapi/plugin-observability` | `observability` | 运维总览聚合（**只读、不落盘**）：把用量链路（`usage.status` + `usage.stats`）、结算各状态与透支、额度快照新鲜度（`quota.status`）、账号运行时（`accounts.status.runtime`）、审计最近动作（`audit.list/stats`）、账号池健康合成一个 DTO；任一源缺席只降级该块，页面 `degraded` 但仍 200；`/admin/observability` + `/api/admin/observability` |
| `@dizzyapi/plugin-content-audit` | `contentAudit` | 内容审核规则的唯一写者：`data/content-audit.json`；规则**心跳式**推给 Go 的 pre 相位审核闸门（桥命令 `contentaudit.replace`，内容不变也推、`revision` 相同 `generation` 递增；审核关闭时推 `enabled:false` + 空规则），命中统计从 `contentaudit.status` 读回；只做**大小写不敏感子串匹配**（不做正则）；`/admin/content-audit` + `/api/admin/content-audit`；**对 `audit` 零依赖**（留痕在 `api` / `web` 的调用点） |
| `@dizzyapi/plugin-catalog` | `catalog` | 插件能力目录（只读，反射 + 声明） |
| `@dizzyapi/plugin-frontend` | `frontend` | SPA 静态资源版本 / 清单 / 回滚（**已禁用**，由 `web` 取代） |
| `@dizzyapi/plugin-api` | `api` | 产品 HTTP 入口：SPA + `/api/*`，进程内调用控制面服务 |
| `@dizzyapi/plugin-settings` | `settings` | 运行期配置覆盖；`app.yml` 是基线 |
| `@dizzyapi/plugin-admin` | `admin` | 开发者面板：依赖图、概览、改设置、重启插件、退出 |
| `@dizzyapi/plugin-pricing` | `pricing` | 模型价格表唯一写者：每百万 token 的单价（元，十进制字符串）；`data/pricing.json`；读不设限，写要求 actor 在白名单 |
| `@dizzyapi/plugin-usage` | `usage` | 用量明细唯一存储者：轮询 Go 的 `usage.since`（默认 1s）、幂等落 `data/usage.db`、按用户/管理员口径查询；一轮顺序是「拉取 → 落库 → 结算 → 推进游标」，坏记录进 `usage_rejected` 隔离表（管理面忽略 / 重放）；费用在**读取时**按 pricing 计算 |
| `@dizzyapi/plugin-kit` | — | 共用底座：配置 schema + 原子写 JSON 存储 |
| `@dizzyapi/plugin-deepseek-usage` | `deepseekUsage` | 独立成页的「用量信息」页（DeepSeek 开放平台用量页的像素级复刻）：自起 `127.0.0.1:7793`；**已禁用**，保留为像素级参考 |
| `@dizzyapi/plugin-page-template` | `pageTemplate` | 页面模板：从 deepseek-usage 原样抽出的设计 token、侧栏/卡片/表格/表单、堆叠柱状图与面积折线图、线性图标；纯服务，不起 HTTP、不读写存储 |
| `@dizzyapi/plugin-web` | `web` | 服务端渲染前端：**一页一个文件**（`packages/web/src/pages/*.ts`），数据走进程内服务，写操作是表单 POST + 303；监听 `127.0.0.1:7792` |
| `@dizzyapi/plugin-font-smiley` | `fontSmiley` | 站点字体：自托管 Smiley Sans（得意黑）v2.0.1，OFL-1.1；纯资源服务，web 追加 `@font-face` 并发 `/assets/fonts/smiley-sans.woff2` |

### 4.2 Go 模块

| 路径 | 职责 |
|---|---|
| `contracts/` | 唯一共享契约；`Ctx` / `Stage` / `Decision` / `Registry` / DTO；规范化 IR 与 `Codec` 接口（`ir.go` / `protocol.go`，含 `ProtocolGemini`）；**`Operation`（`Ctx.Operation`，零值 = chat，只有 embeddings 路由写它）**；用量记录与桥事件（`usage.go`）；Gemini 模型名归一（`gemini.go`，入口与上游共用）；只依赖标准库 |
| `modules/accountpriority/` | 账号打分、排序、选择；候选全被闸门挡住时区分 `ALL_ACCOUNTS_SATURATED` / `ALL_ACCOUNTS_COOLING`（都是 503、不可重试） |
| `modules/quotagate/` | pre 相位额度闸门：按 `ctx.Key.UserID` 查余额只读快照，余额 ≤ 阈值（默认 0）返回 402 `INSUFFICIENT_BALANCE`（不可重试、不转发上游）；快照未就绪 / 过期默认放行 + 告警，`-quota-require-snapshot` 打开严格模式则 503 `QUOTA_SNAPSHOT_UNAVAILABLE` |
| `modules/modelroute/` | 模型路由（pre 相位按账号 `models` 过滤候选）+ 模型映射（dispatch 相位按账号 `modelMap` 改写 body 顶层 `model`） |
| `modules/protoconv/` | 协议转换中间件：dispatch 相位阶段（请求方向）+ 响应转换器；Chat / Responses / Anthropic / **Gemini（含流式）** 四个 codec |
| `modules/transport/` | 按选中账号发上游请求，透传普通响应与 SSE；按协议的方言表决定路径、鉴权头、流式路径与查询串（Gemini：`/models/{model}:generateContent`、`x-goog-api-key`、流式 `:streamGenerateContent?alt=sse`，`{model}` 只放归一后的裸名；**`EmbeddingsPath` 供 `/v1/embeddings` 按 `Ctx.Operation` 选路径**）；429 / 额度耗尽记账号冷却并回可重试错误 |
| `modules/keyauth/` | 动态 API key 哈希快照校验 |
| `modules/contentaudit/` | pre 相位内容审核闸门（`NeedBody()=true`，注册在 keyauth 之后、quotagate 之前）：只审**用户输入文本**（chat / anthropic 的 `role=user`、responses 的 `input`、gemini 的 `contents`、embeddings 的 `input`），命中 `block` 规则 → **403 `CONTENT_BLOCKED`（不可重试、不转发上游）**，命中 `log` 规则 → 放行 + 计数 + 日志（只记 ruleId / category，**绝不回显被审文本**）；快照未就绪 / 过期默认放行 + 计数，`-content-audit-require-snapshot` 严格模式才 503 `CONTENT_AUDIT_SNAPSHOT_UNAVAILABLE`；解析失败 / 无可审文本放行；单请求扫描上限 256 KiB（`truncated` 计数暴露） |
| `internal/bridge/` | 控制桥：长度前缀 JSON、UDS / 回环 TCP、优雅关闭 |
| `internal/engine/` | pre → dispatch → post 调度；失败转移；统一错误渲染；**并发闸门**（dispatch 前按 `concurrency` 原子预留，预留失败换下一个账号、全饱和直接 503 不排队） |
| `internal/accounts/` | 账号 / 令牌只读快照缓存 |
| `internal/accountruntime/` | 账号运行时状态（纯进程内）：真实 in-flight 计数 + 429 / 额度耗尽短期冷却；`Apply` 把真实值写进候选快照给打分用、`Acquire` 原子预留槽位（release 幂等）；不落盘、不上桥、不回写 TS |
| `internal/apikeys/` | API key 哈希快照缓存；`Ready()` 区分「没收到」与「空快照」 |
| `internal/quota/` | 余额只读快照缓存：`Ready()` / `Lookup()` / `Age()` / `Stale()` / `State()`；金额是十进制 bigint 字符串，整份校验、任一条不合法整份拒绝；`generation` 回退明确拒绝（不覆盖旧快照） |
| `internal/contentaudit/` | 内容审核规则快照缓存：`Snapshot{version,generation,revision,enabled,rules}`；规则**预编译成小写子串**（`Rule.pattern` ≤ 200 字节，≤ 500 条，`id` ≤ 64）；整份校验、任一条非法整份拒绝，`generation` 回退拒绝不覆盖、同代同 revision 幂等；`Match` 返回 `[]contracts.ContentAuditHit`；`State()` 给 `contentaudit.status`（含 `gate` 计数与按规则命中） |
| `internal/usagelog/` | 用量环形缓冲（容量可配，默认 32768，边界 1..1048576，非法值启动失败；满了丢最旧并计数 `dropped`，其中「没被任何 reader 取走就被覆盖」单独记 `gap`）；`Seq` + `Epoch`，经 `usage.since` 给 TS 轮询，`usage.stats` 给 TS 告警 |
| `internal/usageprobe/` | 用 codec 从**发回客户端**的响应字节里提取 usage（流式只观察不改字节）；按上游协议归一化四桶 |
| `internal/metrics/` | Prometheus 文本指标（只在回环监听、`-metrics` 默认开）：请求数与耗时、四桶 token、上游尝试/失败（按固定错误码枚举）、in-flight、冷却账号数、用量缓冲 dropped/gap、额度快照 age；热路径只有 `atomic.Uint64` 加法，标签只用编译期常量 |
| `internal/httpapi/` | `POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages`、**`POST /v1beta/models/{model}:generateContent` 与 `:streamGenerateContent`（Gemini，模型名在路径里，自己解析、拒绝路径穿越）**、`POST /v1/embeddings`、`GET /v1/models`、`GET /healthz`、`GET /metrics`；请求结束写用量记录；响应（**含整个流**）写完后释放并发槽位；回写 `X-Request-Id` 响应头（只在有真实 requestID、即会产生用量记录时才发） |
| `cmd/gatewayd/` | 组合根：注册模块、启动 HTTP 入口与控制桥 |

### 4.3 数据与端口

- 数据：`data/users.db`、`data/auth.db`、`data/api-keys.db`、`data/accounts.json`、
  `data/credentials.json`、`data/settings.json`、`data/account-priority.json`、
  `data/pricing.json`、`data/usage.db`、`data/redeem.db`、`data/billing.db`、`data/topup.db`、
  `data/audit.db`、`data/content-audit.json`、`data/frontend/`。
- 用量只有 `usage` 插件写 `usage.db`（含 `usage_rejected` 隔离表）；结算账本只有 `billing`
  插件写 `billing.db`；充值订单只有 `topup` 插件写 `topup.db`（加余额只经 `user`）；
  价格只有 `pricing` 插件写 `pricing.json`；
  内容审核规则只有 `content-audit` 插件写 `content-audit.json`（规则是关键词，不含秘密）；
  兑换码只有 `redeem` 插件写 `redeem.db`（只存 sha256 与掩码）；
  Go 只把用量放进内存环形缓冲、把规则快照放内存，不落盘。
- 本地端口：`web` `127.0.0.1:7792`（服务端渲染前端）、`api` `127.0.0.1:7791`、
  gatewayd `127.0.0.1:8080`、面板 `127.0.0.1:7788`。旧的 `frontend` SPA 与
  `deepseek-usage`（7793）已禁用。
- 生产服务器：`<生产服务器>` / `<SERVER_IP>`，gatewayd `127.0.0.1:18080`，入口
  `https://<站点域名>`（宝塔 nginx `80/443`）；`sub2api` 并存于 `127.0.0.1:8080`
  （`<站点域名>`），不要动。

### 4.4 已实现的能力

- 用户注册 / 登录 / 会话 / 改密 / 头像 / 角色与余额开关
- 用户 API key：创建 / 改名 / 启停 / 轮换 / 删除 / 列表复制完整 key
- 上游账号池：新建 / 编辑（含 Base URL、优先级、上游协议）/ 导入凭据 / 启停 / 删除；
  每个账号可做**连通性测试**（发一条最小真实请求，结果与耗时写回账号）；
  批量导入支持 new-api Channel JSON、sub2api 导出文件、一行一个 key（未知渠道类型明确失败）
- 账号运营字段与调度联动（五段链路：identity → account-admin → account-priority 快照类型与推送
  → Go `internal/accounts` → `modules/accountpriority`，`contracts/` 与 `modules/` 未改）：
  - **多标签** `labels: string[]`（不做分组实体）；快照里按约定转成 Go 的 `tags`
    （`key:value` → `{key: value}`，纯标签 → `{标签名: ''}`，同一 key 先出现的胜出）
  - **权重** `weight`、**并发上限** `concurrency`、**健康状态** `health`
    （`unknown / healthy / degraded / unhealthy`，未知是一等状态）
  - `status` 增加 `auto_disabled`：人的手动停用仍是 `enabled=false`，系统自动停用是
    `status=auto_disabled`，两者互不覆盖
  - 批量改标签 / 权重 / 并发 / 优先级与批量启停；列表支持标签（AND）与健康过滤，
    列表页走精简 DTO（`list(query, { view: 'lite' })`），详情页分组折叠
- 自动健康检查（`account-health`）：定时连通性测试，连续失败 3 次自动停用、
  一次成功即恢复；只经 `accountAdmin` 门面写，自己不存数据，禁用即停定时器
- `lastUsedAt` 回报：`usage` 落库后发 `usage/account-used`（集合化），
  `account-admin` 聚合节流 30 秒后经 identity 的 `reportUsed` 写回
- 账号优先级策略与 gatewayd 监管；账号与 key 快照推送
- 兑换码与兑换额度（`redeem`）：批次生成（1–100 张、单批事务）/ 列表（只给末 4 位掩码）/
  停用启用 / 批量删除（拒删已用）/ 统计 / 人工核查；用户面 `POST /api/redeem` 兑换进余额
  （整数微元，走 `user.adjustBalance`）；`/console/redeem` 与 `/admin/redeem-codes` 两个页面，
  明文码只在生成后的一次性区块出现（`stashSecret`，5 分钟）。
  **幂等靠 CAS**：`enabled → redeeming → used` 条件更新，并发下同一码只有一次能加钱；
  跨库（`redeem.db` / `users.db`）不能同一事务，所以 `redeeming` 崩溃残留**不自动回收**，
  由管理页人工核查「标记为已用 / 退回可用」
- 协议转换：客户端按入口路径声明协议（`/v1/chat/completions` → openai-chat、
  `/v1/responses` → openai-responses、`/v1/messages` → anthropic），网关按选中账号声明的
  `protocol` 自动翻译请求与响应（含流式）；同协议直通不做任何改写
- 模型路由与模型映射：账号声明 `models`（服务的对外模型名）与 `modelMap`（对外名 → 上游名）。
  请求的 `model` 先在 pre 相位按 `models` 过滤候选，再在 dispatch 相位按选中账号的 `modelMap`
  改写 body 顶层 `model`（同协议只动这一个字段，跨协议交给 protoconv 基于改名后的 body 解析 IR）
- OpenAI 兼容 `/v1/chat/completions`、`/v1/responses`、Anthropic `/v1/messages`、
  `GET /v1/models`（当前可用对外模型名并集）、SSE 透传、`/healthz`
- 用量记录：Go 在请求结束时采集「谁用的 / 哪个账号与模型 / 四个 token 桶 / 耗时 / 首字延迟 /
  状态 / 客户端 IP」，经控制桥 `usage.since` 由 TS 轮询落 SQLite；`/api/usage`（用户）与
  `/api/admin/usage`（全站）提供明细、汇总、按天/按模型/按用户聚合与 CSV 导出；
  `GET /api/usage/:reqId` 是**单条详情**（详情弹窗用，普通用户只能查自己的、管理员查全部，
  查不到与「不是自己的」统一 404）；`/console/usage` 只加明细表，`/admin/usage` 是独立页面
- 模型价格：`/api/pricing` 读、`/api/pricing/:model` 读写（写需管理员），`/admin/pricing` 页面；
  用量费用在**读取时**按价格表计算（整数微元，1 元 = 1_000_000 微元）
- **真实扣费（`billing`，后付费）**：`usage` 每轮 `usage.since` 拉到用量后，按
  「拉取 → 落库 → 结算 → 推进游标」的顺序调 `billing.settle(本轮**落库成功**的记录)`；
  `req_id` 唯一键 + CAS `pending → settling → settled` 保证同一请求只扣一次，价格用 `pricing`
  快照复算（不信 Go 传的金额），扣款只经 `user.adjustBalance`（余额允许为负，记 `overdrawn`
  + 扣后余额）；结算失败**不推进游标**，下一轮带同一 `afterSeq` 重放补结算；
  `settling` 崩溃残留靠「余额流水里有没有这笔扣款」判定收尾，判不出就转 `review` 人工核查
  （宁可少收一笔，绝不重复扣款）。`/admin/billing` 与 `/api/admin/billing` 可查记录、透支与汇总。
  **没有预扣 / 冻结**；额度闸门见下条
- 坏记录有界隔离（`usage_rejected`）：同一条用量连续落库失败到 `rejectAfterFailures`（默认 10）
  后不再重试，改逐条独立事务——能插的插、插不进的写隔离表，游标推进到该批最大 seq；
  被隔离的记录**不结算不扣钱**，`/admin/usage` 可看原因并「忽略 / 重放」（重放靠 `req_id` 幂等，
  `billing` 不在运行时重放明确失败，不做「只记明细不扣钱」的降级）
- **额度闸门（余额只读快照 + pre 相位预检）**：`quota` 插件把 `user` 的全量余额推给 Go
  （`quota.replace`，金额是**十进制 bigint 字符串**，不经浮点），Go `internal/quota` 缓存 +
  `modules/quotagate` 在 pre 相位判断：余额 ≤ 阈值（`-quota-min-balance-micros`，默认 0）→
  **402 `INSUFFICIENT_BALANCE`、不可重试、不转发上游**；没有 userId（静态 key / 无 key）不预检。
  快照未就绪 / 过期 / 查不到用户 → 默认**放行 + 节流告警**（可用性优先，后付费结算兜底），
  `-quota-require-snapshot` 打开严格模式改为 503 `QUOTA_SNAPSHOT_UNAVAILABLE`。
  快照 TTL 由 Go 的 `-quota-snapshot-ttl-ms` 定（默认 15000），**必须 ≥ 3 × TS 的 `pollIntervalMs`**。
  **推送是心跳式的**：余额内容没变也按周期再推一次（`revision` 不变、`generation` 递增），
  Go 侧借此刷新 `updatedAt`；「没变就跳过」会让闸门在 TTL 一到自动失效（2026-10-29 生产事故：
  余额已 −97 仍 200）。告警区分偶发 / 持续：第 1 次立即报，之后每分钟一条，连续第 10 / 20 / 30… 次
  补一条并标「持续失效」；`quota.status` 只增不改地追加 `gate: {allowedUnknown, blockedLow,
  strictBlocked, staleStreak, staleReason, staleForMs}`（无闸门注入时该键不出现）
- **充值订单与人工到账（`topup`）**：`/console/top-up` 下单（金额 1~10000 元，整数微元，
  正则拆字符串不经浮点）→ `pending`，`manual` 通道返回「线下转账后由管理员确认」的说明
  （说明落库，不随配置漂移）；`/admin/topup-orders` 列表 + 筛选 + 确认到账 / 取消 + 统计。
  到账幂等靠 `pending → paid` 的条件更新（`WHERE` 里同时判未过期），只加一次钱；
  过期三重保险：60s 清扫 + 列表/统计/确认前 `expireDue()` + `claimPaid` 的 WHERE。
  **支付通道只留 seam**：`PaymentProvider` 接口 + 注册表，本批只实现 `manual`（`online: false`），
  **不挂任何未验签的回调路由**；配置里出现未知 provider 直接装载失败，不回落 manual
- **Gemini 协议（客户端入口 + 上游协议）**：`POST /v1beta/models/{model}:generateContent`
  与 `:streamGenerateContent`（流式要 `alt=sse`）。请求/响应/流式三向编解码，覆盖
  `contents` / `systemInstruction` / `tools.functionDeclarations` / `toolConfig` /
  `generationConfig` / `functionCall` / `functionResponse` / `inlineData` / `thought`；
  OpenAI 专有参数记 `LossyNote`。模型名接受 `models/x` 与裸名 `x` 两种写法（官方 SDK 默认带前缀），
  归一后拼上游只补一层 `models/`。错误体保持官方 schema（`code` 整数 + `status` 枚举名），
  网关稳定码放纯增量的 `reason`。账号可声明 `protocol: gemini`，三个既有客户端入口都能路由过去
- **模型广场与 API 文档**：`/api/models` 给 `available` / `unavailable`（带原因与人话细节）+
  汇总；`/console/models` 展示四档价格、可用性、覆盖账号数与上游模型名，支持搜索与筛选；
  `/console/api-docs` 是自证文档，**内容 = 人写的叙述（`docs/api/*.md`）+ 从代码派生的事实表**
  （入口表 / 错误码表由 `packages/web/src/content/api_facts.ts` 渲染时实时读代码生成，插进
  `.md` 的占位符里——手写清单会腐烂，详见 §7「前端」）；服务端用 markdown-it（MIT，`html: false`）
  渲染成 HTML；另有两条机器友好副本 `GET /console/api-docs.md`（纯 markdown）与
  `GET /llms.txt`（站点索引），HTML 里用 `<link rel="alternate" type="text/markdown">` 与
  `rel="describedby"` 指向它们，页面上的「复制整页 Markdown」按钮复制的就是那份 markdown
  （方便直接投喂 agent）
- **管理员操作审计（`audit`）**：高危写操作（用户/余额/角色、账号增删改启停与批量、价格、设置、
  兑换码批次与核查、充值确认/取消、隔离区忽略/重放）在**成功后**记一条审计；actor 形如
  `user:<id>:<role>`，面板写设置记 `operator:panel`。落库前两道脱敏（键名命中 + 值形状命中），
  摘要与 metadata 都过；`/admin/audit` + `/api/admin/audit` 可查（要 actor 在白名单）。
  **审计不是业务前置依赖**：服务运行期解析，失败只记警告
- **多模态入口（embeddings）**：`POST /v1/embeddings`（OpenAI 兼容，单条或数组 input，不流式）。
  用 `Ctx.Operation = embeddings` 选上游路径（**不新造 Protocol**，零值仍等于 chat）；
  选中的账号协议不是 OpenAI 系 → `400 MODEL_NOT_SUPPORTED`、不可重试、不请求上游；
  入口侧会先把候选收敛到 OpenAI 兼容账号。用量四桶：`prompt_tokens` → input，其余 0
- **指标（`/metrics`）**：Prometheus 文本，只在 gatewayd 回环监听（nginx 不反代）；
  指标里没有账号 id / 用户 id / IP / 模型名，标签值全部来自编译期枚举
- **运维总览（`observability`）**：`/admin/observability` + `/api/admin/observability` 一屏看
  用量链路（gap / 丢记录 / 连续失败）、结算各状态与透支、额度快照新鲜度、账号运行时
  `active/cooling`、审计最近动作、账号池健康分布；任一源缺席只降级该块（HTTP 仍 200），
  只有聚合插件本身缺席才 503
- 用量投递健康度：`usage.stats` 桥命令给 TS 报 `capacity/size/dropped/gap/epoch/lastSeq`，
  `gap` 只统计「真丢」的部分；轮询默认 1s，落库失败不吞错、游标只推进到实际落库的最大 seq
- **内容审核（`content-audit`）**：管理面维护关键词规则（`/admin/content-audit` +
  `/api/admin/content-audit`，`block` = 命中拒绝 / `log` = 只记日志），规则**心跳式**推给 Go
  （`contentaudit.replace`，5s 一轮、内容不变也推；审核关闭时推 `enabled:false` + 空规则）；
  Go 的 `modules/contentaudit` 在 **pre 相位**（keyauth 之后、quotagate 之前）只看**用户输入文本**，
  命中 `block` → **403 `CONTENT_BLOCKED`、不可重试、不转发上游**。命中统计与快照新鲜度从
  `contentaudit.status` 读回页面。**只做大小写不敏感子串匹配，不做正则**；解析失败 / 无文本 /
  快照不可用默认放行（可用性优先），严格模式 `-content-audit-require-snapshot` 才 503
- **账号并发闸门与短期冷却（Go 侧，纯进程内）**：每个 attempt 按账号 `concurrency` 原子预留槽位，
  预留失败换下一个候选、全饱和时返回 `ALL_ACCOUNTS_SATURATED`（503、不可重试，不排队、不放行）；
  上游 429 / 额度耗尽把账号标记进冷却（`-account-cooldown-ms`，默认 30s，0 = 关闭，非法值启动失败），
  冷却期内不打分、到期自动恢复；额度耗尽改成可重试错误，好让 failover 换号。
  所有结束路径（正常 / 上游失败 / 客户端取消 / 流中断）都保证槽位归零。
  `accounts.status` 桥响应只增不改地追加 `runtime: {active, cooling}`（全站聚合，无账号级明细）
- Anthropic 形状的错误体在 `error` 对象里增量输出稳定 `code`（官方 schema 只有 `type` / `message`；
  空 code 不输出该键，老客户端看到的形状不变），这样 `/v1/messages` 也能机器可读地看到
  `ALL_ACCOUNTS_SATURATED` / `ALL_ACCOUNTS_COOLING` 等拒因
- 管理员概览 `/api/admin/stats`：用户 / 账号 / key 计数 + 今日与累计 token（入 / 出 / 总）、
  请求数、费用、近 30 天序列、Top 模型与 Top 用户
- 服务端渲染页面 + `/api/*` JSON 入口；设置、目录、健康、用户管理、账号管理
- 部署：systemd + nginx（宝塔）+ fail2ban；`sub2api` 暂并存于同一台机器

---

## 5. 开发规范

### 5.1 秘密

- 秘密值只存在于 `credentials`；API key 是例外：owner 2026-10-20 决定完整 key 落
  `api_keys.secret`，用户列表可复制；管理面 `listAll` 仍只给掩码，Go 快照仍只有哈希。
- 日志、事件、桥响应、设置接口不得携带秘密值。
- API / 事件载荷只放稳定 code 与必要元数据。

### 5.2 存储

- SQLite 用 Node 内置 `node:sqlite` 的 `DatabaseSync`，无第三方依赖；写事务 `BEGIN IMMEDIATE`。
- 一个数据一个写者；迁移要幂等，旧数据不能因升级被拒绝。
- 余额、金额一律整数最小单位；读取开 `setReadBigInts(true)`。
- 新增字段要兼容旧快照：缺失按 `null` / `0` 处理，不要因为一次升级拒绝整份文件。

### 5.3 错误与失败

- 下游插件保留自己的稳定 code，HTTP 层只做状态码映射。
- 用户可见错误不回显密码、验证码、API key、上游凭据。
- 未知内部错误映射 500；不要把内部错误伪装成 400。
- 阶段失败默认 deny；运行时缺服务时对应路由 503，入口本身不跟着 PENDING。

### 5.4 测试与验证

每个 worktree 合并前至少跑：

```bash
pnpm typecheck
pnpm test
pnpm test:go
```

- 新增插件必须有 `test/*.test.ts`；新增 Go 模块必须有单测。
- 测试失败先修实现，不允许删断言或放宽断言来变绿。
- 当前基线（2026-10-30 实测）：`pnpm test` 782 个用例（781 通过 / 1 跳过），`pnpm typecheck` 干净，
  `go test ./...` **26 包**全 ok，`gofmt -l .` 与 `go vet ./...` 无输出。
  这个数字会变，以实际输出为准。
- **验收任何分支前先 `pnpm build:go`**（不只是改过 Go 的分支）：`pnpm test` 里有真进程用例会
  spawn `bin/gatewayd`，worktree 里的 `bin/` 往往还是它自己开工时编的旧二进制。分支合过带 Go
  改动的 main 之后，旧二进制不认识新 flag，`api-key/test/gateway-gates-pricing.test.ts` 会直接红
  （2026-10-30 实测：`优化` 首次 793 通过 / 1 失败，`pnpm build:go` 之后 5/5 全绿）。
  这不是回归，但**不 build 就分不清是不是回归**。
- **多 worktree 并行跑测试会互相抢端口**：`pnpm test` 里有多条**真进程用例**（`content-audit`
  的 `gateway-smoke`、`account-priority` 的子进程），它们用 `freePort()` 拿临时端口再 spawn
  `bin/gatewayd`。几个 worktree 同时跑全量时，A 释放的端口可能被 B 抢到，表现是
  `ECONNREFUSED 127.0.0.1:29xx` 或 `200 !== 403`——**这不是回归**。判据：单独复跑该文件
  连跑 3 次全绿即可确认。**合并验收必须串行**（一次只验一个 worktree）。
- `packages/content-audit/test/gateway-smoke.test.ts` 是**真进程用例**（真 `bin/gatewayd` +
  真桥 + 真 HTTP 入口，小 TTL）：有二进制才跑，没有就 skip。它抓的是「Go 侧到底有没有照做」，
  内存假 Go 的用例抓不到（额度闸门踩过这个坑）。改动 Go 侧审核逻辑时**先 `pnpm build:go`**。

### 5.5 前端

- 产品前端是 `web` 插件：**服务端渲染、一页一个文件**（`packages/web/src/pages/*.ts`）。
- 页面通过 `pageTemplate` 服务拿像素级外壳、卡片、表格、表单与图表；样式与脚本走
  `/assets/app.css` / `/assets/app.js`，CSP 保持 `'self'`（不放开 inline）。
- 数据直接调进程内服务，不经过 JSON HTTP；写操作是表单 POST + 303（PRG）。
  一次性 secret（新建 / 轮换 API key）只在下一次渲染出现，5 分钟后自动清理。
- 旧的 `frontend` SPA（`packages/console`）已禁用：`/assets/frontend/*` 与 SPA 路由不再提供，
  `/api/*` JSON 入口仍由 `api` 插件保留。
- 不把完整 key 写进 localStorage / URL / 日志；页面只在创建 / 轮换后显示一次。
- 站点字体是 `font-smiley` 插件：自托管 Smiley Sans（得意黑）v2.0.1（OFL-1.1），
  字体与 LICENSE 在 `packages/font-smiley/assets/`；`scope` 默认 `headings`（只换标题与品牌），
  改 `all` 才换正文。web 负责把 `@font-face` 追加进 `/assets/app.css` 并发送 woff2 字节。
- 用量页时间维度只有 **今天 / 昨天 / 近 7 天**：单日（今天、昨天）的柱状图看最近 7 个小时
  （小时桶，标签 `HH:00`），近 7 天按天绘制；图表固定 7 根柱、7 个标签。

### 5.6 文件粒度与耦合（owner 2026-10-29 追加）

**要求原话：不要一个文件写那么大，尽量低耦合。** 这条是硬要求，不是风格偏好。

- **新文件软上限 400 行**（含注释，不含测试数据）。400～500 行要在 PR 说明里写清为什么
  不能再拆；**超过 500 行不接受提交**，先拆再交。
- **测试文件软上限 500 行**。测试按主题拆成多个 `test/*.test.ts`，不要一个文件塞完所有场景。
- **一个文件一个职责**：`service.ts` 放编排、`db.ts` 放 SQL、`types.ts` 放类型、
  `errors.ts` 放稳定错误码、`config.ts` 放 schema。不要把「编排 + SQL + 类型 + 常量」
  都塞进 `service.ts`。
- **一个文件里不出现两个服务 / 两个模块**。同目录的文件之间保持单向依赖：
  `service → db / types / errors`，反向 import 一律不允许。
- **已有超限文件只许缩短，不许加长**（大文件债，按需拆，不搞一次性大重构）：
  `packages/usage/src/service.ts` 1326、`packages/api/src/types.ts` 949、
  `packages/account-admin/src/service.ts` 1319、`packages/account-priority/src/service.ts` 1094、
  `packages/identity/src/service.ts` 1036、`modules/protoconv/codec_*.go` 约 900、
  `packages/web/src/runtime.ts` 892、`packages/api/src/http.ts` 782、
  `internal/httpapi/server.go` 790。
  往这些文件里加东西时，**顺手把同一职责搬进新的小文件**，让净增行数尽量小。
- **`packages/api/src` 的路由布局（2026-10-30 拆完，4241 → 782）**：新增 `/api/*` 路由**一律**
  写进 `routes/<前缀>.ts`，不再进 `http.ts`：
  - `routes/*.ts`：一前缀一个文件（`keys` / `usage` / `admin_usage` / `admin_accounts` …），
    导出一个 `routeXxx(host, req, res, parts, url)`；每个管理面文件**自己先调
    `host.requireAdmin(req)` 再干活**（不要假设上游已经鉴权过）。
  - `views/*.ts`：DTO 的纯函数映射（`usage` / `commerce` / `account` / `audit` …），不碰 IO。
  - `http.ts`：只留类字段、生命周期、`dispatch`、`routeApi` 分发与 51 个同名薄委派。
    **`routeApi` 的判定顺序是不变量**，它有 `/api/usage/export` 必须早于 `/api/usage/:reqId`
    这类先后依赖；动它之前先看顺序表，改完用全量测试验。
  - 拆文件时 `routeApi` 的委派层是刻意留的：调用点一个字不改，风险最小。要压掉委派层
    （能再省约 400 行）属于单独一批，需要同时改所有 `this.xxx` 调用点，不能顺手做。
- **低耦合的执行标准**：插件之间只经服务接口 / 进程内事件（§2.2 已有）；插件内部
  不跨层直连别人的存储；Go 侧 `modules/*` 只 import `contracts/`（§2.3 已有）；
  传输层 / 渲染层 / 存储层不互相 import 实现文件。

---

## 6. 构建、测试、部署

### 6.1 常用命令

```bash
pnpm dev              # cordis + gatewayd（predev 会先 build:go）
pnpm preview:console  # 只开 mock 前端预览，127.0.0.1:7790
pnpm typecheck
pnpm test
pnpm test:go
pnpm build:go         # 产出 bin/gatewayd(.exe)
pnpm build:cli        # 产出 bin/dizzy(.exe)（命令行客户端，见 §6.2）
pnpm build:all        # 两个二进制一起编
```

- **多 worktree 并行时，路径敏感的写操作一律用绝对路径**（2026-10-30 实测踩坑）：在工具调用里
  先 `cd <worktree>` 再用相对路径调 `[IO.File]` / `Set-Content` 之类，`cd` **不一定作用到**
  这些 API 的路径解析上，文件会落到**主仓库**里。表现是主仓库里冒出一个不该存在的文件
  （曾把 `packages/web/test/helpers/docs-fixture.ts` 建成 0 字节空文件，害得 `git merge --ff-only`
  报「untracked working tree files would be overwritten」）。所以：
  - 文件操作**写绝对路径**，或直接用工具的 `workdir` 参数，不要靠同一条命令里的 `cd`；
  - **提交 / 合并前先看主仓库 `git status --porcelain` 必须为空**，不为空先停下查清来源，
    不要顺手删、也不要带着它继续操作。

### 6.2 命令行客户端 `dizzy`（`cmd/dizzy`）

`dizzy` 是**客户端**：静态 Go 二进制，零环境依赖，只通过 HTTP 访问网关，
**绝不直连 SQLite / JSON 数据文件**。完整用法见 `docs/cli.md`。

- **两条鉴权路径严格分开**：`/v1/*` 走 `Authorization: Bearer <API key>`
  （`--key` 或 `DIZZYAPI_KEY`，**不落盘**）；`/api/*` 走 HttpOnly 会话 cookie，
  且**每个**请求都必须带 `X-Requested-With: dizzyapi`（登录前也要 —— 它与会话是
  两个独立开关，绑在会话上会 403）。
- **配置**：`~/.dizzy/config.json`（0644，`base` / `llmBase` / `apiBase`）、
  `~/.dizzy/credentials.json`（0600，**只存会话 token**）。本地开发时 gatewayd 与
  api 是两个端口，要用 `llmBase` / `apiBase` 分开指；生产一个域名指 `base` 就够。
- **没有默认 `base`**：既没配 `base` 也没给 `--base` 时，**需要发请求**的命令退 2 并打印
  两条可抄命令（`dizzy config set base <url>` / `dizzy --base <url> models`）；`dizzy config`
  与 `--help` 不碰入口地址，照样能跑。这是刻意的：默认指向某个地址（尤其生产）意味着
  「忘了配」会静默打到线上，而写操作不可撤销。`Config.Validate()` 因此允许 `base` 为空，
  只在**构造客户端**时拦（`newLLMClient` / `newAPIClient` / `newAPIAnonClient`）。
- **费用只有一个权威来源 = `/api/usage` 的 `costMicros`**：客户端看到的
  `prompt_tokens` **含**缓存命中，而网关记账的四桶里 `input` **不含**缓存
  （`internal/usageprobe.Normalize`），跨协议时这个关系还不成立。所以 `dizzy chat`
  自己**不算钱**，登录状态下回查 `/api/usage`；没有会话就只打 token。
- **秘密纪律**：完整 API key 默认**掩码打印**，要完整值必须显式 `--show`；
  `--verbose` 只打方法与路径，不打 Authorization / cookie。
- **退出码**：0 成功、1 通用失败、2 用法、3 未登录、4 认证(401)、5 权限(403)、
  6 不存在、7 余额不足(402)、8 限流(429)、9 上游/网关(5xx)。agent 按它分支。
  **7（402）只在 `/v1/*`**（Go 额度闸门 `modules/quotagate`），`/api/*` 没有 402；
  **8（429）以 `/v1/*` 为主**（上游限流 / 账号冷却），但 `/api/*` 的认证限流
  （`AUTH_RATE_LIMITED` / `AUTH_CODE_ATTEMPTS_EXCEEDED`，`packages/api/src/errors.ts:91`）
  也回 429 —— 同码不同因，要分清看错误体的 `code`。所有 5xx 都归 9。
- **请求 id**：Go 侧在 `internal/httpapi/server.go` 回写响应头 `X-Request-Id`
  （与用量记录的 `RequestID` 同源，只加头、不改任何响应体字节）。`chat` 打印它
  （`--json` 里同名字段），并**按它**精确回查 `GET /api/usage/<reqId>` 拿费用；
  没有这个头就明说「未取到 reqId」，**不**退化成「模型 + 时间窗 + 最大 id」的猜测。
- **写操作先报目标**：`keys` 的写与 `admin` 下的写会在 stderr 先打一行「动作 → 目标地址」。
  没有默认 `base`，但配过一次就一直在，本地栈测试时用 `--base` 临时覆盖更安全。
- **`usage show <reqId>`** 打单条详情（`GET /api/usage/:reqId`）；`ttftMs` 为 `null`
  显示「—（未采集）」，不是 0 ms。`usage --by key` 是**本地聚合**，输出会标明覆盖范围。
- **实测夹具**（不进 `pnpm test`，要真进程）：
  - `cmd/dizzy/testdata/e2e`：假上游 + 真 gatewayd，验 Bearer 路径与坏 key 拒绝；
  - `cmd/dizzy/testdata/e2e-full/run.mjs`：整套栈 + 会话路径，**断言 `dizzy chat`
    的 `costMicros` 与 `/api/usage` 逐条相等**。跑前先确保 7791/7792/8080 空闲。

### 6.3 部署

- 生产服务器 `<生产服务器>` / `<SERVER_IP>`（root），代码 `/opt/dizzyapi`，systemd `dizzyapi.service`；
  公网入口 `https://<站点域名>`：宝塔 nginx 把 `/v1/*`、**`/v1beta/*`** 与 `/healthz` 反代 gatewayd
  `18080`、`/api/*` 反代 `api` 的 `7791`、其余反代 `web` 的 `7792`；后两者的 `Host` 都要改写成
  对应回环地址（`/` 还要把 `Origin` 改写成 `https://127.0.0.1:7792`）。
- 服务器上 `pnpm` 走网络会卡住；部署依赖统一用
  `npx -y pnpm@11.21.0 install --frozen-lockfile --offline` 复用已装好的 store。
- `tx`（`<OLD_SERVER_IP>`）上的旧部署已于 2026-10-23 下线，`data/` 备份在本地 `temp/`。
- 服务器没有 Go 工具链：本地 `GOOS=linux GOARCH=amd64 go build -trimpath -o bin/gatewayd ./cmd/gatewayd`
  交叉编译后 scp `bin/gatewayd`；服务器 Node 26，用 `npx pnpm@11.21.0 install --frozen-lockfile`。
- 反向代理必须把 `Host` 改写成回环（`127.0.0.1:7792` / `127.0.0.1:7791`）：
  `web` 与 `api` 都校验 Host 来挡 DNS rebinding，原样转发会 403；表单 POST 还要求
  `Origin` 与站点同源。
- `deepseek-usage.consoleBaseUrl` 在服务器 `app.yml` 里配成 `https://<站点域名>`，
  否则侧栏链接会指向访客本机的 `127.0.0.1`。
- 邮件用 163 SMTP（`smtp.163.com:465`，TLS），沿用 `/opt/aihot-digest/.env` 的账号：
  授权码写在 `credentials` 的 `dizzyapi/mailer`，`mailer.from` **必须与该授权账号一致**，
  否则 163 回 `553 Mail from must equal authorized user`。
- 服务器 `app.yml` 的 `account-priority.httpListen` 用 `18080`：仓库默认的 `8080` 在 `<生产服务器>`
  属于 sub2api，`18080` 原属已删除的 dsh-proxy。
- 服务器无法直连私有 GitHub 仓库：用本地 `git archive` + `scp` 部署，不要覆盖服务器
  `app.yml`、`data/`、`bin/`。
- 部署前备份代码与 `data/`；部署后重启 `dizzyapi`，检查 `systemctl is-active` 与
  `/api/health`。

---

## 7. 踩坑清单

### cordis

- 类插件必须有默认导出；`static inject` 必须是类静态属性。
- 服务类不能用 `#` 私有字段（Proxy receiver 的 brand check 会炸）。
- 重启用 `fiber.update(fiber.config, true)`，不要用 `fiber.restart()`；`noSave` 必须为 `true`。
- 软重启换实例、不换 fiber；会级联到注入了该服务的插件。
- `include` 会把 `ctx.baseUrl` 改成配置文件所在目录；数据路径跟着配置文件走。
- `ctx.loader.entries()` 会递归 include 子树；`ctx.loader.resolve()` 不会。
- 不要断言 `ctx.get(name)` 的 proxy 身份；断言行为或原始类型。
- `Config` 上不能叫 `merge`；字段元数据用别的名字（本项目叫 `fields`）。
- Node 24 + tsx 跑测试要用 glob：`node --import tsx --test "packages/*/test/*.test.ts"`。
- `fiber.dispose()` 返回 `void`，要捕获异常用 `try { await fiber.dispose() } catch {}`。
- `server.close()` 会被 SSE / keep-alive 挂住，配 `closeAllConnections()`。
- `EventSource` 发不了自定义请求头；SSE 客户端要用 `fetch` + `ReadableStream`。
- `ctx.setInterval` / `ctx.timeout` 是 `@cordisjs/plugin-timer` 往 Context 上 mixin 的方法，
  **必须把 `'timer'` 写进 `static inject`**；否则访问 `ctx.timer` 时直接抛
  `cannot get property "timer" without inject`（`ctx.get('timer', false)` 也救不了）。
  `@dizzyapi/plugin-account-health` 就是这么写的：没有 timer 时停在 PENDING。

### Go

- 本机 `go test -race` 不可用（Windows `STATUS_ENTRYPOINT_NOT_FOUND`）；换 Linux CI 补跑。
- `go build -trimpath -o bin/ ./cmd/gatewayd`；Windows 会自动补 `.exe`。
- stdout 只放 ready 一行，日志走 stderr。
- Windows 的 Node `net` 连不上 Go 的 AF_UNIX socket；`transport: auto` 在 Windows 走回环 TCP。
- 桥拒绝非回环 TCP；生产 Linux 走 UDS。

### 协议转换

- **响应方向的转换只能发生在 transport 内部**：`engine.runDispatch` 在 transport 返回
  `ActionRespond` 后立刻 return，注册在它之后的 dispatch 阶段永远不会执行；`runPost` 也改不了
  已定的响应。所以请求方向是阶段、响应方向是注入 transport 的 `ResponseTranscoder`。
- **每个 attempt 都要显式重置 `ctx.Upstream`**（含置 nil）。failover 循环会重跑转换阶段，残留
  上一次的结果就会把错误的请求体发给下一个账号。
- **路径约定**：`baseUrl` 自带版本前缀（`https://api.anthropic.com/v1`），方言表的 `Path` 是版本
  之后的后缀（`/messages`）。写成 `/v1/messages` 会拼出 `/v1/v1/messages`。
- **Anthropic 要求 `tool_use` / `tool_result` 成对且顺序合法**，否则上游直接 400；渲染前必须做
  配对修补。工具 id 跨协议用无状态的「标记前缀 + base64url」方案改写，必须可逆。
- **Anthropic 的 `max_tokens` 必填**：客户端没给时补默认值并记 `LossyNote`（旗标
  `-anthropic-default-max-tokens`）。
- **真实 Responses API 不发 `data: [DONE]`**，终止符是 `response.completed` / `response.incomplete`
  / `response.failed`；解码端兼容上游发来的 `[DONE]`，编码端不发。
- **部署顺序**：`accounts.replace` 用 `DisallowUnknownFields`。TS 若先发带新字段的账号快照而 Go
  二进制还是旧的，**整份快照被拒 → 账号缓存清空 → 全部 503**。先重建 Go，再发 TS。
- **`keys.replace` 同样走 `decodeParams` + `DisallowUnknownFields`，同样踩这条**：key 快照现在带
  `expiresAt` / `spendingLimitMicros` / `concurrencyLimit`，而 `SnapshotVersion` 仍是 **1**（没 bump），
  所以旧 Go 会先过版本检查、再因未知字段被整份拒绝 → **key 快照缓存清空 → 所有 API key 校验失败
  → 全站 401**。上线这个版本必须**先换 `bin/gatewayd` 再重启 `dizzyapi`**，顺序反了就是全站 401。
  将来再给这两个快照加字段时，考虑把 `SnapshotVersion` 一起 bump，让旧 Go 报「版本不支持」
  而不是「参数不合法」——错误更好定位，失败同样是 fail-closed。
- **闸门默认值**：`-pricing-gate` 默认 **false**（未定价模型放行，与上线前一致）；
  key 级闸门**没有开关、总是注册**（上限全为零值时行为与引入前完全一致）。
  严格模式一律等新 TS 跑过一轮再开。

### 模型路由

- **两个阶段、两个注册函数**：`modelroute.RegisterRouter`（pre，必须在 accountpriority 之前）与
  `RegisterMapper`（dispatch，必须在 accountpriority 之后、protoconv 之前）。`Registry.Stage()`
  只按注册顺序追加、engine 又强制相位不倒退，所以不能合成一个 Register。
- **每个 attempt 都要显式重置 `ctx.MappedBody`**（含置 nil），与 `ctx.Upstream` 同理：failover
  会重跑映射阶段，残留上一次的改写结果就会把错的 body 发出去。
- **请求体优先级**：`ctx.Upstream`（协议转换结果）> `ctx.MappedBody`（模型映射结果）> `ctx.Body`
  （原始）。同协议直通时 protoconv 不渲染，transport 直接发 `MappedBody`；跨协议时 protoconv 用
  `MappedBody` 解析 IR，IR.Model 自然已是上游名。
- **账号未声明 `models` = 不参与路由过滤**（向后兼容），不能当成「不服务任何模型」，否则旧账号
  会静默失效。全被过滤掉才报 `MODEL_NOT_SERVED`（503，不可重试）；没有候选时报的是
  accountpriority 的 `NO_ELIGIBLE_ACCOUNT`。
- **`ctx.Meta.Model` 永远是客户端请求的模型名**，不改成上游名；上游名只放在 `MappedBody` 里。

### 用量与价格

- **流式用量只有在流读完之后才有**：`engine.runPost` 在 `copyStream` 之前就跑了，所以记录
  在 `httpapi` 写完响应后发出，不要试图在 post 相位采集。
- **Anthropic 的流式 usage 分两次发**：`message_start` 带 input / cache，`message_delta`
  带 output。探针按字段取 max 合并，覆盖式合并会把输入清零。
- **OpenAI 的 `prompt_tokens` 含缓存命中，Anthropic 的 `input_tokens` 不含**：记录按
  **上游协议**归一化成「input 不含缓存」的四桶，否则输入与费用都会偏高。
- **跨协议到 OpenAI 客户端时 `cache_creation_input_tokens` 无法表达**，记录的
  `cacheWriteTokens` 会是 0（协议固有有损面）。
- **`stream_options.include_usage` 默认注入**：否则 OpenAI 流式请求记不到 token。关掉
  `-record-stream-usage` 时请求体必须逐字节不变（回归测试守着）。
- **`usage.since` 用 epoch + seq**：gatewayd 重启后 seq 从 1 重新开始，TS 必须按 epoch 重置
  游标；`firstSeq > lastSeq+1` 说明环形缓冲丢过记录，记 gap 警告。轮询游标只推进到实际
  落库的最大 seq，否则积压超过 `maxBatch` 时会永久跳过。
- **`attempts` 是「试了几个账号」**，不是 `len(ctx.Attempts)`（那是 dispatch 阶段执行次数，
  一次请求通常是 3）；用 `attemptedAccounts()` 按 AccountID 去重。
- **客户端 IP 取 `X-Forwarded-For` 右起第 N 跳**（`-trusted-proxy-hops`，默认 1），
  其次 `X-Real-IP`，最后 `RemoteAddr`。gatewayd 只监听回环，前面必然有代理。
- **费用在读取时算**：`usage.db` 只存 token 事实；每次查询取一次 pricing 快照，按模型分组
  算完再相加（不同模型单价不同）。`pricing` 不在运行时费用是 0，页面要提示。
- **导入的 base_url 约定**：new-api 的 `base_url` 是源站（`https://api.openai.com`），
  DizzyAPI 的 `baseUrl` 自带版本前缀；导入时只给「路径为空或 `/`」的裸源站补 `/v1`。
- **CSV 导出**：UTF-8 BOM + `= + - @` 开头加前导 `'`（防公式注入）；接口返回 JSON
  `{filename, content}`，由页面生成 Blob 下载。
- **桥的拓扑是「Go 服务端 + TS 客户端」**：`internal/bridge` 是 Server，TS 侧 `BridgeClient`
  才是发起方。所以结算**不能**设计成 Go 主动调 TS；正确形态是 TS 拉到用量后同步结算。
  要 Go 主动推，只能新增反向通道，那是新架构。
- **结算必须夹在「落库成功」与「推进游标」之间**：先结算后落库会让被隔离的坏记录也被扣钱
  （扣了一笔明细里查不到的钱）；游标和明细写在同一个事务里则会出现「钱还没结算、游标已落库」，
  崩溃后这批钱被永久跳过。所以游标写成独立的 `advanceCursor()`，结算失败就不推进。
- **坏记录不许抛到整轮**：`settleCandidateOf` 之类把记录映射成结算事实的函数，遇到缺
  `requestId` / 时间非法的记录要跳过 + 计数 + 告警，绝不能抛——抛一次就是结算和统计一起停摆。
- **`app.yml` 会覆盖插件默认值**：`usage.pollIntervalMs` 在 `app.yml` 里写着 `1000`，
  改代码里的默认值时别忘了同步改配置文件，否则线上仍走旧值。
- **TTFT（首字延迟）只有流式请求才有**：Go 在 `copyStream` 第一次读到字节时打点（相对请求
  开始，向上取整到 1ms），非流式请求一个字节都不填——非流式的 `DurationMs` 就是完整响应
  时间，再报 TTFT 只会误导。线格式用 `omitempty`，**缺失 = 没采集，落库必须是 NULL 而不是
  0**；页面对 null 显示「—」。历史记录（这条字段之前就有的行）迁移后保持 NULL。
- **`usage_records.ttft_ms` 是幂等补列**：`CREATE TABLE IF NOT EXISTS` 对已存在的老库一个字段
  都不加，所以 v1 之后新增的列必须在 `packages/usage/src/db.ts` 的 `migrate()` 里用
  `PRAGMA table_info` 查一遍再 `ALTER TABLE`。老库升级不能因为缺列被拒（§5.2）。
- **单条详情走 `GET /api/usage/:reqId`**：路由必须排在 `usage/export` 之后（那是固定子路径，
  不能被当成 reqId）。权限与列表同口径，**「查不到」与「不是自己的」返回同一个 404**
  （不泄露某个 reqId 是否存在）。响应比列表多 `reasoningTokens` / `usagePresent` /
  `usageComplete` / `ttftMs`，但**仍然不给** profile / accountId / attempts（用户面拿不到
  上游账号拓扑）。
- **给 `UsagePort` 加方法必须同批改 `packages/api/src/service.ts` 的方法清单**：
  `usage: () => this.optionalService<UsagePort>('usage', [...])` 里的数组是**整个 usage 端口**
  的可用性闸门——清单里列了 `get` 而 usage 插件没有它时，不是「只有新接口 503」，而是
  `/api/usage`、导出、详情**全部 503**（fail-closed，故意的：那说明版本错配）。
  所以加方法 = 改三处（`packages/usage` 的实现、`api/src/types.ts` 的 `UsagePort`、
  `api/src/service.ts` 的清单），漏了第三处会连带打挂旧接口。
- **管理面看首字延迟走 `/admin/usage`**：页面新增「最近请求」表（`usage.list` 最近 20 条全站
  明细），列里带「首字延迟」，null 显示「—」；纯用现有表格渲染，不依赖 `page-template` 的
  新控件（那是设计线的地盘）。
- **`X-Request-Id` 只在「查得到」时才发**：`internal/httpapi` 在 `requestID :=
  s.nextRequestID()` 之后、任何写响应之前写这个头，值与用量记录的 `RequestID` 同源；
  只加头、不改体（错误体逐字节不变有断言守着）。**早期拒绝**（方法不对 / 请求体读失败 /
  JSON 非法 / 缺 model）与 `/v1/models`、`/healthz` **都不发**：它们的 id 不进日志、
  不进用量库，发出去就是「看着能用、`usage show` 必然 404」的死值，比不给更差
  （曾用 aux 计数器发过，被否掉——「没有死值」这条有反向断言钉着）。真要全覆盖，
  先把 id 打进日志，再回头加头，两步一起做。客户端据此精确对账，不要再用
  「模型 + 时间窗 + 最大 id」猜。

### 充值与支付

- **不挂未验签的回调路由**：没有验签的「加余额」入口等于把钱包开到公网。接真实渠道时一起补：
  验签、金额与订单核对、provider 重复回调的幂等、失败重试；渠道密钥只能放 `credentials`。
- **到账幂等只靠条件更新**：`pending → paid` 的 `WHERE` 里必须同时判「未过期」，
  重复 / 并发确认返回 `credited: false` 且不动余额；加余额失败要能退回 `pending`（可重试）。
- **跨库残留面按「宁可少给不多给」处理**：`topup.db` 与 `users.db` 不能同一事务，崩溃窗口只有
  「已标记 paid、还没调 `adjustBalance`」，结果是少给钱而不是重复给；靠订单 + 余额流水人工核对。
- **订单号必须能验**：`T` + UTC 秒级时间戳 + 8 位十六进制，并发靠主键冲突重试收敛
  （不用进程内锁）；入口用严格正则校验，防注入式单号。
- **契约变更要钉住旧形状**：旧 `amountCents` + `method: alipay` 的请求现在是 400，
  有用例专门守着「501 契约不存在了」，别让旧前端悄悄走回假成功。
- **用户面不泄露存在性**：看别人的单 / 取消别人的单统一返回 `TOPUP_ORDER_NOT_FOUND`。

### 额度闸门

- **新增插件必须同时登记两处**：`app.yml` 的 `entries` **和** 根 `package.json` 的
  `dependencies`（`"@dizzyapi/plugin-x": "workspace:*"`）。只加 `app.yml` 会解析不到——
  cordis 按包名加载，包没被 workspace 根依赖登记就没有 `node_modules` 链接，
  `pnpm test` 也照样全绿（测试用相对路径 import），只有真启动进程才会炸。
- **部署顺序「先 Go 后 TS」**：新桥命令（`quota.replace`）在旧 Go 上返回
  `BRIDGE_METHOD_NOT_FOUND`，新 TS 会重试 + 节流告警但 LLM 请求不受影响；
  反过来「新 Go + 旧 TS」等于没有快照，默认策略放行、行为与上线前一致。
- **严格模式（`-quota-require-snapshot`）必须等新 TS 上线后再开**：否则从未收到快照，
  所有带 userId 的请求全 503。
- **快照顺序用 `generation` 判，不是 `revision`**：`revision` 是内容哈希（无序），
  `generation` 由 TS 取 `max(Date.now(), last+1)`；Go 侧「更小的 generation → 拒绝且不覆盖」，
  「相等 + revision 相同 → 幂等」，「相等但内容不同 → 拒绝」。
- **金额跨层一律十进制字符串**：JSON number 会丢 `> 2^53` 精度，Go 解析失败即整份拒绝快照。
- **TTL 与推送间隔耦合**：调大 TS 的 `pollIntervalMs` 必须同步把 `-quota-snapshot-ttl-ms`
  提到 ≥ 3 倍，否则严格模式下会周期性 503。`quota.status()` 的 `goTtlMs` / `heartbeatTooSlow`
  就是这个耦合的护栏（TTL < 2 × 间隔就告警）。
- **绝不能「内容没变就跳过推送」**：Go 按 TTL 判新鲜度，跳过等于让闸门在 TTL 一到自动失效。
  2026-10-29 生产事故就是这样：余额已 −97、20 秒前才推过快照，请求仍然 200 放行。
  推送必须是心跳式（`revision` 相同、`generation` 递增），并且**必须有真进程用例**
  （真 gatewayd + 真桥 + 小 TTL）守着——内存假 Go 的用例抓不到这类问题。
- **告警节流必须能区分「偶发」与「持续」**：只按「同一原因每分钟一行」会让持续失效在日志里
  只留第一行，排障时误判成偶发。现状是第 1 次立即报 + 每分钟一条 + 连续第 10 / 20 / 30… 次
  补一条并标「持续失效」，`quota.status.gate.staleStreak/staleForMs` 可查。
- **`quota.status` 加字段只用 `omitempty` 纯增量**：没有注入闸门阶段（测试 / 旧装配）时
  `gate` 键不出现，响应与改动前逐字节一致；`gate` 里不许出现任何余额明细。

### 多模态与指标

- **`Operation` 不是 `Protocol`**：embeddings 与 chat 讲同一种协议，只是路径不同。造新 Protocol 会逼
  codec 注册表、快照白名单、错误体形状一起扩，收益为零。`Ctx.Operation` 零值必须等于 chat，
  四个既有入口一个字节都不写它。
- **`/metrics` 标签只用编译期枚举**：账号 id 会随运营增长（基数爆炸）且属于内部拓扑，不能做标签；
  失败按固定错误码分，未登记的落 `other`。热路径只做原子加法，绝不拼字符串或加锁。
- **nginx 不反代 `/metrics`**：它只给本机运维看；gatewayd 只监听回环，默认开也不影响公网。

### Gemini 协议

- **模型名在两个地方出现**：客户端路径 `/v1beta/models/{model}:…` 与上游路径模板
  `/models/{model}:…`。归一函数只放 `contracts/gemini.go`（`NormalizeGeminiModelName`），
  入口解析与 transport 共用——放任一模块都会逼另一个跨模块 import。
- **只剥一层 `models/`**：官方 SDK 默认拼 `models/gemini-2.0-flash`，但很多客户端传裸名。
  剥完仍含 `/`、`\`、`?`、`#`、NUL 的一律明确失败（入口 404 / 上游 502），
  **不许手工 `PathEscape`**（会被 `url.URL` 二次编码，带 `%` 的模型名会被发成 `%25`）。
- **资源段写在方言模板里**，`{model}` 只放裸名，所以上游路径永远只有一层 `models/`；
  客户端带前缀、不带前缀、`modelMap` 映射出带前缀，三条路结果必须一致（有用例断言上游完整路径）。
- **流式 URL 要按模板重新渲染**：Gemini 的流式是另一个方法名（`:streamGenerateContent`）+ `alt=sse`。
  早期用「去掉非流式后缀再接流式方法」的写法，路径形态一变就静默失效。
- **请求体里没有 `model`**：Gemini 的模型在 URL 里，跨协议时 `IR.Model` 要由映射名/客户端模型名回填；
  `modelroute` 对 Gemini 只写 `ctx.UpstreamModel`，**绝不往 body 注入 `model`**（上游会 400）。
- **用量键是 `usageMetadata` 不是 `usage`**：`promptTokenCount` 含缓存（与 OpenAI 同口径，
  要减去 `cachedContentTokenCount`），`thoughtsTokenCount` 记 Reasoning 但不重复相加。
  漏认这个键 = 用量整条不落库 = 白用上游。
- **部署要加 nginx `/v1beta/*` 反代**，否则公网到不了这个入口。

### 安全与审计

- **审计不是业务前置依赖**：其他插件**不 inject** `audit`，运行期解析；`record` 失败只记警告，
  写操作必须照常成功。禁用 `audit` 时业务写操作照常、只是不再留痕。
- **脱敏两道闸**：键名命中（password / secret / token / credentials / authorization / cookie /
  apiKey / redeemCode…）整棵子树替换；值形状命中（`sk-…`、`Bearer …`、`ghp_…`、`AKIA…`）替换片段。
  摘要也过一遍。**调用方自己也要守**：凭据 payload、兑换码明文、设置值根本不传。
- **读白名单、写不设限**：`list` / `stats` 要 actor 在 `adminPlugins`（空名单谁都读不到），
  `record` 不限——审计里是「谁对谁做了什么」，限制读才是关键。
- **未审计的动作要照实写进报告**：定时器自动动作（`account-health` 自动停用/恢复）、
  identity 令牌刷新、用量轮询与自动结算都不在审计里，不要假装全覆盖。

### 内容审核

- **规则只做大小写不敏感子串匹配，不做正则**：正则表达式来自管理面输入，一条
  `(a+)+$` 就能把网关的 pre 相位打死（ReDoS），而且审核是**热路径**。要正则就得先上
  超时 / 隔离执行，那是另一件事。Go 侧预编译成小写子串（`internal/contentaudit`）。
- **推送同样是心跳式**：`pushIntervalMs`（默认 5s）到期就推，内容不变也推（`revision` 相同、
  `generation` 递增）；`enabled=false` 时推 `enabled:false` + **空规则**，让 Go 立刻全放行。
  「不推」会让 Go 按 TTL 判过期——严格模式下反而全 503（与额度闸门同一条教训）。
- **只审用户输入文本**：chat / anthropic 只看 `role=user` 的 `content`（字符串或 parts 里的
  `text`），responses 看 `input`，gemini 看 `contents`（role 为空也算 user），embeddings 看
  `input`。system / assistant / 工具结果**不审**（不是用户输入，误伤成本高）。
- **日志与桥响应绝不回显被审文本**：日志只放 `ruleId` / `category` / 计数；`contentaudit.status`
  不含 `pattern`；`/api/admin/content-audit` 的审计元数据也只放 id / action / 启停，
  **不放关键字本身**（`packages/content-audit/test/content-audit.test.ts` 里那条
  「审计不在这层写」与 `packages/api/test/content-audit.test.ts` 的元数据断言都守着）。
- **审核不在这层记审计**：`content-audit` 插件对 `audit` **零依赖**（事务性写也不需要它），
  留痕在 `api` 的 HTTP 路由与 `web` 的页面动作里用 `audited(...)` 记 —— actor 身份只有入口层知道。
- **解析失败 / 无可审文本 / 快照不可用默认放行**（可用性优先），并分别计数
  （`parseFailed` / `noText` / `allowedStale`）；严格模式（`-content-audit-require-snapshot`）
  才 503。扫描上限 256 KiB / 256 段文本，超出计 `truncated`——**这是已知有损面，不是 bug**。
- **`gate.*` 计数与 `stale` 是 `omitempty` 纯增量**：读 `contentaudit.status` 时 `0` / `false`
  可能是「键不出现」，判「过没过期」要用 `!== true` 或 `?? 0`，别直接 `=== false`。
- **部署顺序仍然是「先 Go 后 TS」**：`contentaudit.replace` 在旧 Go 上返回
  `BRIDGE_METHOD_NOT_FOUND`（TS 会节流告警、LLM 请求不受影响）；反过来「新 Go + 旧 TS」
  等于从没收到快照，默认策略全放行、行为与上线前一致。**严格模式必须等新 TS 上线后再开**。
- **真进程用例是真证据**：`packages/content-audit/test/gateway-smoke.test.ts` 会 spawn 真
  `bin/gatewayd`、用真控制桥推快照、打真 HTTP 入口，断言「命中 → 403 且上游 0 次」「未命中 → 200
  且上游 1 次」「停推超 TTL → 放行 + `allowedStale`」「严格模式无快照 → 503」。改 Go 侧审核逻辑
  前先 `pnpm build:go`，否则用例会因为二进制过旧而跳过（skip 不算绿）。

### 并发闸门与冷却

- **槽位的生命周期是「预留 → 转交 → 释放」**：engine 预留成功才把它交给 `ctx.ReleaseInFlight`，
  **HTTP 入口必须在响应（含整个流）写完之后才调 release**；失败 / panic / 客户端取消由 engine
  兜底释放。release 必须幂等，否则 panic 兜底 + handler defer 会双减。
- **`concurrency <= 0` = 不限制**，但仍计数：旧快照没有这个字段，不能被静默变成「不可选」。
- **饱和不排队**：全饱和直接 503 `ALL_ACCOUNTS_SATURATED`，不要改成等待或静默放行——排队会把
  延迟堆到网关里。
- **`Apply` 必须在 pre 之前跑**：否则 `exclude_saturated` / `exclude_cooling` 看到的还是上一轮的值。
- **注入面按消费者拆**：engine 只依赖 `Apply` / `Acquire`，transport 只依赖 `RecordLimit`，
  `modules/*` 之间零 import，实现在 `internal/accountruntime`，组装只允许在 `main.go`。
- **`accounts.status` 加字段用 `omitempty`**：没有注入运行时（测试 / 旧装配）时该键不出现，
  响应与改动前逐字节一致。
- **anthropic 错误体加 `code` 是纯增量**：别把 `code` 放顶层，也别在空 code 时输出 `"code":""`；
  OpenAI 两个入口的错误体必须逐字节不变（有断言守着）。

### key 级执行面与定价闸门（owner 第 6 / 8 / 10 条）

- **两条闸门都是 pre 相位、都在 key-auth 之后**：`modules/keygate`（过期 / 金额上限 / key 并发 /
  用户并发）与 `modules/pricinggate`（未定价模型）。它们只判定，不写存储、不碰余额。
- **pre 相位的槽位用 `Ctx.ReleasePreSlot`，不要抢 `ReleaseInFlight`**：后者由 `engine.runAttempt`
  在 dispatch 里写，pre 阶段也写就会被覆盖 → 槽位泄漏。engine 在「产生响应」时把两者串起来
  （一起活到响应含整个流写完），走不到 dispatch 的出口（pre 拒绝 / 无可用账号 / panic）由
  engine 的 defer 兜底释放。两个 release 都必须幂等。
- **用户级并发上限是独立判定**：不能因为「key 自己没配上限」就跳过 keygate——否则只给用户设了
  上限会静默失效（真进程用例抓过这个 bug）。
- **金额上限靠 `keyspend.replace` 心跳快照**：花钱的事实只有 TS 知道（结算与算价都在 TS），
  Go 只读、只比大小。消费快照不可用 / 快照里没有这个 key 时**放行 + 计数**（`spendingUnknown`）：
  上限是运营保护，不是钱（钱由额度闸门 + 后付费结算兜底）。
- **定价闸门默认关（`-pricing-gate`）**，且是 **fail-closed**：快照没收到 / 超过 TTL → 503
  `PRICING_SNAPSHOT_UNAVAILABLE`，模型没价 → 403 `MODEL_NOT_PRICED`。与额度闸门 / 内容审核
  相反（那两个是可用性优先），因为这是「准入」不是「保护」。
- **`*` 兜底价两处必须同口径**：Go 的 `internal/pricing.Priced()` 与 TS 的
  `billing.hasPrice()` 都是「精确命中 或 有 `*`」；两处不一致会出现「billing 认为有价、
  闸门认为没价」的分裂。Go 侧与 TS 侧各有用例。
- **价格快照同样必须心跳式**：内容不变也推（`revision` 相同、`generation` 递增）。定价闸门
  是 fail-closed，「没变就跳过」会在 TTL 一到把全部请求打成 503（额度闸门 2026-10-29 同一类错误）。
  推送方是新插件 `gate-feed`（服务名 `gateFeed`，`packages/gate-feed`）：它只读 pricing /
  api-key / usage，自己不存数据；`apiKey` / `usage` 运行期解析（被禁用时只少一份快照）。
- **跨层金额一律十进制字符串**：`spendingLimitMicros` / `spentMicros` 都是十进制微元字符串，
  Go 解析失败即**整份拒绝**该快照（不按 0 处理）；`limit` 大小比较在 Go 侧用 int64。
- **部署顺序「先 Go 后 TS」**：新桥命令（`pricing.replace` / `keyspend.replace`）在旧 Go 上返回
  `BRIDGE_METHOD_NOT_FOUND`（TS 节流告警、LLM 请求不受影响）；反过来「新 Go + 旧 TS」=
  从没收到快照 → 定价闸门 fail-closed 全 503。**打开 `-pricing-gate` 必须等新 TS 上线**。
- **真进程用例是真证据**：`packages/api-key/test/gateway-gates.test.ts` 覆盖 401 / 402 / 429（key 与
  用户两级）/ 403 / 503（无快照与超 TTL）/ `*` 兜底，并断言「被拒的请求上游 0 次」与
  「请求结束后槽位归零」。改这两个阶段先 `pnpm build:go`。
- **`gate-feed` 的消费聚合必须带缓存**：`usage.summary({ apiKeyId })` 是 **O(历史行数) 的全表聚合**
  （内部两次 `foldAggregates`）。真实规模实测（40 万行 usage_records / 20 个设了上限的 key）：
  **906ms / 轮**，按 5s 心跳折算 = 单核 18%，而且随行数线性增长。正确做法是拿
  `usage.status()` 的本地游标（`epoch:lastSeq`）+ key 集合签名做缓存：**心跳照推、
  内容复用**（`revision` 相同、`generation` 递增），游标前进或 key 集合变化才重算。
  `gate-feed.status()` 的 `spendRecomputes` / `spendReuses` 就是这个护栏的观察口。
  彻底修法是在 `usage` 插件加一个按 key 分组的一次性聚合（那是 `用量` 线的事）。
- **上线纪律：`-pricing-gate` 打开后，禁用 `pricing` 插件 = 全站 503**。`gate-feed`
  `inject` 了 `pricing`（价格唯一写者），它 PENDING 就不推快照；而定价闸门是 fail-closed。
  所以：开闸门前必须确认 `pricing.status.ready === true && stale === false`，并且
  `pricing.status` / `keyspend.status` 都**显式给出 `stale` 与 `ageMs` / `ttlMs`**
  —— 线上 503 了必须能一条桥响应看出原因，不能只留在日志里。

### 前端

- 预览用 `pnpm preview:console`；它没有 `/api/*`，真实进程用 `pnpm dev`。
- 静态资源的 `<base>` 已带尾斜杠，不要重复补 `/`。
- CSP `img-src` 放行 `data:` 与 `https:`；`http://` 头像能存但会被拦。
- **`el.setAttribute('style', …)` 会被 CSP 拦掉，而且症状极难认**（2026-10-29 实测）：
  `getAttribute('style')` 能读回 `"left: 123px"`，但 `getComputedStyle(el).left` 是 **`auto`**、
  `position` 是 **`static`** —— 属性写进去了、样式一个字没生效。**CSSOM 赋值
  （`el.style.left = …`、`Object.assign(el.style, …)`）不受限制**。所以：
  浮层/弹层定位一律走 CSSOM；页面里不许写 `style="…"`（原先 27 处全被拦，等于从没生效过）。
  这条没有「加 nonce」的解法：`style-src-attr` 不支持 nonce（nonce 只对 `<style>` / `<script>`
  元素有效），唯一能救它的是 `'unsafe-inline'`，那是把全站 CSP 拆掉。
- **内联 `<style>` 元素同样被拦**（`style-src-elem`）：`renderDocument` 的「不给 assets 就内联」
  那条路径**只能给测试用**，生产必须走 `/assets/app.css` 外链。
- **htmx 的 indicator 样式要自己出**：htmx 默认 `insertAdjacentHTML` 注入一段内联
  `<style>` 给 `.htmx-indicator` / `.htmx-request` 上样式，被 `style-src 'self'` 拦掉
  （实测 1 条 `style-src-elem` 违规）。做法：`app.js` 里设
  `htmx.config.includeIndicatorStyles = false`，等价规则**写进服务端 CSS**
  （`COMPONENT_CSS`）——不能靠 JS 补，否则首屏第一次请求 indicator 会裸奔。
  `<meta name="htmx-config">` 那条路实测**不可靠**（config 仍读到 `true`），别用。
- **htmx 配置没有「窗口期」，但顺序必须对**（2026-10-29 实测三变体）：htmx 的 `init` 挂在
  `DOMContentLoaded` 上，所以只要 `app.js` 是**经典脚本、放在 htmx 之后**（body 末尾或 `defer`
  都行），设 `htmx.config.…` 一定赶在 htmx 初始化之前。反过来把 `app.js` 挪到 htmx **之前**
  （比如放 `<head>`），那时 `window.htmx` 还是 `undefined`，配置设不进去，htmx 就按默认值注入
  ——**实测只有这种写法出违规**。
- **`jsHrefs` 的顺序是契约**：当前是 `[tom-select, flatpickr, /assets/app.js]`
  （`app.js` 必须最后）。将来把 htmx / floating-ui 加回来时，`floating-ui.dom` 的 UMD 读全局
  `FloatingUICore`，必须排在 core 之后；htmx 要排在 `app.js` 之前（`app.js` 要改它的 config）。
  `page-template/test/page-template.test.ts` 有用例钉住顺序，且**没被用到的库一旦出现在
  引用列表里就会红**。
- **vendor 的库照白名单发字节**（`page-template/src/vendor.ts`）：查表而非拼路径，
  名字不在表里就 404。加库只改那张表，`VENDOR_SCRIPT_ORDER` / `vendorCss()` 都从它派生。
- **`VENDOR_SCRIPT_ORDER` 只放「现在真的有代码在调」的库**，不是「白名单里有的库」。
  2026-10-30 实测事故：htmx（52 KB）+ floating-ui（22 KB）挂在**每一个**页面上（连
  `/login`、`/register` 都下），而全站 `hx-*` 属性与 `FloatingUIDOM` 调用各 0 处 —— 74 KB
  死代码。摘掉时**保留**白名单条目、字节、LICENSE、`client-script.ts` 里的 `htmx.config`
  护栏与 `htmx:afterSwap` 监听（`window.htmx` 是 undefined 时它们空转，无副作用）。
  htmx 在第 4 批（侧栏局部刷新）加回来，floating-ui 在 tooltip 加回来。
- **静态资源的 URL 一律带内容哈希**（`web/src/asset-version.ts`，2026-10-30 加）：
  `/assets/app.css?v=<8 位内容哈希>`、`/assets/app.js?v=…`、`/assets/vendor/<name>?v=…`
  （`vendorHref()`）。因为这些字节用 `public, max-age=31536000, immutable` 发出去，而
  **`immutable` 只有在 URL 随内容变化时才成立**——路径固定就等于「升级了带安全修复的库、
  回访浏览器一年不换」。页面里的地址必须来自 `APP_CSS_HREF` / `APP_JS_HREF` / `vendorHref()`，
  **不许手拼 `VENDOR_ASSET_PREFIX + name`**（有单测钉着）。
  `app.css` 的正文只有一处来源（`APP_CSS_BODY`），路由直接发它——两边各拼一次必然漂。
  **已知债**：`/assets/fonts/*.woff2` 仍是固定路径 + `immutable`（字体 URL 由 `font-smiley`
  的 CSS 生成，要版本化得改那个插件）；字体极少变，暂时记债。
- **不在 GitHub 上找 CDN**：CSP 是 `'self'`，第三方库一律 vendor 到
  `packages/page-template/assets/vendor/`，每个库带自己的 LICENSE（Apache-2.0 还要保留
  版权声明）。现有四个：htmx 2.0.11（Zero-Clause BSD）、Tom Select 2.4.3（Apache-2.0）、
  flatpickr 4.6.13（MIT）、floating-ui dom/core 1.8.0（MIT ×2）。
- **`@floating-ui/dom` 的 `.browser.mjs` 不是自包含的**：它仍有裸 import
  （`import{…}from"@floating-ui/core"`），浏览器直接报 `Failed to resolve module specifier`；
  而 import map 只能是内联 `<script>`，CSP 一样拦。**用 `core.umd.min.js` + `dom.umd.min.js`
  两个经典脚本**（core 自包含，dom 读全局 `FloatingUICore`），顺序不能反。

### API 文档（第 5 条）

- **API 文档 = 叙述（`docs/api/*.md`）+ 派生事实（`api_facts.ts`）**，两者分工不能混：
  - `docs/api/` 下四个文件（`01-overview` / `02-endpoints` / `03-errors` / `04-examples`，顺序由
    `packages/web/src/content/api_docs.ts` 的 `DOC_FILES` 定）**只写人话**：认证、每个入口的
    请求 / 响应要点、错误体形状、流式差异、curl 示例、有损面。改文档就是改 `.md`。
  - **事实性清单（入口表 / Go 错误码表 / 产品错误码表）一律不写进 `.md`**，由
    `packages/web/src/content/api_facts.ts` 渲染时**从代码实时读**：`internal/httpapi/server.go`
    的 `mux.HandleFunc`（方法看 handler 体、协议读 `contracts.ProtocolXxx`、Gemini 前缀路由用
    `gemini.go` 的方法名展开）、三种 Go 错误构造（`contracts.Errorf` / `writeErrorFor` /
    `&contracts.StageError{}`）、`packages/api/src/errors.ts` 的 `ApiErrorCode` 联合 +
    `EXPLICIT_STATUS` + `statusOfCode()` 后缀规则 + 各插件 `new ApiError(...)` 字面量、
    `contracts/ir.go` 的协议常量。
  - 装配方式是 `.md` 里的三个占位符：`<!-- facts:entries -->` / `<!-- facts:gateway-errors -->` /
    `<!-- facts:product-errors -->`，**每个必须恰好出现一次**，否则渲染明确报错（不静默漏表）。
  - **为什么这么分**：手写清单会腐烂——代码加了入口，文档不知道，测试只能红成「文档没更新」。
    派生之后代码一改页面自动跟上，`.md` 只负责讲人话。
    `pages-docs.test.ts` 里那条「反模式护栏」就是守这个：`.md` 里出现入口表行 / 错误码表行直接失败。
  - 新增一个 `.md` 文件必须同时加进 `DOC_FILES`，否则用例报「清单与磁盘不一致」。
  - 用例还守：页面必须带上**派生出的每一条**入口与错误码（漏一条就是装配断了）、每个真实入口
    都要有详情小节且详情里的路径必须真实（代码删了入口，那节就是过时的 → 报错）、派生出的
    出处文件真的存在且真有这个码、错误体键在 `RenderError` 里、终止符与 codec 一致、
    协议名在 `contracts/ir.go` 里。
- **markdown 渲染器是 vendor 的 `markdown-it` 14.1.0（MIT）**，在
  `packages/web/src/vendor/markdown-it.min.cjs`（123 618 字节，UMD，自包含：0 处
  `require(` / `import` / `window.` / `document.`）+ 相邻的手写声明
  `markdown-it.min.d.cts` + `packages/web/src/vendor/LICENSE`。导入写法是普通的
  `import MarkdownIt from '../vendor/markdown-it.min.cjs'`。
  **故意不用 npm 依赖**：服务器部署走 `pnpm install --offline` 复用已有 store，新增依赖会让
  线上部署断掉（store 里没有任何 `*markdown*`，`pnpm-lock.yaml` 也没有）。
  **扩展名必须是 `.cjs`**：仓库根 `package.json` 有 `"type": "module"`，`.js` 会被当 ESM 解析，
  而 UMD 包装头是 `typeof exports === "object" && typeof module !== "undefined" ? …` ——
  在 ESM 语境下两个都不存在，`require()` 只拿到空对象（`typeof object`、`Object.keys` 为空、
  `new` 报 not a constructor）。**同一份字节改成 `.cjs` 就能正常 render**，与库本身无关。
  声明必须用**相邻同名 `.d.cts`**，不要用 `declare module '*.cjs'` 通配（那会把所有 `.cjs`
  都当成 markdown-it）。升级时替换 `.cjs` + `LICENSE` 并在这里记版本。
- **markdown 渲染不得写内联样式**：CSP 是 `style-src 'self'`，`style="…"` 会被浏览器
  静默丢弃（浮层直接跑位）。渲染器把结构映射到模板已有 class（`.panel` / `.table` /
  `.mono` / `.code` / `.section-title` / `.page-title`），有用例守着「渲染结果里没有 `style=`」。
- **`/llms.txt` 与 `/console/api-docs.md` 不是 `/api/*`**：生产 nginx 只把 `/api/*` 反代到
  api 的 7791，其余（含这两条）都打到 web 的 7792，所以它们**必须由 web 插件发**
  （`packages/web/src/service.ts` 的 `dispatch` 里调 `content/api_docs.ts` 的
  `apiDocsResource(path)`，纯函数，返回 `{status, contentType, body}`）。
  放 `packages/api/src/http.ts` 在线上必 404。
  **这两条不要求登录**：它们就是给 agent 抓的（owner 明确要「方便投喂 agent」），内容里
  没有秘密；页面本体 `/console/api-docs` 仍然要登录。
- **部署必须带上仓库根的 `docs/api/`、`contracts/`、`modules/`、`internal/` 与 `packages/*/src`**：
  文档的叙述从 `../../../../docs/api/` 读，事实表还要**读 Go 与 TS 源码**（`internal/httpapi/server.go`、
  `internal/httpapi/gemini.go`、`contracts/ir.go`、`packages/api/src/errors.ts`，并递归扫
  `contracts` / `modules` / `internal` 的 `.go` 与 `packages` 的 `.ts`）。所以 web 进程的部署树里
  **必须有源码**，不能只发 `bin/` 与 `dist/`。现在用 `git archive` 全量导出，天然满足；
  将来若改成精简部署，必须把这些目录一并带上，否则这一页报「读不到源码」。
  读失败**只影响这两条路由与该页**，不会拖垮整个 web 插件（见下条）。
- **读文档不能放在模块顶层**：`pages/index.ts` 会把所有页面 import 进来，模块顶层
  `readFileSync` 抛错会连带整个 web 插件装载失败、全站不可用。文档缺失是内容问题，
  只能让这一页报错。

### 控件（第 3 / 11 条）

- **控件一律「原生元素的语义 + 自绘的浮层」**，也就是**渐进增强**：服务端输出的是一个
  真能用的 `<select>` / `<input type="date">` / `<form>`，只多一个 `data-*` 钩子；
  `app.js` 把钩子升级成 Tom Select / flatpickr / 自绘确认框。JS 没跑（被拦 / 加载失败 /
  还没解析到）时浏览器原生控件照常可用、表单照常提交。**这是刻意选的形状，不要改成
  「只输出组件的 div」**——那会把「JS 挂掉就整页不能填表」变成新的失败面。
- **页面源码里不许出现原生控件与内联样式**，四条护栏在 `packages/web/test/pages-guards.test.ts`
  逐条守着（任一不过就是有人退回去了）：
  `style="…"`（CSP 会静默丢弃）、`<select`、`type="date"`、`window.confirm`。
  新写页面要控件时用 `pageTemplate` 的 `renderSelect` / `renderSelectShell` /
  `renderDatePicker` / `renderConfirmDialog`，不要自己拼标签。
- **两个下拉入口的区别**：`renderSelect({ options: [{value,label,selected}] })` 适合普通场景；
  `renderSelectShell({ optionsHtml })` 用于选项 HTML 已经在别处拼好（例如审计页的动作列表、
  账号页的批量动作）——它**原样透传** `optionsHtml`，所以调用方自己负责那段 HTML 的转义。
  `allowEmpty` 默认为真：筛选器的「全部」就是那条 `value=""` 的空首项，且**只在没有任何
  选项被选中时才占 `selected`**（两个 `selected` 会让浏览器取错）。
- **升级脚本必须幂等**：`CLIENT_JS` 的 `upgradeControls()` 用 `.tomselect` / `._flatpickr`
  两个属性判断「这个控件已经升级过」，命中就 `continue`。重复初始化会把已升级的控件
  炸回空白下拉。`htmx:afterSwap` 之后会再跑一次（第 4 条局部刷新靠这条），所以幂等是硬要求。
- **单个控件失败不许中断整页脚本**：两个升级各自 `try / catch` + `console.warn`。
  一个下拉初始化失败不能顺带把确认框、htmx 配置、后面的控件一起停掉。
- **模态弹窗用原生 `<dialog>`**（`showModal()`）：焦点陷阱、ESC 关闭、`::backdrop` 交给浏览器，
  外观全自绘（`.dialog*` 在 `layout-classes.ts`）。**不要自己实现焦点陷阱**——
  手写的版本在 Safari / 移动端都会被 tab 键绕出去。
- **控件渲染有单测**：`packages/page-template/test/controls.test.ts`（22 条）断言「无 JS 可用」
  （原生元素在、`name` / `value` / `selected` 对、转义到位）和「有 JS 能升级」（钩子、
  幂等守卫、`try/catch`、`htmx:afterSwap` 重跑），以及下面这几条踩过的坑。
- **`CLIENT_JS` 单独一个文件**（`packages/page-template/src/client-script.ts`，`assets.ts`
  只重新导出）。它现在是站点行为的唯一入口，和像素级 CSS 混在一个文件会同时违反
  「一个文件一个职责」与单文件行数上限。**不要往 `assets.ts` 里塞脚本**。
- **vendor 库的外观必须自己重画**（`packages/page-template/src/vendor-theme.ts` 的
  `VENDOR_THEME_CSS`）：Tom Select 与 flatpickr 都自带**浅色主题**，直接 vendor 进来会在
  深色站上出现白色下拉框与白色日历。只覆盖颜色 / 圆角 / 间距 / 字号，**不碰定位**
  （浮层定位由库自己用 CSSOM 算）。
  **拼接顺序是契约**：`PAGE_CSS + COMPONENT_CSS + LAYOUT_CSS + MODAL_CSS + vendorCss +
  VENDOR_THEME_CSS`。同优先级按顺序取胜，主题必须排在 `vendorCss` **之后**，否则被浅色盖回去。
- **`.ts-hidden-accessible` 得自己写**：Tom Select 给原始 `<select>` 加了这个类名，
  但**规则不在它的 min.css 里**（截图实测：原生下拉和 `.ts-wrapper` 同时显示，
  表现为同一行两个「全部动作」、控件比同排输入框高一截）。`VENDOR_THEME_CSS` 里补了一份
  标准写法（`clip: rect(0 0 0 0)` + `position: absolute` + `!important`）。
- **Tom Select 会把原生控件的 class 抄到自己的 `.ts-wrapper` 上**：我们的 `<select
  class="input">` 于是让 wrapper 也带 `.input`，两层边框内边距叠加成「框里套框」、
  比同排控件高。升级后要 `wrapper.classList.remove('input')`——皮肤归 `.ts-control`。
- **原生 `<input type="date">` 升级成 flatpickr 前要改成 `type="text"`**：否则浏览器自带的
  日历图标与 flatpickr 的浮层叠在一起。改 `type` 是 DOM 属性赋值，不涉及 `style`，CSP 不管。
- **弹窗里的 flatpickr 日历要搬进 `<dialog>`**：`<dialog>` 用 `showModal()` 打开后在
  **顶层（top layer）**，而 flatpickr 把日历挂在 `document.body` 上——会被 backdrop 盖住，
  日历 `open` 类加上了、屏幕上什么都没有。搬进最近的 `<dialog>` 就能进顶层；但换父元素
  改变了定位参照系（dialog 是定位元素），flatpickr 按文档坐标算的 `left/top` 会跑偏，
  所以 `CLIENT_JS` 里要在 focus/click 之后**按视口重算一次**（含「下面放不下就上翻」），
  并把 dialog 的 `overflow` 放开（`hidden` 会把日历裁掉）。
- **异步闭包里不要用循环变量**：`for (var j …)` 里 `dates[j]` 被 `setTimeout` 捕获，读到的
  是循环结束后的 `j`（= length，`undefined`），表现为「逻辑明明写了却没生效、而且不报错」。
  这是「日历位置纠正不生效」的真因。先把当前元素取成局部变量再用。
- **行内筛选栏用 `.form--inline`，不要用老的 `.inline-form`**：`.form` 是纵向列容器，
  `.input` 又是 `width: 100%`，`display: inline` 的写法实际效果是每个控件各占一行
  （审计页筛选栏一直是上下堆着的）。`.form--inline` 给行容器 + 控件显式宽度，
  Tom Select 的可见框是 `.ts-control` 不是 `.input`，高度要单独钉住才和同排输入框等高。
- **弹窗打开后要把焦点放到第一个输入框**：否则浏览器把焦点给右上角的关闭按钮，
  每次打开都有一圈焦点环，看起来像按钮坏了。`CLIENT_JS` 打开后 focus
  `.dialog__body--modal input.input`。

### 字号与图表几何

- **字号只有一个源**：`packages/page-template/src/tokens.ts` 的 `FONT_ROLES`（9 档 × `size` +
  无单位 `lineHeight`）。`PAGE_CSS` 里 `--fs-<role>: calc(<n>px * var(--font-scale))` /
  `--lh-<role>` 由它派生，`page-template.test.ts` 有用例逐条比对两边（防漂移护栏）。
  **不要再往 `METRICS` 加字号字段**——它现在只放盒模型尺寸，字号字段已全部移除。
- **行高必须写无单位倍数**：`line-height: 1.5` 才会跟着 `font-size` 缩放。写成 px 的话，
  用户把字号调到「特大」（`--font-scale: 1.5`）时正文 16→24px 仍压在 22px 行高上，文字重叠。
  用例里断言「CSS 里不许出现裸 `line-height: Npx`」。
- **字号档位用一个乘数**：`--font-scale`（0.875 / 1 / 1.25 / 1.5），web 的
  `/assets/theme.css` 覆盖这一个变量就够了，不用重写九条。
- **图表轴宽是按字号派生的，不是固定 7.5px/字符**：原先
  `estimateAxisLabelWidth = text.length * 7.5` 是在**轴文字 12px** 下标定的（7.5/12 = 0.625em）。
  字号上调后仍按 7.5 硬算会让字宽被低估约 17%，y 轴刻度被 SVG 左边界裁掉。
  现在用 `axisPaddingLeft(widestTick, fontSize)`（`charts.ts` 两处重复已合成一份），
  上下限 `AXIS_PADDING_MIN/MAX` 也随字号同比缩放——`60` 就是 12px 下 7 字符刻度的临界值。
- **图表几何是服务端算的，字号是用户可选的**：所以渲染函数有 `options.fontScale`，
  调用方必须把当前用户的档位传进去，否则用户选「特大」时图表仍按默认档排。
- **`packages/deepseek-usage` 是 `page-template` 的整份重复副本**（自带 `tokens.ts` /
  `render.ts` / `client.ts`，同样有 7.5 魔数、同样 `.axis-text 12px`）。它是**已禁用**的像素
  参考，改 `page-template` 时**不要**顺手改它，也别以为它会跟着变。

### 测试

- **写侧放宽、读侧收紧 = 重启后整份文件读不出来**。`identity` 的 `weight` 允许小数，
  但 `decodeAccount` 曾用「整数」读回：写 `weight: 1.5` 能成功、也落了盘，进程重启时
  `IDENTITY_STORE_CORRUPT` → identity 插件装载失败 → 账号缓存清空 → 全部 503。
  加字段时**写侧与读侧的校验必须同口径**，而且要有一条「真重开 store」的用例守着；
  只断言内存里的返回值抓不到这类问题。
- **`account-priority` 的用例会因机器负载偶发失败**：它真的 spawn 子进程
  （`node test/fixtures/fake-gatewayd.mjs`）。同时开着常驻预览服务 / 别的构建时，子进程
  启动会慢于断言，`status().pid` 还是 `null`，用例报「卸载插件会停止子进程」或
  「等待条件超时」。这不是功能回归：**先停掉常驻预览服务再单独复跑**，绿了就是负载问题。
- **`fetch` 屏蔽端口会造成随机假失败**：测试用 `WebService({ port: 0 })` 拿随机端口，偶尔会分到
  WHATWG fetch 规范屏蔽的端口（`0`、低位端口、`6665–6669`、`6697`、`10080` 等），undici 在发请求前
  就抛 `bad port`——单独复跑必绿、全量并行偶发红。web 测试统一走
  `packages/web/test/helpers/fetch-port.ts` 的 `listenFetchable()`（命中就关掉重绑，最多 12 次），
  新写「起临时 server + fetch 打自己」的用例必须用它，不要直接 `port: 0` + `fetch`。
- 验证「是不是我改坏的」用 `git stash push -- <改动文件>` 做对照，跑完记得 `git stash pop`。
- **C 盘空间是这台机器的隐形地雷**（2026-10-29 实测）：C 盘只剩 0.62 GB 时 `go test` 链接器报
  `not enough space on the disk`，7 个包 build failed——**看起来像代码坏了，其实是磁盘满了**。
  Go 的构建缓存与临时目录已用 `go env -w` 永久挪到 `D:\gocache` / `D:\gotmp`（跨终端有效）。
  再遇到 `not enough space on the disk` 先看磁盘，别去改代码。Go 模块缓存
  （`~/go/pkg/mod` 2.7 GB）与 pnpm store（`E:\.pnpm-store`）别乱删。
- **`skip` 不算绿**：真进程用例（`packages/content-audit/test/gateway-smoke.test.ts`）没有
  `bin/gatewayd` 时会 skip。改了 Go 侧链路就**先 `pnpm build:go`**，再看用例数里的 skip 数
  ——基线是 1 个 skip（那是真 skip），多出来的都是「因为没编二进制而没跑」。


---

## 8. 当前边界

以下仍是目标，不要当成已实现：

- 描述符下发、profile 编排、按 profile 切换阶段
- `quota-check`、`settle`
- **真实支付通道**：只有 `manual`（线下转账 + 管理员人工确认）；没有在线支付、没有回调验签、
  没有发票 / 退款 / 对账文件。`PaymentProvider` seam 已留好，接渠道时按 §7「充值与支付」补
- **扣费是「后付费 + 闸门」**：结算已做（幂等 reqId、读时算价→按真实 usage 结算、余额原子调整），
  额度闸门也已做（余额快照 + pre 相位 402）。仍缺：**预扣 / 冻结**（没有「最多能花多少」的上界）、
  **并发中的花费不会计入预检**（同一用户在结算前可以连续打多笔）、严格模式默认关。
  用量页的「费用」与 `billing` 的真实扣费是两套口径，同一条记录可能不同（没配价的模型尤其）
- 用量的投递边界：Go 只有内存环形缓冲（默认 32768 条）+ TS 轮询（默认 1s），gatewayd 重启
  或长时间断线仍会丢记录（`gap` 会记警告、`usage.stats` 可查）；请求 / 响应正文不落库；
  被隔离的坏记录不结算、需要人工在 `/admin/usage` 处理
- 冷却只有「429 / 额度耗尽」这一种触发，且只在进程内：**没有**响应时间阈值，也没有
  过热 / 过载 / 临时不可调度三时钟；`accountpriority` 的 preview / pick 仍看 TS 传来的
  `InFlight`（LLM 链路已用真实值，预览不反映闸门）
- 自动禁用只按「连续失败 3 次」（可配）；**不做响应时间阈值**，也不做冷却 / 过载 / 临时不可调度
  三时钟（缺 Go 的失败回报数据源）。
- `account-state`（限流、额度、并发等运行时状态）、粘性会话
- **多模态入口只有 embeddings**：`images` / `audio` / `batch` / `files` 都还没有；
  embeddings 只支持 OpenAI 兼容上游
- **内容审核的边界**：只做大小写不敏感**子串**匹配（要正则得先解决 ReDoS：超时 / 隔离执行）；
  只审**用户输入文本**（system / assistant / 工具结果 / 响应正文都不审）；单请求扫描上限
  256 KiB / 256 段文本，超出部分计 `truncated` 后不审（有损）；没有规则热更新以外的
  灰度 / 例外名单 / 命中样本留存（命中只记 ruleId + category，**看不到被拦的原文**）；
- **可观测的剩余缺口**：有 `/metrics` 与运维总览，但**请求 / 响应正文不落库**、
  没有直方图分位数、错误率要从状态码自己算、`account-health` 的自动动作**不进审计**；
  `/api/health` 的 components 仍只覆盖少数插件
- 跨协议转换的**有损面**：`thinking.signature` 不回传、`cache_control` 丢弃、OpenAI 专有采样
  参数丢弃——都记 `LossyNote` 日志，但不保证语义等价
- 模型映射只改**请求**里的模型名：响应里的 `model` 保持上游原名，不映射回对外名。
  另有 `models` 与 `modelMap` 之间不做交叉校验（可以给没列进 `models` 的模型配映射）
- 前端视觉打磨（等 owner 的参考设计）
