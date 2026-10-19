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
> 当前状态：**控制面插件 + Go LLM 请求最小闭环 + 前端宿主骨架**。cordis 侧已有十二个插件包
> （外加共用底座 kit）并全部装载运行（§4）；Go 侧已有 `modules/accountpriority`、
> `modules/transport`、`modules/keyauth`（动态 API key 快照校验）、`internal/apikeys`、
> 最小 engine 与 HTTP 入口（§5.2 / §5.3）。
> `cmd/gatewayd` 现在能接受 OpenAI 兼容的 `/v1/chat/completions`，按策略选账号并转发到
> OpenAI 兼容上游。前端 SPA 已落地 `/console` 与 `/admin` 路由、静态资源版本与清单，
> 视觉层按 owner 提取的参考页 DOM/CSS token 重写（未 vendor）。
> 描述符／profile 编排、settle／usage-log、Go 侧的用户与额度（auth／quota）、前端真实 REST
> 仍是**目标**，不是现状；本文件中这些部分不要当成已实现。

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

> 现状（2026-10-19）：这条规范形态只落地了 `key-auth`（动态 API key 哈希快照；尚未收到
> 快照时才回退静态 key / 占位；已收到空快照则拒绝全部）→ `account-priority` →
> `transport` 三个环节；`quota-check`、`content-audit`、`settle`、`usage-log` 尚未实现。

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

> **落地记录（2026-10-19，owner 决定）**：`account-select` 由 `account-priority` 实现。
> 它是双面的：作为 pre 阶段写 `Ctx.AccountRoute`（排序结果 + 选中项），
> 同时暴露 Go 评分服务 `Score` / `Pick` 给其他模块查询。Go 代码在
> `modules/accountpriority`；TS 管理插件是 `@dizzyapi/plugin-account-priority`。
> 它**不写**账号运行时状态——健康、限流、额度仍归 `account-state`（D18）。

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
| `@dizzyapi/plugin-api-key` | `apiKey` | 控制面（数据面凭据签发） | 用户 API key 的唯一写者：SQLite、创建 / 改名 / 启停 / 轮换 / 删除、只读哈希快照 |
| `@dizzyapi/plugin-auth` | `auth` | 控制面 | 注册（邮箱验证码）、登录（密码校验）、会话签发与校验 |
| `@dizzyapi/plugin-mailer` | `mailer` | 外部通讯模块 | 把消息发出去（邮件）；`log`（开发）与 `smtp` 两种投递 |
| `@dizzyapi/plugin-credentials` | `credentials` | 控制面 | 秘密（授权码之类）的唯一存放处；别的插件只持有引用名 |
| `@dizzyapi/plugin-identity` | `identity` | 控制面 | 上游账号（订阅 OAuth / API-key）的唯一写者；唯一用 refresh_token 换新令牌的地方 |
| `@dizzyapi/plugin-account-admin` | `accountAdmin` | 控制面 | identity 的管理门面：账号导入 / 新建 / 修改 / 停用 / 删除；不存数据、不刷新令牌 |
| `@dizzyapi/plugin-account-priority` | `accountPriority` | 控制面 + 数据面监管 | 策略组的唯一写者；拉起/监管 gatewayd；经控制桥推送策略与 identity 的只读账号/令牌快照；提供预览与选择查询 |
| `@dizzyapi/plugin-catalog` | `catalog` | 控制面（只读） | 插件能力目录：反射 + 可选声明清单，汇总谁提供什么、谁接受什么；不含秘密、不起 HTTP |
| `@dizzyapi/plugin-frontend` | `frontend` | 前端宿主 | SPA 静态资源的版本 / 原子切换 / 回滚；页面、设置卡与插槽清单；按启用集过滤 |
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

**`identity` 是上游账号的唯一写者**：账号记录（provider / 状态 / 过期时间 / 刷新退避，
**不含任何令牌**）落在 `data/accounts.json`，令牌放在 `credentials` 的
`identity/<账号 id>` 引用下。它按 `refreshLeadMs` 提前用 RT 换新令牌；可重试错误走
指数退避，`invalid_grant` 这类不可重试错误把账号转为 `needs_reauth`。它**不转发任何请求**
（D17），transport 就绪后通过进程内 `getAccessToken(id)` 取用——该方法是秘密读口，
不得挂到 HTTP 上。首期适配器：Claude 与 OpenAI/Codex；`custom` provider 只用于 API-key 账号。

**`accountPriority` 是策略的写者、不是打分的执行者**：策略组保存在
`data/account-priority.json`（TS 独占写入），启动时把整份策略经控制桥推给 Go；
Go 的 `modules/accountpriority` 在请求链路里并发打分、排序、选中。TS 的
`preview` / `pick` 是**管理面查询**（走控制桥），不是 LLM 请求转发；真正的链路调用
发生在 Go 进程内部。默认策略是权重合计 100 的加权因子：health / quota / rateLimit /
headroom / priority / capacity / success / latency / cost；硬过滤处理禁用、provider/kind/
tag、健康、冷却与并发饱和。`transport` 在 Windows 开发机自动走回环 TCP，Linux 走 UDS
（Node 的 `net` 连不上 Go 的 AF_UNIX socket）。

它同时是 **identity → Go 的账号快照推送者**：从 `identity.list()` 取启用且 active 的账号，
对每个账号调 `identity.getAccessToken(id)` 取令牌，按 `upstreamBaseUrls` 补上上游地址，
整份经控制桥 `accounts.replace` 推给 Go；Go 只缓存，不落盘。identity 的
`account-updated` / `account-refreshed` / `account-failed` 事件会触发防抖重推。
令牌只存在于桥帧与 Go 内存里：不写日志、不进状态、不出现在桥响应。没有配上游地址的
provider（默认只有 `openai`）不会进入快照。

**`apiKey` 是用户 API key 的唯一写者**：SQLite（Node 24 内置 `node:sqlite` 的
`DatabaseSync`，零第三方依赖）落在 `data/api-keys.db`，表里只有 sha256 哈希与掩码，
**永不存明文**。key 形状是 `sk-dz-<12 位 Crockford base32 trackingId>_<32 字节随机数的
base64url secret>`；完整 key 只在 `create` / `rotate` 的返回值里出现一次。`verify` 先校验
形状，再按 trackingId 取记录、用 `timingSafeEqual` 比对哈希；不存在、已停用、用户封禁
都返回 `undefined`，不泄露差异。同一用户内名称唯一，每用户上限默认 100。

account-priority 在启动同步、`sync()` 与 `api-key/changed` 事件（防抖 100ms）时调用
`apiKey.snapshot()`，经控制桥 `keys.replace` 把**只读哈希快照**推给 Go；Go 只缓存，
不读 SQLite。`lastUsedAt` 字段已预留，但 Go 尚未回报用量，所以目前恒为 `null`。
`appManaged` 用于标记由应用代管的 key，当前只做记录，语义与使用方待定。

### 4.1 接口面

**`user`**

| 面 | 方法 | 谁可以调用 |
|---|---|---|
| 管理面 | `create` / `rename` / `setStatus` / `remove` | 只有 `adminPlugins` 白名单里的插件（默认空 = 谁都不许） |
| 余额面 | `adjustBalance` / `listBalanceEntries` | 默认任何插件；可用 `balanceWriters` 收窄 |
| 只读 | `get` / `list` / `getBalance` | 任何插件 |

**`apiKey`**（用户 API key：SQLite 持久化）

| 面 | 方法 | 说明 |
|---|---|---|
| 用户面 | `create(userId, input)` / `list(userId)` / `get(userId, id)` / `update(userId, id, patch)` / `rotate(userId, id)` / `remove(userId, id)` | 全部按 `userId` 做所有权隔离；`create` / `rotate` 的返回值含完整 key 一次 |
| 校验 | `verify(secret)` | 进程内 seam；命中返回 `{ keyId, userId, name, profile }`，否则 `undefined` |
| 快照 | `snapshot()` | 只含 enabled 且用户可用的 key：`{ keyId, userId, keyHash, profile, name }` |
| 管理面 | `listAll()` / `status()` | 管理员读；只有掩码与计数，没有 secret / hash |
| 事件 | `api-key/changed` | `{ userId, keyId, action }`，action 为 created / updated / rotated / removed |

