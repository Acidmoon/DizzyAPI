# DizzyAPI · 项目说明书

> **本文件是 agent 的工作笔记，不是设计来源。** 设计由 owner 定：owner 说的算，
> 代码是执行的结果。本文件记的是现状、已经定下来的架构约束、以及踩过的坑，
> 供 agent 和后来的人快速进入状态。
>
> **给 AI agent 的使用方式**：动手前先读本文件，但**以 owner 的指示和代码为准**。
> 本文件与代码不一致时，以代码为准，并顺手把本文件改对——这是笔记的本分。
> 记录性的修正（现状、事实、坑）直接改；涉及设计判断的，先问 owner，
> 不要凭本文件去推翻 owner 的决定或已在运行的代码。
>
> 当前状态：**设计阶段 + 控制面插件起步**。cordis 侧已有四个包并全部装载运行（§4），
> Go 侧尚无代码；本文件中 Go 侧的一切路径与接口都是**目标**，不是现状。

---

## 1. 项目是什么

DizzyAPI 是一个自托管的**模型网关**（AI API Gateway）：把上游模型服务聚合成统一入口，
对外提供 OpenAI / Anthropic / Gemini 兼容协议，并在其上叠加账号、密钥、计费、额度与充值能力。

对标项目：

| 项目 | 定位 | 许可 |
|---|---|---|
| [sub2api](https://github.com/Wei-Shaw/sub2api) | 订阅配额分发，Claude / Codex / Grok 账号池 | LGPL-3.0 |
| [new-api](https://github.com/QuantumNous/new-api) | 多渠道聚合与分发（One API 系） | AGPL-3.0 |
| [yetone/magpie](https://github.com/yetone/magpie) | 本地优先的 agent 网关 | MIT |
| [cordiverse/cordis](https://github.com/cordiverse/cordis) | 插件元框架，本项目用作编排层 | MIT |

**与三者的根本差异**：DizzyAPI 把「组件编排与启用权威」交给 cordis，
把「形成真实流量的那部分」（转发、计费、数据库）交给 Go。

---

## 2. 架构总纲

三层：**cordis（编排与启用权威）／Go gatewayd（数据面与业务）／前端（插件形态）**。

一句话原则：

> **cordis 决定「什么在运行」，Go 决定「流量怎么走」。**

### 2.1 职责边界

| 层 | 负责 | 不负责 |
|---|---|---|
| cordis（TS） | 组件生命周期；启用／禁用；依赖与启动顺序；可逆回收；描述符下发与校验；管理台与设置面；热重载 | 请求处理；转发；计费；直连业务数据库 |
| Go gatewayd | 请求链路执行（按描述符）；上游转发与流式；鉴权；额度与计费；用量落库；对外 HTTP API | 决定哪些模块被启用；组件编排 |
| 前端插件 | 静态资源的版本与挂载；聚合已启用模块的管理页与设置卡 | 静态字节之外的任何请求路径（LLM 请求与界面请求都不经手） |

### 2.2 为什么必须有 engine

「cordis 禁用了某个模块，代码自然不执行」在**行为上**成立，但它需要一个落点：
必须有人读取「该模块被禁用」这个事实，然后不调用它。这个落点就是 Go 里的 engine。

engine 不是给 Go 增加灵活性，而是让 Go **服从** cordis 的决定：
它持有 cordis 给出的启用集，只运行启用集内的阶段，其余阶段连入口都不暴露。

### 2.3 三类流量与术语定义

本项目中的「**请求**」一词**只指用户向网关发起的大模型请求**，
**不指**插件、模块与 cordis 之间的通信。

| 类型 | 固定术语 | 路径 | 频率 | 延迟敏感 | 失败语义 | 计费对象 | 落 usage_log |
|---|---|---|---|---|---|---|---|
| 大模型请求 | **LLM 请求**（= 用户请求、推理请求） | 客户端 → 网关 → 上游 | 高 | 是（首字延迟） | 计费相关阶段 fail-closed | **是** | **是** |
| 桥消息 | **控制消息** | cordis ↔ Go，经 UDS 桥 | 低 | 否 | 可重试、可排队，但不可静默丢弃 | 否 | 否 |
| 界面调用 | **界面请求** | 用户站 / 管理台 → Go REST API | 中 | 否 | 常规 HTTP 语义 | 否 | 否 |

**五条绑定规则：**

1. **桥不承载 LLM 请求**（v1）。桥上的消息全部是控制消息，见 D3。
2. **三类流量不得共用队列、锁、限流器、连接池与日志。**
   尤其：控制面的一次大结果查询（如导出用量）绝不能与 LLM 请求争抢同一个队列或连接池。
3. **契约类型命名**：`contracts.Ctx` 只用于 **LLM 请求**作用域。
   控制消息**不得复用 `Ctx`**：它不绑定客户端生命周期、不随断连取消、也不携带 `Body`。
4. **指标分开**：LLM 请求的 QPS / 首字延迟 / 并发数，与控制消息的调用次数必须分开统计。
5. **usage_log 只记录 LLM 请求**；控制消息与界面请求的日志另走一路。

术语固定为 **LLM 请求**、**控制消息**、**界面请求** 三个词。
不要用「请求」单独指代后两者；「请求链路」「请求路径」一律指 LLM 请求的链路。

### 2.4 LLM 请求链路的规范形态

```
客户端 → 网关入口（域名 / 端口）
        → engine 载入描述符，解析 profile
  pre     → key-auth         鉴权，解析出 profile
          → quota-check      余额门槛（> 0），放行 / 拒绝
          → [content-audit]  可选，即插即用
          → account-select   选账号 + 粘性会话
  dispatch → transport       发请求、收流
  post    → settle           按上游真实 usage 扣费
          → usage-log        记录 cost 与用量，详细度可配置
          → 结束
```

- 任何阶段的拒绝或失败，都由 **engine 统一渲染成 HTTP 错误返回用户**；模块不自己写响应。
- 扣费发生在 **post 相位**，不做预留（见 D11），因此链路不需要请求级补偿机制；
  代价是并发窗口内可能产生超出余额的成本。
- **合法插入点是有限的**：以审计类模块为例，插在 `quota-check` 之前或之后语义不同，
  非法插入点在**描述符校验阶段**就拒绝，而不是等到线上才发现。
- 出站审计只能**截断 + 报错**，无法撤回已发给用户的内容；流式下边流边审，直接计入首字延迟。

---

## 3. 决策记录（ADR）

状态只有三种：**生效** / **待定** / **已否决**。

**这里只留会影响多处的架构决策。** 插件内部的选择（默认值、边界行为、错误码、命名）
与一次性的取舍不在这里：那些由 owner 直接定，落点是代码与测试，不是本文件。

**编号沿革**：D19（用户插件）与 D20（鉴权插件）曾在这里，2026-10-15 按上面这条删去了，
内容散在 §4。这两个编号不再复用。

### D1 · cordis 不参与业务流程，只做组件管理与启用权威（方案甲）

状态：**生效**

不做用户自定义策略，因此不需要 TS 插件进入请求热路径。

**已否决的替代方案（方案乙）**：TS 插件注册为链路阶段、每个请求过桥调用。
否决理由：引入 IPC 延迟；TS 单线程成为全局瓶颈；超时与失败策略复杂度显著上升；
而它唯一的收益（让用户自己写策略逻辑）已被明确排除。

### D2 · 真实转发、请求、计费、数据库处理全部在 Go

状态：**生效**

### D3 · 桥（bridge）只做四件事

状态：**生效**

1. 组件生命周期：spawn / 健康检查 / drain / 重启
2. 描述符下发与校验（cordis 是唯一写者）
3. 命令与查询（管理台读数据、改配置）
4. 事件上行（用量、频道故障、额度耗尽 → cordis 侧展示与告警）

v1 **不实现** `stage.invoke`。描述符 schema 保留 `home: go | ts` 字段，
v1 校验只接受 `go`，以便将来若要开乙，不必变更协议版本。

### D4 · 解耦靠 contracts 包 + 单向依赖 + 组合根 + CI 强制

状态：**生效**

1. `contracts/` 是唯一可被所有模块 import 的包，且它自身只允许依赖标准库。
2. `modules/<x>/` 只允许 import `contracts/`，**严禁** import 其他 `modules/*`。
3. `cmd/gatewayd/main.go` 是唯一组装点；每个模块暴露一个 `Register(reg)`，
   去掉一行即少一个模块。

规则 2 用 `go list -deps` 在 CI 中逐模块校验，违反即构建失败。
**「解耦」必须是构建失败级别的约束，不是文档里的愿望。**

### D5 · 「禁用」必须同时闸住四个入口

状态：**生效**

只闸住链路阶段等于**假禁用**。四个入口必须一起闸：

1. 链路阶段（请求路径）
2. HTTP 路由（它自己的管理接口、回调接口）
3. 后台任务 / 定时器（对账、清理、上游健康轮询）
4. 桥命令（管理台通过桥调用它的那些 `cmd`）

这也正是 cordis 该干的活：模块注册的一切挂在 effect 上，卸载时统一回收，不留残余。

### D6 · 计费不得事件驱动

状态：**生效**

计费必须是链路中**有序、有返回值、有显式失败策略**的阶段。
事件没有顺序保证、没有返回值、失败无处处理，而计费要求「要么成功、要么明确拒绝」。
事件只用于分析、通知、webhook 这类丢失不致命的场景。

### D7 · 每个阶段的失败策略必须显式声明，默认 deny

状态：**生效**

计费模块故障时放行，等于敞开送 token。
sub2api 有 `billing.circuit_breaker` 配置项，注释为 "fail closed on billing errors"，
说明这是行业做法，不是本项目保守。

### D8 · 三个存储，三个唯一写者

状态：**生效**

| 存储 | 内容 | 唯一写者 |
|---|---|---|
| cordis 的 yml | 插件树、基础设施配置 | cordis |
| 描述符文件（挂载卷） | 链路结构、profile、启用集 | cordis |
| 数据库 | 账户 / 额度 / 用量 / 流水 / 订单 | Go |

**任何数据只有一个写者。** 需要读取时通过接口或桥命令，绝不跨层直连写入。

### D9 · Go 不依赖 cordis 存活

状态：**生效**

- 描述符**落盘**：Go 冷启动先读文件、再接受 push。
- cordis 挂掉时网关照常服务，只是暂时不能改配置。
- 反方向：cordis 要能拉起挂掉的 Go，并支持 `drain` 优雅退出
  （drain → 停止接新请求 → 跑完在途 → 退出 → 起新进程）。

### D10 · 金融数值用整数最小单位或定点数，禁止浮点存余额

状态：**生效**

反例证据：sub2api 的 ent schema 用 `field.Float("balance")` 与 `field.Float("frozen_balance")`。
浮点存余额在充值、扣费反复累加后必然漂移。

### D11 · 后付费：扣费发生在请求成功之后，不做冻结与退款

状态：**生效**

owner 决策：`quota-check` 只做「是否允许发起」的**门槛判断**，
真正的扣费在 **post 相位**按上游真实 usage 结算。不做预留 / 冻结，
因此也不需要退款路径与请求级补偿机制。

**已否决的替代方案：两阶段「预留 → 结算」。**
参考项目证据：new-api 有 `quota_reserve.go`，sub2api 有 `frozen_balance`，
二者都在解同一个问题——余额为 0 的用户并发开 N 条流可白拿 N 倍 token。
本项目选择**简单性优先**，接受这一暴露面，改用两条低成本缓解措施：

1. `quota-check` 的门槛要求 **可用余额 > 0**（而不是 ≥ 0）。
2. `billed` profile 强制启用**每密钥并发上限**，这是限制并发刷量的主要手段。

**已知且被接受的风险**：并发窗口内可能产生超出余额的成本，需要人工追讨或容忍损失。

### D12 · 缓存 token 单独定价，且区分写入与读取

状态：**生效**

缓存写贵、缓存读便宜，不建模就是系统性错账。
证据：sub2api `usage_log` 含 `cache_creation_tokens` / `cache_read_tokens`，
且按 5m / 1h TTL 再拆两列，成本也分四路记。

### D13 · 前端是一个 SPA、两块路由区，作为 cordis 插件挂载

状态：**生效**

- 一个 SPA，两块路由区：`/console`（用户）、`/admin`（管理员）。
- 前端插件的职责：① 静态资源的安装 / 启用 / 版本 / 回滚（装到挂载卷，原子换目录，
  保留上一版）；② 聚合已启用模块的管理页与设置卡；③ 与 Go HTTP API 的契约。
- 页面通过普通 REST 调 Go，**不走桥**；静态资源由 Go 或反代直接发字节，也不走桥。
- **模块被禁用时，它的管理页与设置卡必须自动消失**，不得为此改前端代码。
- 现成范例：本机 `dsh-model-fingerprint` 插件的 `dsh.client.inject`
  （`dsh-client-ui-settings` / `dsh-client-ui-slots`）+ `./client` 导出。

### D14 · 许可证纪律

状态：**生效**

- new-api 是 **AGPL-3.0**，sub2api 是 **LGPL-3.0**：可以读它们学设计，
  **不得**复制其代码进本项目。
- cordis 与 magpie 是 **MIT**：可以在其上构建与 vendor。

若本项目要闭源商用，复制 AGPL 代码会带来强制开源义务。

### D15 · 模块宿主形态（进程内 vs 独立进程）

状态：**待定**

- **关键约束**：独立进程**不能**省掉 engine。请求要按顺序穿过 quota → transport，
  就必须有一个协调者按序调用；协调者不能是 cordis，否则退化成已否决的方案乙。
  进程化只是把模块的**身体**搬出去，顺序仍由 engine 管。
- 倾向：P0 走**进程内**。零 IPC、零分布式事务，而「可禁用」的能力一点不少。
  将来某个模块需要独立扩缩或崩溃隔离时再挪出去，engine 侧只把「本地调用」换成「过桥调用」。

### D16 · 模块分两类：阶段型与能力型

状态：**生效**

- **阶段型模块**：参与 LLM 请求链路，**有顺序**，出现在描述符里。
- **能力型模块**：被其他模块依赖，**不参与链路顺序，不出现在描述符里**，
  只受 cordis 的启用 / 禁用控制。

| | 阶段型 | 能力型 |
|---|---|---|
| 出现在描述符 | 是 | 否 |
| 有顺序 | 是 | 否 |
| 例子 | `key-auth`、`quota-check`、`content-audit`、`account-select`、`transport`、`settle`、`usage-log` | `tls-fingerprint`、`proxy`、`credential-crypto`、`http-client`、`metrics` |

**描述符只编排阶段型模块。** 能力型模块的启用与否体现在「谁依赖它、依赖是否满足」上。

### D17 · 号池拆成四个模块，transport 对号池无感知

状态：**生效**

| 模块 | 类型 | 单一职责 |
|---|---|---|
| `identity` | 能力型 | 号池维护、固化登录态、持有与刷新登录凭证。**不发送请求。** |
| `account-state` | 能力型 | 账号运行时状态：限流窗口、配额余量、健康、冷却、封禁、隔离 |
| `account-select` | 阶段型 | 从池中选账号的策略 + 粘性会话映射（**选谁**） |
| `transport` | 阶段型 | 发请求、收流、把结果与失败分类上报（**怎么送字节**） |

**关键约束：`transport` 不感知「号池」这个概念。**
它只接受「向某个上游、用某组凭据、发这个请求」这样的输入。
收益：号池场景与普通 API key 频道共用同一个 transport 模块，一套代码两种情况。

`account-state` 可参考 sub2api 的做法，但注意它把状态建模成**多态而非布尔**：
凭据无效、权限失败、限流冷却、额度耗尽、额度未知，是同一种表里的不同状态。
sub2api 在拿到首个上游响应前把额度显示为 `unknown`，
说明「**未知必须是一等状态**」，而不是「默认健康」。

### D18 · 账号状态只有一个写者：transport 只上报事实

状态：**生效**

`transport` 观察到 401 / 403 / 429 / 额度耗尽时，**只能上报事实**，
不得自己摘除、冻结或隔离账号；状态迁移由 `account-state` 决定。
同理，凭据刷新由 `identity` 独占：`transport` 发现凭据失效时只回报事实，不自行刷新。
这是 D8（一个数据一个写者）在号池上的具体落实。

---

## 4. 已完成的插件

落地的是 **cordis 侧的控制面插件**（外加一个不属于插件的共用底层库，见最后一行的 kit）：
不进 LLM 请求链路，只被别的插件 `inject` 使用。
启用与禁用**只由 `app.yml` 决定**（D1、D5）；禁用/卸载时插件注册的一切随 effect 一起回收。

| 包 | 服务名 | 角色 | 一句话职责 |
|---|---|---|---|
| `@dizzyapi/plugin-user` | `user` | 控制面 | 用户表单（用户名 / 用户 ID / 状态 / 余额）的唯一写者 |
| `@dizzyapi/plugin-auth` | `auth` | 控制面 | 注册（邮箱验证码）、登录（密码校验）、会话签发与校验 |
| `@dizzyapi/plugin-mailer` | `mailer` | 外部通讯模块 | 把消息发出去（邮件）；`log`（开发）与 `smtp` 两种投递 |
| `@dizzyapi/plugin-credentials` | `credentials` | 控制面 | 秘密（授权码之类）的唯一存放处；别的插件只持有引用名 |
| `@dizzyapi/plugin-settings` | `settings` | 控制面 | 运行期可改的配置的唯一写者：`app.yml` 是基线，它写自己的覆盖文件 |
| `@dizzyapi/plugin-admin` | `admin` | 开发者面板 | 插件 / 服务的静态依赖图、运行期概览、改设置、重启单个插件、退出整个进程 |
| `@dizzyapi/plugin-kit` | — | 内部底座 | 配置 schema（手写 Standard Schema + 字段元数据）+ 原子写 JSON 存储；以上各包共用 |

**配置不再硬编码**：`app.yml` 是「人写的基线」，**改配置的活口是 `settings` 插件**。
它自己独占一个覆盖文件（JSON，gitignored），合并后调 cordis 的 `fiber.update(…, true)`
让目标插件软重启，新值立刻生效——**从不回写 `app.yml`**（见 §10 的 `noSave` 那条）。
秘密不进 `app.yml` 也不进设置：`credentials.set(ref, value)` 存值，
`mailer` 的 `smtp.passRef` 只留引用名。

**`admin` 是设置的 HTTP 写入口**：它绑 `127.0.0.1`，起一个单页（零构建、零新运行时依赖），
启动日志打印 `http://127.0.0.1:7788/?t=<一次性 token>`。打开后 token 换成 HttpOnly cookie；
`/api/*` 还要 `X-Panel-Request: 1` 与 `Host` 校验（挡 DNS rebinding 与跨站表单）。
它同时能重启单个插件、退出整个进程。**关页面不等于退出**——这是网关，要在后台挂着；
退出只认页面上的「退出并关闭」。

### 4.1 接口面

**`user`**

| 面 | 方法 | 谁可以调用 |
|---|---|---|
| 管理面 | `create` / `rename` / `setStatus` / `remove` | 只有 `adminPlugins` 白名单里的插件（默认空 = 谁都不许） |
| 余额面 | `adjustBalance` / `listBalanceEntries` | 默认任何插件；可用 `balanceWriters` 收窄 |
| 只读 | `get` / `list` / `getBalance` | 任何插件 |

**`auth`**

- 注册：`requestRegistration` / `confirmRegistration`（验证码通过后才在用户表建用户）
- 登录与会话：`login` / `logout` / `verifySession` / `listSessions` / `revokeSession` / `revokeAllSessions`
- 密码：`changePassword` / `requestPasswordReset` / `confirmPasswordReset`

**`mailer`**：`send({ to, subject, text, kind? })`

**`credentials`**（秘密的写者与唯一读口）

| 面 | 方法 | 说明 |
|---|---|---|
| 写 | `set(ref, value)` / `unset(ref)` | `unset` 幂等；写入永不回显 |
| 读 | `resolve(ref)` | **唯一返回值的方法**，进程内 seam，不得挂到任何 HTTP 路由上 |
| 只读 | `describe(ref)` / `list()` | 只回答「配没配」与时间戳，返回类型里**没有** value 字段 |
| 事件 | `credentials/reference-updated(ref)` | 为将来留的钩子 |

引用名形如 `dizzyapi/smtp-163`（`^[a-z0-9][a-z0-9._-]*(/…)*$`，限长 200）。
文件以 **0600** 落盘（Windows 忽略，Linux 生效）。

**`settings`**（运行期配置的写者）

| 面 | 方法 | 说明 |
|---|---|---|
| 读 | `describe()` / `get(ns)` | 读不限权；秘密字段只给 `configured`，不给 value |
| 写 | `update(actor, ns, patch, expectedRevision?)` / `reset(actor, ns)` | 只有 `adminPlugins` 白名单里的插件能动 |
| 事件 | `settings/updated(ns)` | |

**命名空间 = `app.yml` 里 entry 的 `id`**（`mailer`、`auth`…），不是 `entry.id`。
可写字段由各插件在自己的 schema 上声明（kit 的 `FieldSpec`）；没声明的整个配置面只读。
`patch` 里某键为 `null` **表示删除该键**（用来把基线里的 `smtp.passEnv` 换成 `passRef`）。
`revision` 是合并结果的 sha256 前 16 位，带上过期的指纹写就报 `SETTINGS_CONFLICT`（乐观锁）。

**`admin`**（开发者面板，HTTP 服务）

| 面 | 方法 | 说明 |
|---|---|---|
| 读 | `graph()` / `overview()` | 插件 + 服务快照（静态依赖，不做运行期调用计数）；进程 / 内存 / CPU / 事件循环 |
| 扳手 | `restartPlugin(id)` | `fiber.update(fiber.config, true)`；会级联到注入了它提供服务的插件 |
| 设置代理 | `describeSettings()` / `updateSettings()` / `resetSettings()` | 以 `@dizzyapi/plugin-admin` 身份调 `settings` |
| 退出 | `shutdown()` | 停监听、断 SSE、发 `exit` 事件；**不** `process.exit`（退出的落点在 HTTP 路由） |
| 只读属性 | `address` / `url` / `bootstrapUrl` / `listening` / `sseClientCount` | |

内省规则在 `packages/admin/src/introspect.ts` 的文件头；HTTP 路由与四道闸在
`packages/admin/src/http.ts` 的文件头。`admin` **不 inject `settings`**：设置插件会因为
任何配置重载而重启，inject 它等于让面板跟着抖；改用时用 `_getImpl('settings', false)` 解析。

**`mailer` 的三选一**：`smtp.pass`（明文，`writable: false` + `secret`，不许运行期写）/
`smtp.passEnv`（环境变量）/ `smtp.passRef`（指向 `credentials`）最多给一个，多了直接报错。
`passRef` 在**每次 `send` 时**解析，所以换授权码下一封就生效，不用重启。

消费者用 `ctx.inject(['auth'], …)` 取服务。依赖用**类静态属性**声明
（`static inject = ['user', 'mailer']`）：依赖没满足时该插件的 fiber 停在 PENDING，
不构造也不报错——这正是 D16 说的「依赖是否满足」。

### 4.2 怎么跑、怎么验

- `pnpm dev`：起 cordis（已带 `--import tsx`）。`pnpm start` 还没带，暂时跑不了 TS 源码。
- `pnpm test`：`node --import tsx --test "packages/*/test/*.test.ts"`。
- `pnpm typecheck`：`tsc -p tsconfig.json`。
- 插件要能按包名从 `app.yml` 加载，必须先在根 `package.json` 里以 `workspace:*` 声明依赖。
- 面板：`pnpm dev` 之后打开日志里的 `面板已启动：http://127.0.0.1:7788/?t=…`。
  token 一次性；已经换到 cookie 的浏览器再点原地址仍然进得去（刷新页面的场景）。
  改端口只会让它换个地址，所以 `port` 在字段元数据里是只读的；`port: 0` = 系统分配（测试用）。

### 4.3 边界与已知偏离

1. **控制面插件的存储在 cordis 侧**：用户表、凭证、会话现在都落在 `./data/*.json`。
   按 D8，这些数据最终的唯一写者是 Go；当前实现只是可替换的存储适配器，
   桥与 Go 就绪后换适配器，插件对外接口一字不改。
2. **LLM 请求不加第二层认证**：对外协议只有 `Authorization: Bearer <key>`，
   没有放会话令牌的位置；key → user 在 Go 的 `key-auth` 阶段解析（数据面、不过桥），
   `usage_log` 与 `settle` 据此关联用户。界面请求才用会话令牌。
   因此本节这些插件**不得**演变成 LLM 请求热路径上的查询点。
3. **API key 的签发 / 吊销不在这些插件里**，按 §5 归 Go 的 `auth` 模块（`key.*`）。
   v1 没有 Go，所以 LLM 请求目前还无法真正鉴权。
4. **`@dizzyapi/plugin-admin` 已经落地**，不再是占位：它就是 `user.adminPlugins` /
   `settings.adminPlugins` 里那个「指定插件」的实体。
5. **设置插件的写入口现在是面板**：机制是通用的（任何插件的 schema 声明了可写字段就能改），
   但真正声明了可写字段的仍只有 `mailer`（SMTP 那一组）；`user` / `auth` 的字段只读可见。
   `settings.adminPlugins` 里只有 `@dizzyapi/plugin-admin`，所以**只有面板能改**——
   新增写入口 = 往白名单加插件名，没有别的口子。
6. **面板不是权限边界**：回环绑定 + cookie + 自定义头 + Host 校验挡的是「网页」与
   DNS rebinding，挡不住本机同一用户的其他进程（它们可以自己发请求）。
   别把它当成「多用户隔离」或「生产远程管理台」。
7. **面板不碰秘密**：它只转述 `settings.describe()`，秘密字段只有「配没配」；
   它既没有读 `credentials.resolve` 的代码，也没有把值带进任何 HTTP 响应。

---

## 5. 模块与契约面

每个模块只 import `contracts/`，只通过注册表对外暴露能力。

| 模块 | 类型 | 对外接口（进程内） | 桥命令 | 依赖 |
|---|---|---|---|---|
| `auth` | 阶段 | `Authenticator` | `key.list` / `key.create` / `key.revoke` | db |
| `quota` | 阶段 | `Quota`：`Check` / `Settle` | `quota.get` / `quota.grant` | ledger, db |
| `audit` | 阶段 | `Auditor`：`Inspect` | `audit.rules` | — |
| `account-select` | 阶段 | `Selector`：`Pick` / `Report` | `account.list` / `account.quarantine` | account-state |
| `transport` | 阶段 | `Transport`：`Send` | —（不在管理面暴露） | identity, tls-fingerprint |
| `usage-log` | 阶段 | `Usage`：`Record` | `usage.query` | db |
| `identity` | 能力 | `Identity`：`Credential` / `Refresh` | `pool.list` | db |
| `account-state` | 能力 | `AccountState`：`Observe` / `State` | `account.state` | db, redis |
| `ledger` | 能力 | `Ledger`：`Post` / `Balance` | `ledger.list` | db |
| `pricing` | 能力 | `Pricing`：`Price` | `price.list` / `price.set` | db |
| `ratelimit` | 能力 | `Limiter`：`Allow` | — | redis |
| `tls-fingerprint` | 能力 | `ClientFactory` | — | — |
| `proxy` | 能力 | `ProxyFor` | — | db |
| `payment` | 能力 | `Payment`：`CreateOrder` / `HandleCallback` | `order.list` | db |
| `httpapi` | 入口 | 路由注册 | — | 上面若干 |

契约包规则：

- `contracts/` 只允许依赖标准库。一旦它引入第三方库，就会变成耦合漏斗。
- **接口由消费者定义**，实现者不需要声明 `implements`。
- 跨模块 DTO 放 `contracts/`；模块私有类型留在模块内。

以上是 **Go 侧模块面**。cordis 侧的控制面插件（§4）不属于这张表：
它们不 import `contracts/`，不进描述符，只受 `app.yml` 的启用 / 禁用控制；
需要跨进程时再以桥命令暴露。

模块间通信只有三种方式：

1. **`Ctx` 数据槽**：请求路径上的首选。显式、有类型、顺序确定。
2. **命名服务查询**：`Svc[T](ctx, "ledger")`，取的是接口而不是实现。
3. **进程内事件**：用于通知类交互，见 D6 的使用限制。

### 5.1 契约接口草案

```go
package contracts // 只依赖标准库

type Phase uint8

const (
	PhasePre Phase = iota
	PhaseDispatch
	PhasePost
)

// 请求期上下文：模块之间只通过它交换数据，不通过直接调用
type Ctx struct {
	context.Context
	ReqID string
	Meta  RequestMeta // 小上下文：model / stream / 估算 token，不含全量 body
	Body  BodyProvider // 惰性；只有声明 NeedBody() 的阶段才允许取

	Key     *APIKey // 数据槽：前面的阶段写，后面的阶段读
	Tenant  *Tenant
	Profile string
	Route   *RouteDecision

	svc *ServiceSet
}

// Go 的方法不能带类型参数，所以取服务写成泛型自由函数
func Svc[T any](c *Ctx, name string) (T, error)

type Stage interface {
	Name() string
	Phase() Phase
	Required() bool
	NeedBody() bool
	Run(*Ctx) (Decision, error)
}

type Decision struct {
	Action  Action // Continue / Respond
	Status  int
	Headers map[string]string
	Body    []byte
}
```

模块侧只注册自己，不引用别人：

```go
// modules/quota/module.go
func Register(reg *contracts.Registry) {
	reg.Service("quota", New())
	reg.Stage("quota-check", func(d contracts.Deps) (contracts.Stage, error) {
		ledger, err := contracts.Svc[contracts.Ledger](d.Ctx, "ledger")
		// ...
	})
}
```

去模块化 = 在 `main.go` 注释掉 `quota.Register(reg)` 这一行。
此时若描述符里仍写着 `quota-check`，**必须在启动或应用配置时显式失败**，
而不是静默跳过 —— 静默跳过等于悄悄变成免费中转，代价是真金白银。

---

## 6. 链路描述符

**唯一写者：cordis。** Go 只校验与应用，绝不反向修改。

```yaml
version: 8
required: [key-auth, dispatch]          # 缺失即拒绝应用
stages:
  key-auth:       { home: go, required: true }
  quota-check:    { home: go, failPolicy: deny, timeoutMs: 50 }   # 只做门槛，不冻结（D11）
  content-audit:  { home: go, failPolicy: deny, timeoutMs: 200 }  # 可选；合法插入点见 2.4
  account-select: { home: go }
  dispatch:       { home: go, required: true }                    # 上游调用 + 失败转移循环
  settle:         { home: go, failPolicy: deny }
  usage-log:      { home: go, failPolicy: allow, async: true }
  model-map:      { home: ts, failPolicy: skip, timeoutMs: 20 }   # v1 预留不启用（D3）

profiles:
  billed:        # 收费中转
    pre:  [key-auth, quota-check, content-audit, account-select]
    post: [settle, usage-log]
  free:          # 免费纯分发
    pre:  [key-auth, account-select]
    post: [usage-log]
```

`dispatch` 既是相位边界也是必须存在的阶段：失败转移循环发生在它内部；
而 `post` 相位在所有出口（成功 / 上游错误 / 客户端取消 / 超时）**恰好执行一次**，
由 `settle` 决定本次到底扣多少（失败可能为 0）。

三条必须做对的细节：

1. **相位要显式，不能是一条平铺的列表。**
   至少分 `pre`（上游派发前）、`dispatch`（上游调用，内含失败转移循环）、
   `post`（结算 / 记账 / 通知）。因为失败转移会让 `dispatch` 循环，而 `post` 必须只跑一次。
2. **profile 在请求中途解析，不能在收请求时就定死。**
   链路先跑 `key-auth`，它返回 `profile: billed | free` 标签，Go 再按该 profile 取后续阶段。
   否则「内部密钥免计费、外部密钥计费」这种同一实例双形态就做不成。
3. **配置应用必须原子且保守。**
   Go 收到新描述符先校验（未知阶段、缺 required 阶段、相位顺序非法、v1 的 home 只接受 go），
   任何一条不通过就**保留旧描述符**并回报错误，绝不部分应用。
   每个请求在 `usage_log` 里记下它使用的描述符版本，事后可审计。

**能力回传**：Go 启动时通过 `hello` 上报已注册阶段清单与各自的配置 schema。
cordis 据此校验后再下发，使管理台在结构上就无法生成非法描述符。

---

## 7. 桥协议

- **传输**：Unix domain socket（容器内为 Linux）。
- **帧**：长度前缀 JSON。
- **待设计细节**：握手版本协商、背压与并发上限、每阶段超时、断连降级策略。

桥上的消息分两组，**分属不同平面，不得混用**（见 2.3）。

**控制消息（v1 全部实现在这一组）**

| 方向 | 消息 | 用途 |
|---|---|---|
| Go → TS | `hello` | 协议版本、描述符版本、已注册阶段与配置 schema |
| Go → TS | `event` | 结算完成、频道故障、额度耗尽 |
| TS → Go | `descriptor.push` | 描述符下发，返回校验结果 |
| TS → Go | `cmd` / `query` | `user.get` / `quota.grant` / `channel.disable` 等 |
| TS → Go | `drain` / `resume` | 优雅排空 Go 进程 |

**LLM 请求路径消息（v1 不实现，仅预留）**

| 方向 | 消息 | 用途 |
|---|---|---|
| Go → TS | `stage.invoke` | 调用一个 `home: ts` 的阶段，每个 LLM 请求一次 |
| Go → TS | `stage.cancel` | 客户端断连时撤销该次调用 |

两组消息**不得共用连接池、队列、限流器与超时策略**。

设计红线：

- v1 **不实现** `stage.invoke`。
- 即使将来开乙，也不得把整个请求体塞过桥做体积传递。桥上传的上下文限定为
  `model / stream / messageCount / 估算 token / keyId / userId`，几百字节量级。
- CPU 密集的阶段不许放在 TS 侧（正则扫大 body、签名、加解密）：
  单线程 TS 上的 CPU 工作是全局瓶颈，这与语言快慢无关。
- 每个阶段必须有 `timeoutMs` 与显式 `failPolicy`，默认 `deny`。
- 桥断连不是崩溃，是降级：要么按策略逐个阶段处理，要么整体降级并告警，
  绝不能让请求挂住。

---

## 8. 开发与验证规则

### 8.1 依赖检查（Go 侧）

CI 用 `go list -deps` 逐模块校验 `modules/*` 之间无相互 import，违反即失败。

### 8.2 boot 矩阵测试（P0 验收标准）

逐个禁用模块（`quota-check` / `settle` / `usage-log` / `model-map` / `account-select`），
加上全开与全关两种极端，逐个启动并断言：

1. 网关仍能正常转发请求；
2. `free` profile 的计费为零；
3. `billed` profile 在 `settle` 缺失时**必须拒绝启动或拒绝应用配置**，而不是静默免费；
4. 被禁用模块的**四个入口全部关闭**（链路阶段、HTTP 路由、后台任务、桥命令）。

**在上述测试跑绿之前，不得声称「解耦已实现」。**

### 8.3 语言与写作

- 文档与对话用中文；代码标识符、路径、命令用英文。
- 插件（TS 侧）的验证入口见 §4.2。

---

## 9. 待定项

| 项 | 说明 |
|---|---|
| D15 模块宿主形态 | 进程内（倾向）还是独立进程 |
| **部署形态** | 容器化，还是**仿照 DSH 的进程管理**（owner 2026-10-15 提出可不容器化）。注意 cordis CLI 自带 `daemon` 模式，即 fork + 心跳 + 自动重启，见 §10 |
| cordis 侧运行时 | Node 已实测可用（v24.3.0）；Bun 未实测（IPC 更快、生态更薄） |
| 支付渠道 | 倾向：兑换码 + 易支付打底，之后再接支付宝/微信/Stripe |
| 上游模型来源范围 | 号池的**拆分方式已定**（D17）；待定的是 v1 是否就包含 OAuth 订阅账号池，还是先只做 API key 型频道 |
| 包月 / 订阅 | 倾向 v2 再做（new-api 的 `subscription.go` 有 48KB） |
| 控制面数据的存储归属 | 用户表单 / 余额 / 凭证 / 会话现在都在 cordis 侧（§4.3）；Go 与桥就绪后迁到 Go，插件退化为门面 |
| API key 的签发与 key→user 映射 | 按 §5 归 Go 的 `auth` 模块（`key.*` 桥命令）；v1 没有 Go，所以 key 能力暂缺 |

---

## 10. 已核实事实（截至 2026-10-15）

以下数字由 `gh api repos/<repo>/git/trees/<branch>?recursive=1` 与 `contents` 接口实测得出，
可复核。

**cordis**（MIT，9.2k stars，TypeScript，仓库 2.7MB）
- 核心包：`core` / `create` / `group` / `hmr` / `include` / `loader` / `logger-console` / `timer`
- 它是 DeepSeek Harness 以 vendor 方式引入的插件框架
- 文档：<https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer>
- 五个核心概念：插件即 Service；上下文是服务容器；`inject` 声明依赖并据此决定启动顺序；
  类型化事件（`emit` / `waterfall` / `parallel` / `serial` / `bail`）；
  注册是可逆副作用（`ctx.effect()` / `ctx.on()`）

**cordis 工程化事实（本项目实测，2026-10-15）**

- 包名与版本：`cordis@4.0.0-rc.11`、`@cordisjs/plugin-loader@1.0.0-rc.8`、
  `@cordisjs/plugin-include@1.1.1`、`@cordisjs/plugin-cli@1.1.2`、
  `@cordisjs/plugin-cli-cordis@1.0.5`、`@cordisjs/plugin-timer@1.1.4`、
  `@cordisjs/plugin-group@1.0.0`、`@cordisjs/plugin-hmr@1.1.0`、
  `@cordisjs/plugin-logger-console@1.0.0`、`@cordisjs/plugin-env@1.0.1`
- `cordis` 这个 bin 由 `cordis` 包自己的 `bin.js` 提供：`new Context()` → `baseUrl = cwd`
  → `plugin(Loader)` → `loader.create(include, { path: './cordis.yml' })`。
  它**不解析 argv**；`run` 子命令由 `@cordisjs/plugin-cli-cordis` 注册
- `@cordisjs/plugin-cli-cordis` 的 `config.daemon.enabled` 是**必填**：
  缺了会在注册 `run` 命令时抛异常，现象是 `cordis run` 报 `command "run" not found`
- `daemon.enabled: true` 会 **fork 出子进程**，带 `heartbeatTimeout` 与 `autoRestart`，
  即 cordis 内置的守护进程能力；`false` 时同进程前台运行，`docker run` 才有前景进程
- 源码级 HMR 需要 `node --expose-internals`；该参数**不能**放进 `NODE_OPTIONS`
  （Node 24 实测直接报 `--expose-internals is not allowed in NODE_OPTIONS`）
- pnpm 11：带安装脚本的依赖（如 `esbuild`）需要在 `pnpm-workspace.yaml` 的
  `allowBuilds` 里放行，否则 `pnpm install` 以退出码 1 结束
- **cordis 的类型声明不能配 `nodenext` 解析**：`lib/*.d.ts` 用的是无扩展名相对再导出
  （`export * from './context'`），`moduleResolution: node16 / nodenext` 会判 TS2834；
  叠加 `skipLibCheck` 时这些再导出被静默丢弃，现象是 `import { Service } from 'cordis'`
  报「模块没有导出成员 Service」。本仓库根 `tsconfig.json` 因此覆盖为
  `module: preserve` + `moduleResolution: bundler`
- **服务类里不能用 `#` 私有字段**：cordis 以 Proxy 作为 receiver 调用服务方法，
  `#` 字段的 brand check 会抛「Receiver must be an instance of class」；
  服务成员要用 TS 的 `private`（`plugin-hmr`、`plugin-timer` 都是这样写的）
- **类插件必须有默认导出**（`export default SomeService`）：少了它，按包名加载会报
  「invalid plugin, expect function or object with an "apply" method, received object」
- **类插件的 `inject` 必须写成静态属性**（`static inject = ['user', 'mailer']`），
  不能写成模块级 `export const inject`：loader 取的是模块的默认导出（类），看不到模块级导出。
  写错的现象是插件在依赖就绪前就构造（「mailer 明明启用了却报 mailer 不在运行」）。
  依赖没满足时 fiber 停在 PENDING——不构造，也不报错
- **workspace 包必须出现在根 `package.json` 的依赖里**（`"@dizzyapi/plugin-user": "workspace:*"`）
  才会被 link 进 `node_modules`；否则 `app.yml` 里按包名写的插件解析不到
- **插件配置的校验入口是 `Config['~standard'].validate(config)`**，必须同步返回；
  任何 Standard Schema 实现都行，不一定是 schemastery
- **Node 24 + tsx 下 `node --test <目录>` 会把目录当成模块入口**：要用 glob，
  即 `node --import tsx --test "packages/*/test/*.test.ts"`
- **socket 读取要先攒行、再等人读**：SMTP 的问候语常常在监听器挂上之前就到了，
  若「没人等就丢弃」，表现为莫名超时（本项目踩过一次）
- **`Array.isArray` 收窄不了 `T | readonly X[]`**：直接用会让假分支仍带联合类型，
  需要一个 `value is readonly X[]` 的断言函数

**cordis 热重载（本项目实测，2026-10-16，做设置插件时踩的）**

- **`fiber.update(config, noSave)` 的 `noSave` 必须是 `true`**。传 `false` 会 emit
  `internal/commit`，`@cordisjs/plugin-loader` 收下它 → 写 `entry.options.config` →
  `Include.commit` → 用 `yaml.dump` **整份重写 `app.yml`，注释全丢**。
  传 `true` 则只换 `fiber.config`，`entry.options.config`（= 基线）一字不动。
  `packages/settings` 有一条专门的回归用例盯着这件事（把 `noSave` 改成 `false` 就会红）。
- **`fiber.update` 的校验是同步的**：`_resolve` 不过就 `throw ValidationError`，
  而且发生在 `fiber.config = config` **之前**——所以非法配置不会写进 fiber、不会重启、
  旧实例原样保留。设置插件仍然自己预校验，那是为了拿到人能读的错误。
- **软重启换实例、但不换 fiber**：`fiber.uid` 重启前后**不变**，变的只是服务实例。
  所以「实例换没换」不能拿 `fiber.uid` 验（会得到「什么都没发生」的假象）。
- **软重启会级联到依赖方**：auth 的 `static inject` 里有 mailer，
  所以改 mailer 的配置会**把 auth 也重启一遍**（`user` / `credentials` / `settings` 不受牵连）。
  数据每次都落盘、重载后从盘重读，所以数据不丢，但在途操作会被打断。
  想看谁被重启了，收 `ctx.root.on('internal/service', …, { global: true })`：
  服务重新提供时会带 `(name, impl)` 发出来，impl 为 `undefined` 是回收。
- **include 会把 `ctx.baseUrl` 改成配置文件所在的目录**：构造函数里
  `this.ctx.baseUrl = new URL('.', pathToFileURL(this.filename)).href`。
  各插件按 `resolveDataPath(ctx, …)` 解析的 `./data/*.json` 因此是**跟着配置文件走**的，
  不是跟着 cwd 走。`app.yml` 在仓库根时两者恰好重合，所以这件事一直没露头；
  一旦把树文件挪到别处（比如测试里的夹具），数据就会落到那份文件旁边。
- **`ctx.loader.resolve(id)` 翻不进 include 的子树**：`app.yml` 里的 entry 长在
  include 那棵树上，只有 `ctx.loader.entries()` 会顺着 `entry.subtree` 递归过去，
  `resolve()` 只翻 Loader 自己的 store。设置插件的发现逻辑用的正是 `entries()`。
- **别去碰 traced 服务 proxy**：`ctx.get(name)` 每次返回**新的** proxy，
  `assert.equal(ctx.get('mailer'), mailer)` 永远失败；更要命的是断言失败时
  AssertionError 会去 inspect 这个 proxy，`ReflectService.handler` 直接抛
  「cannot get property "X" without inject」，看起来像是插件坏了。
  要断言就断在**原始类型或行为**上（如 `mailer.config.smtp?.passRef`）。
- **`Config` 上不能叫 `merge`**：`Service[symbols.resolveConfig]` 会读 `Config?.merge`，
  字段元数据那条挂载属性只能叫别的名字（本项目叫 `fields`）。
- **`EntryTree.create` 的类型声明漏了 `id`**（声明成 `Omit<EntryOptions, 'id'>`），
  但实现里 `ensureId(options)` 会**原样采用**传进来的 `id`。`app.yml` 的 entry 全都带
  显式 id，写测试要用它时得绕过这个声明缺口（`packages/settings/test` 里包了一层 `createEntry`）。
- **`Include` 的落盘是 fire-and-forget**：`commit()` 里的 `_drain()` 不 await。
  断言「文件没被改」必须先把 `includeEntry.subtree.flush()` 等掉，否则读文件会
  **抢在写之前**，用例就成了永远绿的摆设（本项目先写成过这样，改完把 `noSave` 故意改成
  `false` 才验出它有牙齿）。

**cordis 内省与停机（本项目实测，2026-10-17，做开发者面板时踩的）**

- **`entry.fiber` 不是真实 fiber，是 `Object.create(fiber)` 出来的包装**（`registry.plugin()`
  为了挂 `.then` 造的）。它和真实 fiber 共享状态（原型链），但**对象身份不同**；
  服务表里的 `impl.ctx.fiber` 是真实 fiber。按「fiber 对象」建索引必须用
  `entry.fiber.ctx.fiber`，否则永远查不到——现象是服务节点的 `provider.pluginId`
  全是 `null`。
- **重启一个插件用 `fiber.update(fiber.config, true)`，不要用 `fiber.restart()`**：
  `restart()` 在 `_error` 存在时直接早退（对 FAILED 的 fiber 是空操作），
  `update()` 会先清错误再重载。`entry.refresh()` 也不是重启——fiber 已存在时它直接返回。
  `noSave: true` 同时防止 loader 回写 `app.yml`。
- **停机没有现成 API**：`ctx.root.fiber.dispose()` 是「重启/回收」，`loader.exit()` 是空函数。
  生态做法是 `ctx.parallel('exit', signal)`，然后由调用方 `process.exit()`。
  面板把这两步**分开**：`admin.shutdown()` 只发 `exit`，`process.exit` 在 HTTP 路由里
  （否则测试进程会被一起带走）。
- **`server.close()` 会被开着的 SSE / keep-alive 连接挂住**：要么自己跟踪并 end 掉所有连接，
  要么用 `server.closeAllConnections()`（Node 18.2+ / 20+）。
- **`EventSource` 发不了自定义请求头**，所以「所有 `/api/*` 都要 `X-Panel-Request: 1`」
  这个设计直接排除了它。前端必须 `fetch` + `ReadableStream` 自己拆 `\n\n` 帧。
- **`ctx.root.reflect.store` 是 `Dict<Impl, symbol>`**（symbol 键，值是 `Impl`），
  且 `Impl` / `ReflectService` **没有从 `cordis` 的 index 导出**；要用它们得按结构
  自己声明一份最小视图（面板的 `introspect.ts` 就是这么做的）。
- **方法枚举只能按「字符串键 + 值是函数」过滤**：cordis 的内部成员都挂在 symbol 上，
  所以 symbol 过滤天然把它们排掉；而 **TS 的 `private` 在运行时与 public 没有区别**，
  面板显示的「接口」必然包含 private 方法，只能如实标注。
- **`monitorEventLoopDelay` 在 Windows 上的基线不是 0**：系统计时器粒度约 15.6ms，
  即便进程全闲，`p50` 也会在 20ms 上下。别把这个数字当成卡顿证据。
- **测退出路由要 mock `process.exit`**：`t.mock.method(process, 'exit', () => {})`
  必须给实现——不给实现时 mock 仍然会调用原函数，测试进程直接没。
- **`Service` 的构造函数会立刻 `ctx.reflect.provide()`**，所以单测里 `new SomeService(ctx)`
  就能拿到一个可枚举的对象（不需要 `ctx.plugin`）。
- **`include` 生成的 entry id 带随机前缀**（`3ccf294d` 这种）：`entry.id` 只能当调试信息，
  稳定身份一律用 `entry.options.id`；`app.yml` 里的 entry 有显式 id，prelude / include
  自己创建的没有。

**sub2api**（LGPL-3.0，44k stars，Go + Vue 3）
- `backend/` 3244 文件，`frontend/src/` 931 文件，`backend/internal/` 2561 文件
- `backend/ent/schema/` 共 **40 张表**；单文件 `frontend/src/views/admin/SettingsView.vue` 达 554KB
- `user` 表字段含 `field.Float("balance")` / `field.Float("frozen_balance")`（反例，见 D10）
- `api_key` 表含 `quota` / `quota_used` / `rate_limit_5h|1d|7d` / `usage_5h|1d|7d` 及窗口起始时间
- `usage_log` 含四类 token（input / output / cache_creation / cache_read）与四类成本，
  以及 `rate_multiplier` / `model_mapping_chain` / `requested_model` / `upstream_model`
- 配置项含 `billing.circuit_breaker`（注释 "fail closed on billing errors"）

**new-api**（AGPL-3.0，50k stars，Go + React 19）
- `web/` 1426 文件，`relay/` 250，`relaykit/` 159，`controller/` 131，
  `service/` 112，`model/` 112 文件
- `web/src/i18n/locales/` 约 4.3MB（7 种语言）
- `model/token.go` 字段含 `remain_quota` / `unlimited_quota` / `model_limits` /
  `allow_ips` / `used_quota` / `group`
- `model/user.go` 含六个第三方身份 id：github / discord / oidc / wechat / telegram / linuxdo
- 有 `quota_reserve.go`（两阶段计费的证据）

**magpie**（MIT，12.6k stars，Go）
- `internal/gateway/` 780 文件，`internal/provider/` 630，`internal/gui/` 1288
- 有 LAN 共享能力（每客户端命名网关密钥，带日/周/月 token 与成本上限）

**本机环境**
- `C:\Users\17740\.dsh\profiles\desktop` 是一个活的 cordis 应用实例：
  `package.json` 的 `dsh.profile.bundles` + 空的 `cordis.yml` + `cordis.patch.yml` 组装
- `@deepseek-ai/dsh-mcp-client` 以 `transport: stdio` 监管外部可执行文件
  （如 `codegraph serve --mcp`、`kimi-cu.exe mcp`），
  这是「cordis 插件监管外部进程」的现成范例，也是本项目 bridge 的原型
- `E:\vibecoding\dsh-model-fingerprint\package.json` 的
  `dsh.client.inject` + `./client` 导出，是「前端作为插件」的现成范例

---

## 11. 未验证事项（不要当成结论）

- **数据面性能**：本项目未做任何压测。TS 单进程能扛多少并发流、UDS 每次往返延迟、
  描述符落盘 + push 双通道的冷启动顺序，全部未实测。
- **SMTP 只对一家真实服务器测过一次**：2026-10-16，走 mailer 插件对 163（465 直连 TLS +
  授权码认证）投递成功，服务器接收（DATA 得到 250）——**是否真的进了收件箱还没确认**，
  250 只说明被接受。**但**：STARTTLS（587）那条分支仍未对真实服务器测过；其余错误路径
  （认证失败、被拒收、超时）也仍只到「对本机假服务器核对命令序列」这一层。
  别把这一次成功当成投产就绪。
- **业务面的界面请求（会话令牌）仍没有 HTTP 入口**：面板的 HTTP 只服务面板自己
  （看、改设置、退出），不是用户站 / 管理台的 API；那个入口要等 Go 的 `httpapi` 或桥。
- **面板前端已在真实浏览器里逐页签点过**（2026-10-17）：概览 / 依赖图 / 插件 / 服务 / 设置
  都渲染正常，设置保存只提交改动过的字段，重启与「退出并关闭」也走通了。仍未验证：
  SSE 断线重连的退避在真实网络抖动下的表现，以及依赖图在极窄窗口里的可读性。
- 面板没有经过反代 / TLS，只支持回环 `http://127.0.0.1`；`SameSite=Lax` 的 cookie
  在跨机访问场景下如何表现未验证（也刻意不支持）。
- 控制面插件都是单进程假设：同一份 JSON 被两个 cordis 实例写会互相覆盖。
- 契约包按「消费者定义接口」拆分的实际手感。
- Go 侧配置 schema 上报给 cordis 渲染设置页的可行性。
- 桥的背压与超时策略细节。
- 除 §10 之外的、关于参考项目的判断，均为基于 README 与 schema 的推理，未做全文精读。
