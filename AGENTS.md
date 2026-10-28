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

### 4.1 TS 插件（23 个包；`console` 是已禁用的 SPA，`kit` 是共用底座）

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
| `contracts/` | 唯一共享契约；`Ctx` / `Stage` / `Decision` / `Registry` / DTO；规范化 IR 与 `Codec` 接口（`ir.go` / `protocol.go`）；用量记录与桥事件（`usage.go`）；只依赖标准库 |
| `modules/accountpriority/` | 账号打分、排序、选择；候选全被闸门挡住时区分 `ALL_ACCOUNTS_SATURATED` / `ALL_ACCOUNTS_COOLING`（都是 503、不可重试） |
| `modules/modelroute/` | 模型路由（pre 相位按账号 `models` 过滤候选）+ 模型映射（dispatch 相位按账号 `modelMap` 改写 body 顶层 `model`） |
| `modules/protoconv/` | 协议转换中间件：dispatch 相位阶段（请求方向）+ 响应转换器；Chat / Responses / Anthropic 三个 codec |
| `modules/transport/` | 按选中账号发上游请求，透传普通响应与 SSE；按协议的方言表决定路径与鉴权头；429 / 额度耗尽（`insufficient_quota` 等）记账号冷却并回可重试错误 |
| `modules/keyauth/` | 动态 API key 哈希快照校验 |
| `internal/bridge/` | 控制桥：长度前缀 JSON、UDS / 回环 TCP、优雅关闭 |
| `internal/engine/` | pre → dispatch → post 调度；失败转移；统一错误渲染；**并发闸门**（dispatch 前按 `concurrency` 原子预留，预留失败换下一个账号、全饱和直接 503 不排队） |
| `internal/accounts/` | 账号 / 令牌只读快照缓存 |
| `internal/accountruntime/` | 账号运行时状态（纯进程内）：真实 in-flight 计数 + 429 / 额度耗尽短期冷却；`Apply` 把真实值写进候选快照给打分用、`Acquire` 原子预留槽位（release 幂等）；不落盘、不上桥、不回写 TS |
| `internal/apikeys/` | API key 哈希快照缓存；`Ready()` 区分「没收到」与「空快照」 |
| `internal/usagelog/` | 用量环形缓冲（容量可配，默认 32768，边界 1..1048576，非法值启动失败；满了丢最旧并计数 `dropped`，其中「没被任何 reader 取走就被覆盖」单独记 `gap`）；`Seq` + `Epoch`，经 `usage.since` 给 TS 轮询，`usage.stats` 给 TS 告警 |
| `internal/usageprobe/` | 用 codec 从**发回客户端**的响应字节里提取 usage（流式只观察不改字节）；按上游协议归一化四桶 |
| `internal/httpapi/` | `POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages`、`GET /v1/models`、`GET /healthz`；请求结束写用量记录；响应（**含整个流**）写完后释放并发槽位 |
| `cmd/gatewayd/` | 组合根：注册模块、启动 HTTP 入口与控制桥 |

### 4.3 数据与端口

- 数据：`data/users.db`、`data/auth.db`、`data/api-keys.db`、`data/accounts.json`、
  `data/credentials.json`、`data/settings.json`、`data/account-priority.json`、
  `data/pricing.json`、`data/usage.db`、`data/redeem.db`、`data/billing.db`、`data/frontend/`。
- 用量只有 `usage` 插件写 `usage.db`（含 `usage_rejected` 隔离表）；结算账本只有 `billing`
  插件写 `billing.db`；价格只有 `pricing` 插件写 `pricing.json`；
  兑换码只有 `redeem` 插件写 `redeem.db`（只存 sha256 与掩码）；
  Go 只把用量放进内存环形缓冲，不落盘。
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
- 用量记录：Go 在请求结束时采集「谁用的 / 哪个账号与模型 / 四个 token 桶 / 耗时 / 状态 /
  客户端 IP」，经控制桥 `usage.since` 由 TS 轮询落 SQLite；`/api/usage`（用户）与
  `/api/admin/usage`（全站）提供明细、汇总、按天/按模型/按用户聚合与 CSV 导出；
  `/console/usage` 只加明细表，`/admin/usage` 是独立页面
- 模型价格：`/api/pricing` 读、`/api/pricing/:model` 读写（写需管理员），`/admin/pricing` 页面；
  用量费用在**读取时**按价格表计算（整数微元，1 元 = 1_000_000 微元）