所有权：key 不属于该 `userId` 时统一报 `API_KEY_NOT_FOUND`（不区分「不存在」与「不是
你的」）；用户不存在或已封禁时 `create` / `rotate` 报 `API_KEY_USER_NOT_FOUND`。
名称 1..64 字符（trim）、同一用户内唯一（`API_KEY_NAME_TAKEN`）；每用户上限由
`maxKeysPerUser` 决定（默认 100，含已停用的 key）。错误码还有
`API_KEY_INVALID_INPUT` / `API_KEY_LIMIT_REACHED` / `API_KEY_STORE_CORRUPT`。
配置字段 `dataPath` / `maxKeysPerUser` 全部只读；省略 `dataPath` 用 `:memory:`。

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

**`identity`**（上游账号保管）

| 面 | 方法 | 说明 |
|---|---|---|
| 读 | `get(id)` / `list()` / `credentialStatus(id)` | 只返回账号元数据与「凭据配没配」，没有令牌字段 |
| 写 | `create()` / `update()` / `importCredentials()` / `remove()` | 账号记录的唯一写入口；删除时同时清凭据 |
| 令牌 | `getAccessToken(id)` / `refreshNow(id)` | 进程内 seam；`getAccessToken` **不得**挂 HTTP，等 transport 用 |
| 调度 | `runRefreshPass(now?)` | 跑一轮扫描；定时器与测试共用同一个入口 |
| 事件 | `identity/account-updated` / `account-refreshed` / `account-failed` | 通知性质，不承载正确性 |

配置里可写的是刷新策略（`refreshLeadMs` / `pollIntervalMs` / `refreshConcurrency` /
`retryBaseMs` / `retryMaxMs` / `requestTimeoutMs`）；`dataPath` 与 `credentialPrefix`
不可运行期改。刷新策略一改，identity 会软重启，账号与令牌从文件恢复，不需要额外处理。

**`accountPriority`**（账号请求优先级：策略写入 + gatewayd 监管）

| 面 | 方法 | 说明 |
|---|---|---|
| 读 | `status()` / `listStrategies()` / `getStrategy(id)` | 监管状态与策略组副本；不含任何秘密 |
| 写 | `upsertStrategy()` / `removeStrategy()` | 策略组的唯一写入口；先校验、再落盘、再推送 |
| 进程 | `start()` / `stop()` / `restart()` / `sync()` | 拉起/停止 gatewayd；`sync()` 重推当前策略、账号快照与 API key 快照 |
| 查询 | `preview()` / `pick()` / `remoteStatus()` | **管理面**查询，经控制桥交给 Go；不是 LLM 请求路径 |
| 事件 | `account-priority/child-state` / `strategies-updated` / `applied` / `accounts-applied` / `error` | 通知性质，不承载正确性 |

策略写入是「先落盘、后推送」：推送失败不会回滚已经保存的策略，但会把状态标成
`degraded` 并发 `error` 事件；下一次启动或 `sync()` 会再推。`preview` 的候选上限是
10000，`seed` 只影响 `weighted-random` 的可复现选择。可运行期改的是 `autoStart`、
`startTimeoutMs` / `requestTimeoutMs` / `stopTimeoutMs`、`restartDelayMs` /
`maxRestartDelayMs`；`dataPath` / `binaryPath` / `args` / `socketPath` / `transport` /
`logFormat` / `httpListen` / `upstreamBaseUrls` 不可运行期改。`httpListen` 只接受回环地址
（默认 `127.0.0.1:8080`）；`upstreamBaseUrls` 是 provider → OpenAI 兼容 base URL 的映射。

**`accountAdmin`**（账号管理门面）

| 面 | 方法 | 说明 |
|---|---|---|
| 读 | `list(query?)` / `get(id)` / `credentialStatus(id)` / `previewImport(input)` | 只返回元数据与「凭据配没配」；预检只回答识别结果，不返回令牌 |
| 写 | `create(actor, input)` / `update(actor, id, patch)` / `remove(actor, id)` | 修改只限 `label` / `email` / `subject` |
| 开关 | `enable(actor, id)` / `disable(actor, id)` | 停用是独立开关，不占用 `status` |
| 凭据 | `importCredentials(actor, id, input)` / `importAccounts(actor, input)` | 解析后交给 `identity.importCredentials` / `create`；批量逐项返回结果 |
| 刷新 | `refresh(actor, id)` | 只委托 `identity.refreshNow`，本插件从不换令牌 |

支持的导入格式：Claude Code `.credentials.json`（`claudeAiOauth`，`expiresAt` 毫秒）、
Claude / 通用 OAuth 的 camelCase / snake_case 令牌响应、Codex `auth.json`
（`tokens` 包装，或只有 `OPENAI_API_KEY` 的 API-key 模式）、`identity-bundle`、
纯文本或 `apiKey` / `api_key` / `key` / `token` 字段的 API key。`format: 'auto'`
按形状推断；OAuth 形状判断不出 provider 时明确要求 `claude` / `openai`。
OpenAI `id_token` 只在内存里解出 `email` / `account_id`，不保存本体；导入到已有账号时
只补空缺的元数据，不覆盖管理员手填的值。

角色边界：本插件**没有存储、没有定时器、没有 HTTP 路由**，禁用时只是服务消失；
账号与令牌仍由 identity / credentials 独占写入（D8）。写方法一律要求 actor 在
`adminPlugins` 白名单里（默认空 = 全部拒绝），读方法不限权。`app.yml` 里当前只有
`@dizzyapi/plugin-admin` 在名单里；将来接 HTTP 时，路由层要把认证后的管理员映射成
白名单 actor，且不得把 `identity.getAccessToken` / `credentials.resolve` 暴露到路由。

**`catalog` 是只读的插件能力目录**（2026-10-19）：它不是管理插件，不起 HTTP、不写状态、
不调用被观察插件的方法。`snapshot()` 从活的插件树反射入口 / 状态 / 服务 / 方法 / inject /
Config schema 字段 / 设置命名空间；事件、控制桥命令、数据形状与存储用途由各插件可选的
声明清单补齐。清单是**声明，不是校验**：反射不到、清单也没写的面进 `unknown`，绝不猜。
`available` 只在入口未被禁用且 fiber 是 ACTIVE 时为 true；`find()` 默认只返回 available
（D5：禁用插件不得表现为可用）。配置只输出 schema 元数据（`writable` / `secret` /
`credentialRef` / 取值域），存储只输出非秘密路径字段；两类都不带值。
`user` / `api-key` / `auth` / `mailer` / `credentials` / `identity` / `account-admin` /
`account-priority` / `settings` / `admin` / `catalog` / `frontend` 自己都已带基础清单。

清单的两种写法（目录优先读静态属性，其次才动态 import 模块读模块级导出）：

```ts
class Foo extends Service {
  static catalog = {
    capabilities: ['foo'],
    events: [{ name: 'foo/changed', payload: 'id: string' }],
    bridge: [{ method: 'foo.query', direction: 'outbound' }],
    storage: [{ key: 'dataPath', kind: 'file', description: 'foo 数据' }],
  } as const
}
```

**`catalog`**（插件能力目录）

| 面 | 方法 | 说明 |
|---|---|---|
| 快照 | `snapshot(options?)` | 整棵树的目录；`includeUnavailable` 默认取配置 |
| 单个 | `describe(pluginId)` | 未知 id 报 `CATALOG_PLUGIN_NOT_FOUND` |
| 查询 | `find({ capability?, plugin?, package?, includeUnavailable? })` | 能力标签或派生 facet（`service:` / `settings:` / `event:` / `bridge:` / `storage:`）；默认只返回 available |
| 桥形状 | `query(params?)` | `{ generatedAt, count, plugins }`，JSON 可序列化，给前端 / 将来的桥直接转发 |
| 事件 | — | 目录是纯读面，不发事件 |

**`frontend`**（前端宿主：静态资源 + 清单）

| 面 | 方法 | 说明 |
|---|---|---|
| 读 | `describe()` / `snapshot()` / `manifest()` / `pages(area?)` / `settingsCards()` / `slots(slot?)` / `findPage(path)` | 当前资源版本与可见清单；`manifest()` 含 `assets{version,base}` |
| 资源 | `current()` / `assets()` / `readAsset(path, version?)` / `assetPath()` / `indexFile()` / `installBundledAssets()` / `install(bundle)` / `rollback()` | 版本目录 + `current.json` 原子指针；保留上一版 |
| 清单 | `registerContributions(owner, bundle)` / `setEnabledPlugins(ids)` / `sync()` | owner 可以是 entry id 或包名；`sync()` 从 loader 重算启用集 |
| 文件 | `<dataPath>/manifest.json` / `state.json` / `versions/<version>/*` | Go / 反代直接读盘发字节，不过桥 |

包名取 `@dizzyapi/plugin-frontend`：D13 的角色就是「前端插件」，而 `console` 在本项目里
同时指 `/console` 用户站与开发者面板。前端**不监听产品 HTTP**；`pnpm preview:console`
是明确标注的开发预览（mock 数据、只绑 127.0.0.1、不提供 `/api/*`）。页面清单是数据：
插件被禁用时，它的页面 / 设置卡 / 插槽自动消失，前端不做特判。设置卡只声明 namespace，
用通用设置渲染器，所以新增可写命名空间不需要改前端代码。

用户站的源码路由是 `/usage` / `/api_keys` / `/top_up` / `/transactions` / `/profile`，
在 D13 的 `/console` 区域内落成 `/console/usage`、`/console/api_keys`、
`/console/top_up`、`/console/transactions`、`/console/profile`；`/console` 是重定向到
`/console/usage` 的隐藏页。用量页已接 mock 的余额 / 指标 / 成本柱状图；API keys 有创建
（完整 key 只显示一次）、改名、删除；充值有金额 chips、支付方式与订单结果。账单与个人资料
仍是占位。参考页是 React + Rspack + `ds-*`，我们**没有**复制它的 CSS / JS / 图片 / 字体
或真实账户数据；token 与结构见 `packages/console/DESIGN.md`。

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
  `dev` 之前会自动跑 `predev` → `pnpm build:go`，所以修改 Go 代码后直接重启 dev 即可。
- `pnpm test`：`node --import tsx --test "packages/*/test/*.test.ts"`。
- `pnpm typecheck`：`tsc -p tsconfig.json && tsc -p packages/console/tsconfig.json`；
  第二份配置用 `checkJs` 检查浏览器侧的原生 ESM（`packages/console/assets/**/*.js`）。
- `pnpm preview:console`：开发预览（mock 数据、只绑 127.0.0.1、不提供 `/api/*`），
  默认 `http://127.0.0.1:7790/console`。
- `pnpm build:go`：`go build -trimpath -o bin/ ./cmd/gatewayd`；Windows 产出 `bin/gatewayd.exe`，
  其他平台产出 `bin/gatewayd`（`bin/` 已 gitignore）。TS 监管器会补 `.exe` 后缀。
- `pnpm test:go`：`go test ./...`；`pnpm test:all` 跑 TS + Go 两套。
- 插件要能按包名从 `app.yml` 加载，必须先在根 `package.json` 里以 `workspace:*` 声明依赖。
- 面板：`pnpm dev` 之后打开日志里的 `面板已启动：http://127.0.0.1:7788/?t=…`。
  token 一次性；已经换到 cookie 的浏览器再点原地址仍然进得去（刷新页面的场景）。
  改端口只会让它换个地址，所以 `port` 在字段元数据里是只读的；`port: 0` = 系统分配（测试用）。
- **当前开发配置（2026-10-18）**：`mailer` 已切到 `smtp`，投递走 `smtp.163.com:465`（直连 TLS），
  授权码存在 `credentials` 的 `dizzyapi/smtp-sub2api`；`data/settings.json` 里已有
  `transport / from / heloDomain / timeoutMs / rejectUnauthorized / allowPlaintext / smtp.*` 的覆盖。
  再改 `app.yml` 里这些键不会生效——要先用面板「恢复基线」。
- **账号保管（2026-10-19）**：`identity` 已装载，账号记录在 `data/accounts.json`（当前 0 个），
  令牌在 `credentials` 的 `identity/<账号 id>` 下；首期只有 Claude 与 OpenAI/Codex 两个 RT 适配器。
- **账号管理（2026-10-19）**：`account-admin` 已装载，`adminPlugins` 只有面板。它是
  identity 的门面，不新增存储文件；当前**没有 HTTP 入口**，管理操作只能由进程内消费者
  （或测试）以白名单 actor 调用。面板 `/api/settings` 能看到 `account-admin` 命名空间：
  `maxBatchSize` 可写，`adminPlugins` 只读。
- **账号请求优先级（2026-10-19）**：`account-priority` 已装载，策略在
  `data/account-priority.json`（首次启动写入内置 `default`）；`pnpm dev` 会拉起 gatewayd，
  日志里能看到 `gatewayd 已就绪：tcp 127.0.0.1:<port>（pid …）` 与策略 revision。
  Windows 开发机走回环 TCP，Linux 走 `./data/gatewayd.sock`。控制桥的地址由 gatewayd
  在 stdout 打一行 `{"type":"ready",...}`，TS 读到后才连接。用面板的
  `/api/settings` 可以看到 `account-priority` 命名空间与六个可写字段。
- **前端宿主（2026-10-19）**：`frontend` 已装载，启动时把 `packages/console/assets`
  安装到 `data/frontend/versions/<version>`，日志会打印资源版本与 manifest revision。
  浏览器入口仍等 Go `httpapi` / 反代；本地看界面用 `pnpm preview:console`
  （mock 数据，`http://127.0.0.1:7790/console`），`/console` 会重定向到 `/console/usage`。
- **API key（2026-10-19）**：`api-key` 已装载，SQLite 在 `data/api-keys.db`；启动日志
  会打印存储与每用户上限。测试里的 `SQLite is an experimental feature` ExperimentalWarning
  是预期的。`pnpm dev` 下 account-priority 在 gatewayd 就绪后推送 key 哈希快照，
  `accountPriority.status()` 里能看到 `keys` / `keysRevision`。
- **插件能力目录（2026-10-19）**：`catalog` 在 `settings` 之前装载，没有 HTTP 入口；
  进程内用 `catalog.snapshot()` / `describe(id)` / `find({ capability })` 查询。
  `packages/catalog/test` 覆盖清单三态（静态 / 模块级 / 无）、D5 禁用过滤、方法枚举、
  秘密值不出现与稳定排序。
- **LLM 请求入口（2026-10-19）**：`httpListen` 默认 `127.0.0.1:8080`，只绑回环。
  `GET /healthz` 返回 `{status, accounts, revision, requests, uptimeSec}`；
  `POST /v1/chat/completions` 走 engine。动态 API key 由 `api-key` 插件经控制桥推
  哈希快照。Go 收到过任何一份快照（含合法空快照）后就只认快照、永不回退；空快照
  表示拒绝全部 key。只有「尚未收到任何快照」的启动窗口才用环境变量
  `DIZZYAPI_API_KEYS`（逗号/空白分隔），再没有就是占位模式（接受任何非空
  `Authorization: Bearer`）。请求体上限默认 32 MiB。
  示例：`curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Authorization: Bearer x' -H 'content-type: application/json' -d '{"model":"gpt-4o-mini","messages":[]}'`。
  没有可用账号时返回 503 `NO_ELIGIBLE_ACCOUNT`。