- **真实扣费（`billing`，后付费）**：`usage` 每轮 `usage.since` 拉到用量后，按
  「拉取 → 落库 → 结算 → 推进游标」的顺序调 `billing.settle(本轮**落库成功**的记录)`；
  `req_id` 唯一键 + CAS `pending → settling → settled` 保证同一请求只扣一次，价格用 `pricing`
  快照复算（不信 Go 传的金额），扣款只经 `user.adjustBalance`（余额允许为负，记 `overdrawn`
  + 扣后余额）；结算失败**不推进游标**，下一轮带同一 `afterSeq` 重放补结算；
  `settling` 崩溃残留靠「余额流水里有没有这笔扣款」判定收尾，判不出就转 `review` 人工核查
  （宁可少收一笔，绝不重复扣款）。`/admin/billing` 与 `/api/admin/billing` 可查记录、透支与汇总。
  **没有预扣、没有支付通道**：充值订单仍是 501
- 坏记录有界隔离（`usage_rejected`）：同一条用量连续落库失败到 `rejectAfterFailures`（默认 10）
  后不再重试，改逐条独立事务——能插的插、插不进的写隔离表，游标推进到该批最大 seq；
  被隔离的记录**不结算不扣钱**，`/admin/usage` 可看原因并「忽略 / 重放」（重放靠 `req_id` 幂等，
  `billing` 不在运行时重放明确失败，不做「只记明细不扣钱」的降级）
- 用量投递健康度：`usage.stats` 桥命令给 TS 报 `capacity/size/dropped/gap/epoch/lastSeq`，
  `gap` 只统计「真丢」的部分；轮询默认 1s，落库失败不吞错、游标只推进到实际落库的最大 seq
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
- 当前基线（2026-10-29 实测，main `991691f`）：`pnpm test` 566 个用例（565 通过 / 1 跳过），
  `pnpm typecheck` 干净，`go test ./...` 15 包全 ok，`gofmt -l .` 与 `go vet ./...` 无输出。
  这个数字会变，以实际输出为准。

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
```

### 6.2 部署

- 生产服务器 `<生产服务器>` / `<SERVER_IP>`（root），代码 `/opt/dizzyapi`，systemd `dizzyapi.service`；
  公网入口 `https://<站点域名>`：宝塔 nginx 把 `/v1/*` 与 `/healthz` 反代 gatewayd
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

### 前端

- 预览用 `pnpm preview:console`；它没有 `/api/*`，真实进程用 `pnpm dev`。
- 静态资源的 `<base>` 已带尾斜杠，不要重复补 `/`。
- CSP `img-src` 放行 `data:` 与 `https:`；`http://` 头像能存但会被拦。

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
- 验证「是不是我改坏的」用 `git stash push -- <改动文件>` 做对照，跑完记得 `git stash pop`。

---

## 8. 当前边界

以下仍是目标，不要当成已实现：

- 描述符下发、profile 编排、按 profile 切换阶段
- `quota-check`、`content-audit`、`settle`
- Go 侧用户 / 额度 / 计费 / 支付；充值订单目前 501
- **扣费仍是「后付费 + 无闸门」**：结算已做（幂等 reqId、读时算价→按真实 usage 结算、余额原子调整），
  但**没有预扣/预检**，余额 0 也能继续打；余额不足照实扣成负数。额度闸门（余额快照 + pre 相位预检）
  仍未做。用量页的「费用」与 `billing` 的真实扣费是两套口径，同一条记录可能不同（没配价的模型尤其）
- 用量的投递边界：Go 只有内存环形缓冲（默认 32768 条）+ TS 轮询（默认 1s），gatewayd 重启
  或长时间断线仍会丢记录（`gap` 会记警告、`usage.stats` 可查）；请求 / 响应正文不落库；
  被隔离的坏记录不结算、需要人工在 `/admin/usage` 处理
- 冷却只有「429 / 额度耗尽」这一种触发，且只在进程内：**没有**响应时间阈值，也没有
  过热 / 过载 / 临时不可调度三时钟；`accountpriority` 的 preview / pick 仍看 TS 传来的
  `InFlight`（LLM 链路已用真实值，预览不反映闸门）
- 自动禁用只按「连续失败 3 次」（可配）；**不做响应时间阈值**，也不做冷却 / 过载 / 临时不可调度
  三时钟（缺 Go 的失败回报数据源）。
- `account-state`（限流、额度、并发等运行时状态）、粘性会话
- Gemini 协议（`contracts.ProtocolGemini` 已预留，未注册 codec；请求它会被
  `PROTOCOL_CODEC_UNAVAILABLE` fail-closed 拒绝）
- 跨协议转换的**有损面**：`thinking.signature` 不回传、`cache_control` 丢弃、OpenAI 专有采样
  参数丢弃——都记 `LossyNote` 日志，但不保证语义等价
- 模型映射只改**请求**里的模型名：响应里的 `model` 保持上游原名，不映射回对外名。
  另有 `models` 与 `modelMap` 之间不做交叉校验（可以给没列进 `models` 的模型配映射）
- 前端视觉打磨（等 owner 的参考设计）