### 4.3 边界与已知偏离

1. **控制面插件的存储在 cordis 侧**：用户表、凭证、会话现在都落在 `./data/*.json`。
   按 D8，这些数据最终的唯一写者是 Go；当前实现只是可替换的存储适配器，
   桥与 Go 就绪后换适配器，插件对外接口一字不改。
2. **LLM 请求的身份来自 API key**：对外协议只有 `Authorization: Bearer <key>`，
   没有放会话令牌的位置；key → user 由 Go 的 `key-auth` 阶段解析（数据面、不过桥）。
   `api-key` 插件把只读哈希快照推给 Go 后，快照命中时 `Ctx.Key` 会带
   UserID / KeyID / Name / Profile；`usage_log` 与 `settle` 据此关联用户（尚未实现）。
   界面请求才用会话令牌。本节这些插件**不得**演变成 LLM 请求热路径上的查询点——
   key 校验在 Go 内存里完成。
3. **API key 的签发 / 吊销由 `api-key` 插件负责**（owner 2026-10-19 决定）：
   数据落在 TS 独占的 SQLite（`data/api-keys.db`），Go 不读它；Go 侧的
   `modules/keyauth` 只校验控制桥推来的哈希快照。面向用户站的 REST 入口仍由
   api-http 分支实现；本插件只有进程内服务面。
4. **`@dizzyapi/plugin-admin` 已经落地**，不再是占位：它就是 `user.adminPlugins` /
   `settings.adminPlugins` 里那个「指定插件」的实体。
5. **设置插件的写入口现在是面板**：机制是通用的（任何插件的 schema 声明了可写字段就能改）。
   当前声明了可写字段的是 `mailer`（SMTP 那一组）、`identity`（刷新策略）、
   `account-priority`（等待 / 退避参数）与 `catalog`（`includeUnavailable`）；
   `user` / `auth` / `credentials` / `settings` / `admin` 的字段只读可见。
   `settings.adminPlugins` 里只有 `@dizzyapi/plugin-admin`，所以**只有面板能改**——
   新增写入口 = 往白名单加插件名，没有别的口子。
6. **面板不是权限边界**：回环绑定 + cookie + 自定义头 + Host 校验挡的是「网页」与
   DNS rebinding，挡不住本机同一用户的其他进程（它们可以自己发请求）。
   别把它当成「多用户隔离」或「生产远程管理台」。
7. **面板不碰秘密**：它只转述 `settings.describe()`，秘密字段只有「配没配」；
   它既没有读 `credentials.resolve` 的代码，也没有把值带进任何 HTTP 响应。
8. **`identity` 先以 cordis 插件落地**（owner 2026-10-19 决定）：D17 把 `identity` 定为 Go 能力模块，
   当前 TS 实现覆盖「账号保管 + RT 刷新」，账号落 `./data/accounts.json`。
   Go 侧现在有只读快照缓存（`internal/accounts`）与 transport 取令牌的接缝，但**权威写者仍是 TS**；
   `getAccessToken` 仍是唯一令牌读口，由 account-priority 在推送快照时调用。按 D8 迁到 Go 时，
   插件退化为门面，这个接缝不变。
9. **`account-priority` 是第一个 Go 数据面模块**（owner 2026-10-19 决定）：打分与排序在
   `modules/accountpriority`，TS 只做策略写入、进程监管、账号快照推送与控制桥查询。策略组的唯一
   写者是 TS 插件，Go 只接收只读快照；它**不写**账号运行时状态。LLM 请求 engine 已实现，
   阶段会在真实请求里被调用；`Ctx.AccountCandidates` 现在由 `internal/accounts` 的 identity
   快照填充，健康/额度等运行时状态仍待 `account-state`。
10. **`account-admin` 只有进程内服务面**：它没有自己的 HTTP 路由，面板目前只能看/改它的
    设置，不能管理账号。前端 / 管理台需要的 HTTP 面是：`GET /admin/accounts`、
    `GET /admin/accounts/:id`、`POST /admin/accounts`、`PATCH /admin/accounts/:id`、
    `DELETE /admin/accounts/:id`、`POST /admin/accounts/:id/enable|disable`、
    `POST /admin/accounts/:id/credentials`、`POST /admin/accounts/import`、
    `POST /admin/accounts/import/preview`。实现时必须复用面板的 loopback + cookie +
    `X-Panel-Request` + Host 四道闸，并把认证后的管理员映射成白名单 actor；
    **任何路由都不得返回令牌**。
11. **Windows 开发机走 TCP，不是 UDS**：Node 的 `net` 在 Windows 上只支持命名管道，
    连不上 Go 的 AF_UNIX socket；`transport: auto` 因此在 Windows 选回环 TCP
    （`127.0.0.1:<系统分配端口>`），Linux/macOS 选 UDS。生产目标是 UDS；TCP 分支只在
    回环地址上允许，`bridge.NewServer` 会拒绝非回环监听。
12. **cordis 异常退出时 gatewayd 可能留下**：正常卸载/重启会由插件优雅停止子进程；
    进程崩溃或被强杀时 Go 侧按 D9 继续存活，但也不会自动退出。重启后会起一个新的
    gatewayd（新端口），旧进程需要人工清理；孤儿检测尚未实现（§9）。
13. **能力目录是反射 + 声明，不是类型系统**：TS 类型在运行期不存在。目录能给的是
    方法名 / 参数个数、Config schema 的字段元数据，以及插件自己声明的事件、桥命令、
    数据形状与存储用途；`unknown` 里的面表示「不知道」，不是「没有」。被禁用 / 未装载的
    入口不会 import 模块，因此也读不到模块级清单，相关面一律 unknown。
14. **前端宿主的视觉层是自有实现**：owner 已提取参考页 DOM/CSS，我们只取 token、
    尺寸与信息架构，没有复制参考项目的 CSS / JS / 图片 / 字体 / logo 或真实账户数据。
    用户站与参考页的路径映射、页面清单与后端契约见 `packages/console/DESIGN.md`。
    账单 / 个人资料页、亮色模式与按模型小图仍缺参考或后端序列；API key 完整值只在
    创建对话框里出现一次，不落 localStorage / 日志 / URL。
15. **API key 的存储是 SQLite，不是 JSON**：`packages/api-key` 用 Node 24 内置的
    `node:sqlite`（`DatabaseSync`），零第三方依赖。表里只有 sha256 哈希与掩码；
    完整 key 只在 `create` / `rotate` 返回一次。写操作走 `BEGIN IMMEDIATE`，
    `generation` 元数据在同一个事务里递增。`lastUsedAt` 已预留，但 Go 尚未回报用量。
16. **key 快照的权威写者仍是 TS**：`api-key` 是唯一写者，account-priority 只是转发；
    Go 的 `internal/apikeys` 只缓存与校验。account-priority 监听 `api-key/changed`、
    `user/changed` 与 `internal/service(apiKey)`：key 变化、用户状态变化、api-key 插件
    后启用（HMR）都会防抖重推。`internal/apikeys` 用 `Ready()` 区分「尚未收到快照」
    与「已收到合法空快照」：后者是 fail-closed，拒绝全部 key，绝不回退 env / 占位。
    `api-key` 被禁用 / 卸载时仍然跳过推送（避免启动竞态把快照清空），Go 里的旧快照
    要等重启或下一次推送才更新——此时它仍在执行旧快照，不会 fail-open（§11）。

---

## 5. 模块与契约面

每个模块只 import `contracts/`，只通过注册表对外暴露能力。

| 模块 | 类型 | 对外接口（进程内） | 桥命令 | 依赖 |
|---|---|---|---|---|
| `auth` | 阶段 | `Authenticator` | `key.list` / `key.create` / `key.revoke` | db |
| `quota` | 阶段 | `Quota`：`Check` / `Settle` | `quota.get` / `quota.grant` | ledger, db |
| `audit` | 阶段 | `Auditor`：`Inspect` | `audit.rules` | — |
| `account-select` | 阶段 | `Selector`：`Pick` / `Report` | `account.list` / `account.quarantine` | account-state |
| `account-priority` | 阶段 + 能力 | `Scorer`：`Score` / `Pick` | `accountPriority.status` / `listStrategies` / `replaceStrategies` / `preview` / `pick` | account-state（将来） |
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

> 现状（2026-10-19）：这张表仍是**目标**。已落地的是 `accountpriority`（阶段 +
> 能力）、`transport`（阶段）、`keyauth`（动态 API key 快照校验）、`internal/apikeys`
> （只读哈希快照缓存）与 `internal/httpapi`（HTTP 入口，不是 `modules/httpapi`）。
> `auth` / `quota` / `settle` / `usage-log` 等还没有 Go 实现；key-auth 现在能在快照
> 命中时做 key→user 映射，但没有配额、计费与每密钥并发上限。

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

### 5.2 Go 侧现状：账号优先级模块与最小 gatewayd（2026-10-19）

> LLM 请求闭环见 §5.3；本节记录的是号池打分模块本身。

这是 Go 侧的第一块代码，也是第一次真正使用 D4 / D16 的形态。

**目录**

| 路径 | 职责 |
|---|---|
| `go.mod` | module `github.com/Acidmoon/DizzyAPI`，Go 1.26.4 |
| `contracts/` | 唯一共享包：`Phase` / `Action` / `Decision` / `Ctx` / `Stage` / `Registry`，以及 `AccountCandidate`、`ScoredAccount`、`ScoreResult` 等跨模块 DTO；只依赖标准库 |
| `modules/accountpriority/` | 打分、排序、选择；只 import `contracts/` 与标准库 |
| `internal/bridge/` | 控制桥服务端：长度前缀 JSON 帧、并发 handler、UDS/TCP 监听、优雅关闭 |
| `cmd/gatewayd/` | 唯一组装点：注册模块、启动控制桥、打印 ready 行、等待信号/桥 shutdown |

**模块 API**

```go
service, err := accountpriority.New(cfg)        // cfg 为空时启用内置 default 策略
revision, err := service.Replace(cfg)           // 全量校验后原子换快照；绝不部分应用
result, err := service.Score(req)               // 只排序，空池不报错
picked, err := service.Pick(req)                // 没有可用账号时报 NO_ELIGIBLE_ACCOUNT
result, picked, err := service.Evaluate(req)    // 阶段用：一次算出排序与选中项
status := service.Status()                      // 计数、revision、默认策略
list := service.Strategies()                    // 含禁用组的副本
stage := accountpriority.NewStage(service)      // contracts.Stage：pre / required / needBody=false
```

阶段名是 `account-priority`。它读 `Ctx.Meta.Strategy` 与 `Ctx.AccountCandidates`，
写 `Ctx.AccountRoute`（`Ranked` + `Picked`），不做任何 I/O、不修改账号状态。
`contracts.Registry` 是最小注册表：`Service(name, impl)` + `Stage(stage)`；
其他模块用 `reg.Lookup("account-priority")` 取实例，再断言成
`contracts.AccountScorer`（`Score` / `Pick`）——这条路径只依赖 `contracts`，
不需要 import 实现包。engine 已实现固定的阶段集；描述符调度尚未实现，所以没有
「按 profile 选择阶段」的代码。

**打分模型（配置驱动，策略组）**

1. **硬过滤**：禁用、`providers` / `kinds` / `tags`、健康策略
   （`exclude_unhealthy` 默认 / `require_healthy` / `allow_all`）、
   冷却（默认排除）、并发饱和（默认排除）。
2. **因子**：`priority`、`capacity`、`health`、`quota`、`rateLimit`、`headroom`、
   `success`、`latency`、`cost`、`freshness`。每个因子有 `weight`（0–100）、
   可选 `direction`（min-max 因子：`asc` / `desc`）与 `unknown`（0–1，默认 0.5）。
3. **归一化**：`health` / `quota` / `rateLimit` / `headroom` / `success` 是固定分数
   因子（天然 0–1）；其余用候选集内的 min-max。方向 `asc` 取反。
   未知值不参与 min-max，直接用 `unknown`——未知是一等状态（D17）。
4. **得分**：`100 × Σ(weight × normalized) / Σ(weight)`；明细逐因子返回，
   预览能回答「为什么选它 / 为什么没选它」。
5. **排序**：分数降序；同分按 `tieBreaker`（默认 `priority`、`accountId`）。
6. **选择**：`rank`（取第一）或 `weighted-random`（按分数加权，`seed` 可复现）。

默认策略权重合计 100：health 30、quota 20、rateLimit 10、headroom 10、
priority 10、capacity 10、success 5、latency 3（asc）、cost 2（asc）。

**并发**

- 策略快照用 `atomic.Pointer[snapshot]` 读取；`Score` / `Pick` / `Evaluate` 不加锁。
- 写路径（`Replace`）用互斥锁串行化，编译好新快照后一次性原子替换。
- 打分是请求内局部计算，没有 goroutine 扇出；并发来自同时到达的多个 LLM 请求。
- 快照里的策略与因子是只读的；`Strategies()` 返回深拷贝，管理面改不到运行期状态。
- 模块测试有 32 个并发读者 + 4 个并发写者的用例（本机 `-race` 不可用，见 §10）。

**错误码**：`ACCOUNT_PRIORITY_INVALID_CONFIG` / `_STRATEGY_NOT_FOUND` /
`_NO_ELIGIBLE_ACCOUNT` / `_INVALID_REQUEST` / `_TOO_MANY_CANDIDATES` /
`_DUPLICATE_CANDIDATE`。桥会原样转发为 `error.code`。

### 5.3 Go LLM 请求最小闭环（2026-10-19）

**目录**

| 路径 | 职责 |
|---|---|
| `contracts/` | `Ctx` 增加 `Headers` / `Body` / `Key` / `Profile` / `Attempts` / `AccountCredential` / `CredentialSource` / `StageError`；`Decision` 增加流式 `Stream` |
| `internal/engine/` | 显式 pre → dispatch → post 调度；dispatch 内做账号失败转移；post 在所有出口恰好一次；统一渲染 OpenAI 错误 |
| `modules/transport/` | dispatch 阶段：按选中账号发 HTTP、透传非流式与 SSE、映射上游错误、按令牌脱敏 |
| `modules/keyauth/` | pre 阶段：优先校验控制桥推来的 API key 哈希快照（写 UserID / KeyID / Name / Profile）；尚未收到快照时回退环境变量静态 key / 开发占位，收到空快照则拒绝全部 |
| `internal/accounts/` | 账号/令牌只读快照缓存；`Replace` 整份校验后原子替换；`Candidates()` / `Credential()` 读路径无锁 |
| `internal/apikeys/` | API key 只读哈希快照缓存；`Replace` 整份校验后原子替换；`Verify` 用常量时间比较，`Status` 不含哈希 |
| `internal/httpapi/` | `POST /v1/chat/completions`、`GET /healthz`；请求体上限、SSE flush、错误信封 |
| `cmd/gatewayd/` | 组合根：注册 key-auth → account-priority → transport，拉起 HTTP 入口与控制桥 |

**阶段装配**：`contracts.Registry.Stages()` 的注册顺序就是执行顺序。engine 构造时校验
相位不能回退，并要求至少一个 dispatch 阶段。当前没有描述符，因此阶段集是固定的；
`key-auth`、`account-priority` 是 pre，`transport` 是 dispatch，post 为空。

**失败转移**：transport 返回可重试的 `StageError`（429 / 5xx / 网络失败 / 账号无凭据）时，
engine 按 `AccountRoute.Ranked` 换下一个账号；不可重试错误直接返回。`Ctx.Attempts` 记录
每次尝试的账号 id、状态码与错误码，不含令牌。

**账号快照**：TS 的 account-priority 插件把 identity 的可用账号与令牌整份推给 Go
（`accounts.replace`），Go 只缓存。快照含 `accountId / provider / kind / baseUrl / token /
expiresAt? / priority? / tags?`；过期或令牌为空的账号不会成为候选。Go **不读**
`credentials.json`，也不刷新令牌。

**API key 快照**：TS 的 api-key 插件把「enabled 且用户可用」的 key 的
`keyId / userId / keyHash / profile / name` 经 `keys.replace` 推给 Go；Go 只缓存与校验，
不读 TS 的 SQLite。`Ready()` 表示是否收到过至少一份合法快照（含空快照）：
Ready=false 时才沿用 `DIZZYAPI_API_KEYS` / 占位；Ready=true 时只认快照，
Count=0 也表示拒绝全部 key（fail-closed，D7）。`keys.status` 返回 revision / 计数 / 时间。
`contracts.APIKey` 的 UserID 是十进制字符串，KeyID 与 ID 同义；静态 key 只填指纹与
Profile，零值兼容。

**HTTP 入口**：默认 `127.0.0.1:8080`，只允许回环。`/v1/chat/completions` 要求 JSON 与
`model`，把原始 body 原样转发；不转发客户端的 `Authorization`。健康检查返回账号计数与
快照 revision，不含秘密。`--http-listen` 可改端口；非回环地址直接拒绝启动。

**已知边界**：只支持 OpenAI 兼容上游（Claude 协议翻译未实现）；没有模型映射；
没有 quota / settle / usage-log，所以请求不计费；post 相位在响应写出前执行，
流式响应的 usage 尚未在流结束后解析。

---

## 6. 链路描述符

**唯一写者：cordis。** Go 只校验与应用，绝不反向修改。

> 现状（2026-10-19）：engine 已实现固定阶段集（`key-auth` → `account-priority` →
> `transport`，post 为空），**描述符下发、校验与 profile 编排尚未实现**。
> 下面的 YAML 仍是**目标**；当前不接受描述符，也不按 profile 切换阶段。
> 因为只有一套固定链路，`billed` / `free` 的语义以及 settle / usage-log 都不存在。

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

### 7.1 已实现的最小协议（2026-10-19）

只实现了控制消息里的「生命周期 + 配置下发 + 查询」，没有 `descriptor.push`、
`drain` / `resume` 或业务事件上行。LLM 请求路径消息（`stage.invoke` / `stage.cancel`）
仍按 D3 不实现。

- **传输**：Unix domain socket（Linux/macOS）；Windows 开发机用回环 TCP
  （`127.0.0.1:0`，系统分配端口）。`bridge.NewServer` 拒绝非回环 TCP。
- **就绪握手**：gatewayd 在 stdout 打印**一行** JSON
  `{"type":"ready","transport":"unix|tcp","address":"…","httpAddress":"…","pid":…,"protocolVersion":1,"keys":0}`；
  TS 读到这行才知道该连哪里；`httpAddress` 是 LLM 请求入口（`unix` 传输时它仍是回环 TCP），
  `keys` 是启动时的 API key 快照计数（此时通常为 0，不含任何哈希）。
  日志全部走 stderr，stdout 只留 ready 行。
- **帧**：4 字节大端长度 + UTF-8 JSON，单帧上限 16 MiB。
  连接建立后 Go 先发 `{"type":"event","event":"hello","data":{"protocolVersion":1,"accounts":0,"keys":0,…}}`；
  TS 校验版本后才算连接成功。`accounts` / `keys` 是计数，不含令牌或哈希。
- **请求/响应**：`{"id","type":"request","method","params"}` →
  `{"id","type":"response","ok":true,"result":…}` 或
  `{"id","type":"response","ok":false,"error":{"code","message"}}`。
- **方法**：`accountPriority.status` / `listStrategies` / `replaceStrategies` /
  `preview` / `pick`，`accounts.replace` / `accounts.status`，
  `keys.replace` / `keys.status`，以及 `shutdown`。
  `replaceStrategies` 的 params 就是 `{"defaultStrategy"?, "strategies"}`；
  `accounts.replace` 的 params 是 `{"version":1,"generation","accounts":[…]}`，
  其中每个账号含令牌；Go 校验不过就整份拒绝，返回稳定错误码，响应只含
  `revision / accounts / updatedAt`，**绝不回显快照内容**。
  `keys.replace` 的 params 是 `{"version":1,"generation","keys":[…]}`，每个 key 只含
  `keyId / userId / keyHash / profile / name`；Go 校验不过整份拒绝，响应只含
  `revision / keys / updatedAt`，**绝不回显哈希**。收到一份通过校验的快照（包括
  空快照）后 key-auth 进入动态模式（`Ready=true`），不再回退环境变量。
  `keys.status` 只回同样三个字段。
- **并发**：同一连接上的请求由 Go 侧 goroutine 并发处理（全局信号量 16），
  响应按连接写锁串行化；控制消息不绑定客户端生命周期，不使用 `contracts.Ctx`。
- **关闭**：TS 先发 `shutdown`（1 秒超时），Go 回 ack 后 100 ms 关闭监听并退出；
  TS 再等 `stopTimeoutMs`，超时发 SIGTERM，再等 1 秒发 SIGKILL。
- **未实现**：描述符下发、drain/resume、事件上行、多副本协调、鉴权
  （桥只在回环/本地 socket 上，依赖操作系统权限）。

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
现状（2026-10-19）：描述符与 profile 尚未实现，因此这个 boot 矩阵还没有条件跑；
目前只有「固定阶段集 + 组合根去掉一行」的单元/集成测试。

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
| 控制面数据的存储归属 | 用户表单 / 余额 / 凭证 / 会话 / 上游账号现在都在 cordis 侧（§4.3）；Go 与桥就绪后迁到 Go，插件退化为门面 |
| API key 的界面入口与用量回报 | 签发 / 吊销 / key→user 已由 `api-key` 插件 + Go key-auth 快照落地；面向用户站的 REST（创建 / 轮换 / 删除）由 api-http 分支负责。`lastUsedAt`、每密钥并发上限与 key 级限流尚未实现 |
| `account-state` 与评分输入 | `Ctx.AccountCandidates` 现在由 `internal/accounts` 的 identity 快照填充；健康、限流、额度、并发等运行时状态仍应由 `account-state` 提供，尚未实现 |
| 上游地址的归属 | 当前由 `account-priority` 的 `upstreamBaseUrls`（provider → base URL）决定；是否改为 identity 账号字段或独立路由配置，待 owner 定 |
| 账号级 priority / 运行时状态 | identity 账号没有 priority 字段，`internal/accounts` 快照里的 priority 目前恒为 0；健康/额度/并发等也要等 `account-state`。多账号时默认按 accountId 决出同分顺序 |
| 上游协议 | 当前只支持 OpenAI 兼容 `/chat/completions`；Claude / Gemini 协议与模型映射何时做、放在哪个模块，待定 |
| gatewayd 孤儿进程 | cordis 异常退出时 Go 进程按 D9 继续存活；是否需要父进程探测、外部守护或启动时清理旧实例尚未决定 |
| 前端剩余参考 | 亮色模式、账单 / 发票页、个人资料页、按模型请求数面积图与 Tokens 柱状图的序列契约尚未提供 |
| 前端真实接口 | 用量 / API keys / 充值 / 账号 / 目录 / 设置 / 健康目前只有 mock 与契约；Go `httpapi` 尚未实现 |
| 前端静态资源集成 | `manifest.json` / `current.json` / 版本目录如何由 Go 或反代发字节已写进 DESIGN.md，但还没有在 Go 侧跑通过 |
| 前端与账号管理的接口面 | 账号管理目前只有进程内服务；面向管理台的 `/api/accounts` 等 REST 路由尚未实现，前端仍用 mock |

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
- **设置插件的 patch 只认嵌套对象**：写 `{ "smtp.host": "x" }` 会把它原样存成一个带点的键，
  必须写 `{ smtp: { host: "x" } }` 才会和基线里的 `smtp` 合并。`describe()` 返回的点分路径
  是给人看的，提交前要还原成嵌套对象。

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
- **`fiber.runtime.callback` 是 loader 解析后的插件本体**（类 / 函数 / `{ apply }`）：
  类插件的 `static catalog` 直接从这里读；模块级 `export const catalog` 不在 callback 上，
  要按 `entry.options.name` 动态 import（loader 已 import 过，命中模块缓存）。
  `fiber.runtime` 在卸载途中可能是 null，读之前要判空。

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

**Go / gatewayd / 控制桥（本项目实测，2026-10-19）**

- 本机是 `go1.26.4 windows/amd64`；`go test ./...` 与 `go vet ./...` 全绿。
- **`go test -race` 在本机不可用**：任何带 `-race` 的测试二进制都以
  `exit status 0xc0000139`（Windows `STATUS_ENTRYPOINT_NOT_FOUND`）退出，
  与代码无关。并发用例因此是在不带 race detector 的情况下跑的；换 Linux CI 时应补跑
  `go test -race ./...`。
- `go build -trimpath -o bin/ ./cmd/gatewayd` 在 Windows 产出 `bin/gatewayd.exe`；
  显式写文件名（`-o bin/gatewayd`）不会自动补 `.exe`，所以脚本输出到目录 `bin/`。
- **Windows 的 Node `net` 连不上 Go 的 AF_UNIX socket**：Node 在 Windows 上把
  `path` 当命名管道，libuv 不支持 AF_UNIX。`transport: auto` 因此在 Windows 选
  回环 TCP，Linux/macOS 选 UDS；Go 的 bridge 单测对 UDS 分支用
  `//go:build !windows` 单独覆盖。
- `fiber.dispose()` 在 cordis 4 里返回 `void`（不是 Promise）；可以 `await`，
  但**不能**对返回值调 `.catch()`——测试清理钩子踩过，报
  「Cannot read properties of undefined (reading 'catch')」。要捕获异常就
  `try { await fiber.dispose() } catch {}`。
- Go 的 `flag` 接受 `--name=value`；TS 监管器就是按这个形式追加
  `--transport=…` / `--socket=…` / `--listen=…` / `--log-format=…` 的。
- 子进程输出用 `readline` 按行读；**stdout 只放 ready 一行**，日志走 stderr。
  否则 ready 行会淹没在 slog 里，解析不可靠。
- 真机端到端已验：`pnpm dev` → 日志出现
  `gatewayd 已就绪：tcp 127.0.0.1:<port>（pid …）` 与策略 revision；面板
  `/api/settings` 能看到 `account-priority` 命名空间；Ctrl-C 退出后子进程
  `process.kill(pid, 0)` 报 ESRCH（已停止）。
- 当前全量（2026-10-19，API key 修复后）：`pnpm test` 239 个用例（238 通过 / 1 跳过），
  `pnpm typecheck` 干净；`packages/api-key` 16 个、`packages/account-priority` 21 个、
  `packages/account-admin` 16 个、`packages/catalog` 9 个、`packages/console` 26 个用例全过；
  `go test ./...` 的 9 个包全过，`go vet ./...` 干净。
- **API key / node:sqlite（本项目实测，2026-10-19）**：Node 24.3.0 的 `node:sqlite`
  可用，`DatabaseSync` 是同步 API，会打 `SQLite is an experimental feature` 警告。
  `packages/api-key` 覆盖创建 / 名称唯一 / 上限 / 所有权 / verify / 更新 / 轮换 / 删除 /
  快照过滤 / generation / 事件 / 持久化 / 损坏检测 / 配置 / D5。
  Go 侧新增 `internal/apikeys` 的校验、原子替换、常量时间 verify、并发读写，以及
  key-auth 的动态快照优先 / 空快照回退与 HTTP 动态 key 集成用例。
- **空快照是 fail-closed**：`internal/apikeys` 的 `Ready()` 与 `Count()` 分开；
  `New()` ready=false，任何通过校验的 Replace（含空快照）ready=true；
  空快照后 Verify 一律 false。keyauth 用例覆盖「先非空、后空」之后连
  `DIZZYAPI_API_KEYS` 里的 key 也必须 401；account-priority 监听
  `api-key/changed` / `user/changed` / `internal/service(apiKey)`，服务后出现也会推一次。
- **snapshot 时序**：`api-key` 的 rows 与 generation 在同一个同步块读取，
  `user.get` 放到其后；测试用挂起 `user.get` 的方式稳定覆盖「查询期间发生写入」。
- **桥响应与日志不含 key 哈希**：`keys.replace` / `keys.status` 的响应只有
  revision / 计数 / 时间；`cmd/gatewayd` 的用例断言响应与错误信息不含 keyHash；
  keyauth 的错误信息不含 key。
- **LLM 请求闭环已做真机端到端**：`go build -o bin/gatewayd.exe ./cmd/gatewayd` 后，
  用回环 TCP 起进程，经控制桥 `accounts.replace` 推一个账号（含 baseUrl 与令牌），
  `POST /v1/chat/completions` 返回 200；假上游收到的是账号令牌而不是网关密钥，
  请求 body 的 `model` 原样到达。`GET /healthz` 返回 200 且账号计数正确。
- **账号快照的 JSON 形状两边已对齐**：TS 的 `GatewayAccountSnapshot`（version / generation /
  accounts，账号字段 accountId / provider / kind / baseUrl / token / expiresAt）能被 Go
  的 `accounts.Snapshot` 严格解码；Go 的响应只有 revision / accounts / updatedAt。
- **桥响应与日志不含令牌**：Go 侧有专门用例断言 `accounts.replace` / `accounts.status`
  的响应与错误信息不含令牌；transport 对上游错误正文按账号令牌脱敏并截断。
- **engine 的 post 恰好一次**：单测覆盖成功、pre 拒绝、dispatch 失败、dispatch panic
  四种出口；dispatch 单测覆盖可重试错误的账号转移与不可重试错误的立即停止。

**前端宿主（本项目实测，2026-10-19）**

- `packages/console` 自带 26 个用例：路由、manifest 过滤 / 贡献 / 校验、资源版本切换与
  回滚、路径越界、HTTP 客户端、mock 适配器与真 Loader 集成；`pnpm typecheck` 同时跑
  `checkJs` 检查 `assets/**/*.js`。
- 参考页是 React + Rspack + `ds-*`，真实 DOM / CSS 在 `E:\vibecoding\DizzyAPI\temp\`；
  **没有**复制进仓库。深色 token（bg-base `#151517`、卡片 `#353638`、active `#43454A`、
  强调 `#FD8D3C`、文本 `#F9FAFB` / `#CFD3D6` / `#81858C`）与 260px 侧栏、42px 菜单项、
  16px 卡片圆角等尺寸来自源码。
- 图表系列色与 UI 强调色分开：深色柱色 `#E0702A`、亮色 `#E06A1F`；`#FD8D3C` 在深色
  卡片上的 OKLCH 明度 0.752 超出图表明度带。两者都用 dataviz 校验器在卡片表面色上验过。
- `pnpm preview:console` 已实测：`/console` 200、`/admin/accounts` history fallback 200、
  `/assets/frontend/*` 200、`/api/*` 404，CSP 为 `script-src 'self'`；`index.html` 的
  `<base>` 用 `__ASSET_BASE__`（本身带尾斜杠），不要再在模板里补 `/`，否则会出双斜杠。
- 用户站路径按源码落成 `/console/usage`、`/console/api_keys`、`/console/top_up`、
  `/console/transactions`、`/console/profile`；`/console` 是前端重定向页。API keys 的
  完整值只在创建 dialog 的局部变量里出现一次，列表与 mock 状态都只存掩码。
- Edge headless 已实际渲染 `/console/usage`、`/console/api_keys`、`/console/top_up`、
  `/console/transactions`、`/admin/accounts`、`/admin/settings`，并验证 `/console`
  会重定向到用量页；侧栏 260px、卡片 16px 圆角、橙色柱状图与暗色 token 均按源码
  派生值生效。

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
- **LLM 链路只跑过假上游**：engine 已被真实 HTTP 请求调用，但 transport 只对
  `httptest` 假上游与一次本机回环假上游做过端到端；没有对真实 OpenAI/兼容服务发过请求，
  TLS、代理、真实错误码与限流行为都未验证。`Ctx.AccountCandidates` 现在来自
  `internal/accounts` 的内存快照（由 identity 推送），`account-state` 仍未实现；
  health / quota / rateLimit / 并发等因子当前都是未知或 0，默认权重没有用真实账号校准过。
  **粘性会话映射尚未实现**（D17 把它归在 account-select 的职责里）：当前每次评分都是
  无状态的，同一个会话两次请求可能选中不同账号。
  `MaxCandidates = 10000` 只是校验上限，不是压测结论；`weighted-random` 只验过
  可复现性，没验过长期分布是否均匀。
- **LLM 链路未压测**：并发用例只验证正确性（缓存替换与 HTTP 请求），没有 QPS、
  首字延迟、长流内存占用或上游连接池饱和的数据。SSE 透传是按块 flush 的直通实现，
  没有背压策略。
- **只有 OpenAI 兼容上游**：transport 固定追加 `/chat/completions` 并用
  `Authorization: Bearer` 发账号令牌；Claude / Codex 的原生协议、OAuth 专属头、
  模型映射、路径映射都没有实现。`claude` 账号默认不会进快照（没有配 upstreamBaseUrls）；
  `openai` 的默认映射面向 API-key 账号，OpenAI/Codex 订阅 OAuth 账号虽会被推送，
  但其端点与协议未适配，实际很可能被上游拒绝。
- **key-auth 的动态快照只验过单测与假上游**：缓存校验、常量时间比较、收到过快照
  （含空快照）后不回退环境变量都有单测；`api-key` SQLite → account-priority → Go 桥 →
  HTTP 的链路只在测试里跑过（假上游），没有在 `pnpm dev` 下用前端创建的 key 做过真实请求。
  尚未收到任何快照且未配置 `DIZZYAPI_API_KEYS` 时仍接受任何非空 Bearer；收到空快照
  后则拒绝全部（fail-closed）。每密钥并发上限与 key 级限流未实现。不要把它当生产鉴权。
- **API key 存储是 Node 24 实验性 SQLite**：`node:sqlite` 会打 ExperimentalWarning；
  只在本机 Windows / Node 24.3.0 验过。多进程写同一文件靠 `BEGIN IMMEDIATE` 与
  busy_timeout，但没有跨实例的端到端测试；WAL 文件在 Windows 上的清理、备份与
  `integrity_check` 的性能未验证。
- **key 快照有时效缺口**：用户封禁 / 删除由 `user/changed` 触发重推（依赖
  feat/user-system 分支按约定发出该事件）；但直接改 SQLite 没有任何事件。
  `api-key` 被禁用 / 卸载时按任务约定跳过推送，Go 里的旧快照不会被清空——
  它仍按旧快照 fail-closed，而不是放开，但已删除的 key 会一直有效到重启 / 下一次推送。
- **API key 没有真实前端闭环**：前端 API keys 页面仍用 mock；面向用户站的 REST
  由 api-http 分支实现，尚未与本插件联调。完整 key 的一次性展示只在单测与 mock 里验过。
- **计费不存在**：没有 `quota-check` / `settle` / `usage-log`，请求不会扣费也不会落
  usage_log。post 相位目前是空集；engine 在响应写出前执行 post，流式响应结束后
  再解析 usage 的能力尚未实现。
- **控制桥只验证了单实例**：两个 cordis 实例会各自拉起 gatewayd，并同时写
  `data/account-priority.json`（同一份 JSON 没有跨进程锁）。Windows 的 TCP 分支是
  开发机妥协；Linux 上 Node ↔ Go 的 UDS 分支（含长路径、权限、残留 socket 清理）
  没有在本机跑过。
- **策略校验是两份实现**：TS 的 `validate.ts` 与 Go 的 `config.go` 各自校验同一套规则，
  目前靠同样的人工用例约束，没有共享测试向量。规则改动时必须两边一起改；将来可以
  用同一份 JSON fixture 同时喂给两边。
- **SMTP 已做过两次真实投递**：2026-10-16 对 163（465 直连 TLS + 授权码认证）投递，
  服务器接收（250）但未确认进箱；2026-10-18 用同一配置（`smtp.163.com:465`）向 owner 邮箱
  实发测试邮件，**已确认收到**。仍未验证：STARTTLS（587）分支、认证失败 / 被拒收 / 超时
  等错误路径（只到「对本机假服务器核对命令序列」这一层）。别把这两次成功当成投产就绪。
- **`identity` 的 RT 交换只对假端点验过**：请求形状、RT 轮换、单飞、退避、`invalid_grant`
  分类都有测试，但还没用真实 Claude / OpenAI 订阅账号跑过一次刷新。多进程/分布式锁未实现
  （单进程假设），跨副本的令牌版本防回滚也没做。
- **`account-admin` 的导入格式只对构造的样例验过**：Claude `.credentials.json` 与
  Codex `auth.json` 的实际字段会随上游 CLI 版本变化，没有用真实账号文件跑过；
  `auto` 推断也只在测试样例上验过。它没有 HTTP 入口，真实管理台链路尚未验证。
- **业务面的界面请求（会话令牌）仍没有 HTTP 入口**：现在的 Go HTTP 入口只服务 LLM 请求
  （`/v1/chat/completions` 与 `/healthz`）；面板的 HTTP 只服务面板自己（看、改设置、退出），
  不是用户站 / 管理台的 API。用户站 / 管理台的 REST 入口仍未实现。
- **面板前端已在真实浏览器里逐页签点过**（2026-10-18，重写后复验）：概览 / 依赖图 / 插件 /
  服务 / 设置都渲染正常，亮色与暗色、1000px 与 600px 两档宽度都看过；设置保存只提交改动过
  的字段，嵌套字段会还原成对象提交。仍未验证：SSE 断线重连的退避在真实网络抖动下的表现。
- 面板没有经过反代 / TLS，只支持回环 `http://127.0.0.1`；`SameSite=Lax` 的 cookie
  在跨机访问场景下如何表现未验证（也刻意不支持）。
- **前端还没有跑过真实 Go `httpapi`**：用量 / API keys / 充值 / 账号 / 目录 / 设置 /
  健康全部是契约 + mock；真实会话 cookie、401、CORS / 同源、支付回调与 API key 吊销
  均未在浏览器里验证。
- **前端静态资源还没有在 Go / 反代里发过**：`current.json` / `manifest.json` 的文件
  契约与缓存头只在 DESIGN.md 与单测里成立；history fallback、immutable 缓存、CSP
  与禁用门禁（`state.json.enabled=false`）尚未端到端跑过。
- **参考页只提供了深色 DOM/CSS**：亮色、账单页、个人资料页、按模型系列图仍缺参考；
  当前亮色是镜像取值，按模型区块只有汇总卡，没有源码里的两张小图。
- **API key 一次性展示流程只过了 mock**：浏览器剪贴板权限、dialog 关闭后清理与刷新
  页面后的行为未做真实浏览器复验。
- 控制面插件都是单进程假设：同一份 JSON 被两个 cordis 实例写会互相覆盖；
  SQLite 的 `BEGIN IMMEDIATE` 能串行化单条写，但两个实例的快照推送顺序与
  generation 语义没有跨实例验证。
- 契约包按「消费者定义接口」拆分的实际手感。
- Go 侧配置 schema 上报给 cordis 渲染设置页的可行性。
- 桥的背压与超时策略细节。
- 除 §10 之外的、关于参考项目的判断，均为基于 README 与 schema 的推理，未做全文精读。
