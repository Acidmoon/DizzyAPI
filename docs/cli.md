# dizzy · DizzyAPI 命令行客户端

`dizzy` 是 DizzyAPI 的**客户端**：一个静态 Go 二进制，零环境依赖（不需要 Node / pnpm）。
它只通过 HTTP 访问网关，**绝不直连 SQLite 或 JSON 数据文件**。

**agent 是第一用户**：所有子命令都支持 `--json`，退出码按失败原因分支（见下）。

---

## 1. 构建

```bash
pnpm build:cli          # 产出 bin/dizzy(.exe)
pnpm build:all          # gatewayd + dizzy
```

交叉编译照 `gatewayd` 的现成写法：

```bash
GOOS=linux GOARCH=amd64 go build -trimpath -o bin/dizzy ./cmd/dizzy
```

---

## 2. 两条鉴权路径（**不是同一套**）

| 路径 | 走什么 | 凭据 |
|---|---|---|
| `/v1/*`（模型请求） | `Authorization: Bearer <API key>` | `--key` 参数或环境变量 `DIZZYAPI_KEY` |
| `/api/*`（控制面） | HttpOnly 会话 cookie + **每个请求**都带 `X-Requested-With: dizzyapi` | `dizzy login` 保存的会话 |

CLI 内部按入口自动选路：`chat` / `models` 走 Bearer，`usage` / `keys` / `admin` / `whoami` 走会话。

> **注意**：`/api/*` 的 `X-Requested-With` 是**无条件要求**（登录前也要）；会话 cookie 才是
> 「登录后才有」。两者在客户端里是两个独立开关。

---

## 3. 配置与凭据

```
~/.dizzy/config.json        0644   base / llmBase / apiBase / defaultModel / timeoutSeconds
~/.dizzy/credentials.json   0600   会话 token（**只有它**）
```

- **API key 永不落盘**：只从 `--key` 或环境变量 `DIZZYAPI_KEY` 读（owner 硬边界）。
- 凭据文件权限 0600（Unix 有用例断言；Windows 上 Go 的权限位是合成值，保护来自
  `%USERPROFILE%` 的 ACL）。
- `DIZZY_HOME` 环境变量可覆盖配置目录（测试与多环境隔离用）。

生产是一个域名（nginx 同时反代 `/v1/*` 与 `/api/*`），所以只配 `base` 就够：

```bash
dizzy config set base https://<站点域名>
```

本地开发是两个端口（gatewayd `8080` / api `7791`），要分开配：

```bash
dizzy config set base http://127.0.0.1:7791
dizzy config set llmBase http://127.0.0.1:8080
dizzy config set apiBase http://127.0.0.1:7791
```

也可以每次用 `--base` / `--llm-base` / `--api-base` 临时覆盖。

---

## 4. 子命令

### 登录

```bash
dizzy login --email me@example.com          # 密码从 DIZZYAPI_PASSWORD 或 stdin 读
DIZZYAPI_PASSWORD=... dizzy login --email me@example.com
dizzy whoami
dizzy logout
```

**密码不接受命令行明文**（会进 shell history）。只能用环境变量 `DIZZYAPI_PASSWORD`
或管道（`dizzy login --email x < password.txt`）。

> Windows 上没做终端隐藏输入：那需要 `golang.org/x/term`（第三方依赖），
> 与「只依赖标准库」冲突。环境变量与 stdin 覆盖了 agent / CI 的主要用法。

### 打模型

```bash
dizzy chat -m deepseek-flash "你好"                    # 非流式
dizzy chat -m deepseek-flash --stream "写一首诗"        # 流式
dizzy chat -m gpt-4o-mini --json "总结这段"             # 机器可读
echo "总结下面这段" | dizzy chat -m gpt-4o-mini -       # 从 stdin 读输入
dizzy chat -m gpt-4o-mini --system "你很简洁" "你好"     # 带系统提示
```

**花费**：登录状态下 `chat` 会自动回查 `/api/usage` 拿权威的 `costMicros` 并打印。
没有会话时只打 token —— **CLI 不自己算钱**：客户端看到的 `prompt_tokens` 含缓存命中，
而网关记账的 `input` 不含缓存，跨协议时这个关系还不成立，硬算必然对不上。

### 看模型

```bash
dizzy models                      # GET /v1/models：可用模型名并集（Bearer）
dizzy models --catalog            # GET /api/models：价格 + 可用性 + 覆盖账号数（会话）
dizzy models --catalog --search gpt
```

### 看用量

```bash
dizzy usage                        # 汇总 + 明细
dizzy usage --range 7d --by model  # 7 天 / 30 天 / 90 天；按模型聚合
dizzy usage --by key               # 按 API key 聚合（基于返回明细，不是全量）
dizzy usage --limit 50
dizzy usage export --range 7d --output usage.csv
dizzy usage --json
```

金额一律**整数微元**（1 元 = 1_000_000 微元），人类可读输出同时给「元」和「微元」两种。
CLI 全程整数运算，不用浮点。

### 管 key

```bash
dizzy keys list
dizzy keys create --name "我的 key"        # 默认**只打掩码**
dizzy keys create --name "我的 key" --show # 才显示完整值
dizzy keys rotate <id> --show
dizzy keys enable <id> / disable <id> / delete <id>
```

完整 key 只在创建 / 轮换时出现一次。CLI **默认掩码**：要完整值必须显式加 `--show`。

### 健康检查

```bash
dizzy health        # 同时打 /healthz（Go 数据面）与 /api/health（TS 控制面）
```

两边都正常才返回 0；任一端异常返回非 0。

### 管理面（需管理员会话）

```bash
dizzy admin stats
dizzy admin accounts list [--provider x] [--status y]
dizzy admin accounts show <id>
dizzy admin accounts test <id> [--model m]
dizzy admin accounts enable|disable <id>
dizzy admin users list
dizzy admin pricing list
dizzy admin pricing set --model m --input 2 --output 8
```

---

## 5. 全局参数

```
--base <url>      覆盖入口地址
--llm-base <url>  只覆盖 /v1/* 的入口（本地开发时 gatewayd 是另一个端口）
--api-base <url>  只覆盖 /api/* 的入口
--json            输出机器可读的 JSON
--timeout <秒>    单次请求超时（默认 60）
--key <key>       Bearer API key（也可用 DIZZYAPI_KEY；不落盘）
--verbose         把请求概要打到 stderr（不含任何秘密）
```

---

## 6. 退出码（agent 用这个分支）

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 通用失败（含健康检查未全过） |
| 2 | 用法错误（参数非法） |
| 3 | 未登录 / 缺凭据 |
| 4 | 认证失败（HTTP 401） |
| 5 | 权限不足（HTTP 403） |
| 6 | 不存在（HTTP 404） |
| 7 | 余额不足（HTTP 402） |
| 8 | 限流（HTTP 429） |
| 9 | 上游 / 网关错误（HTTP 5xx） |

---

## 7. 秘密纪律（硬边界）

- API key **不落盘**，不进日志，不进 URL；只从 `--key` 或 `DIZZYAPI_KEY` 读。
- 完整 key 默认**掩码打印**，要完整值必须显式 `--show`。
- `--verbose` 只打方法与路径，不打 Authorization / cookie。
- 会话 token 只存 `~/.dizzy/credentials.json`（0600）。
- 只走 HTTP，**不直连数据库或数据文件**。

---

## 8. 实测怎么跑

### 8.1 只验数据面（真 gatewayd + 假上游）

```bash
pnpm build:all
go build -o bin/fake-upstream.exe ./cmd/dizzy/testdata/fake-upstream
go build -o bin/e2e.exe ./cmd/dizzy/testdata/e2e
.\bin\e2e.exe
```

它会起假上游 + 真 `gatewayd`、用真控制桥推账号与 key 快照，然后跑 `models` / `chat` /
`chat --stream` / `chat --json`，并断言坏 key 被拒（退出码 4）。

### 8.2 验完整链路（真 TS 控制面 + 会话路径 + 费用对账）

```bash
pnpm build:all
go build -o bin/fake-upstream.exe ./cmd/dizzy/testdata/fake-upstream
node cmd/dizzy/testdata/e2e-full/run.mjs
```

它起整套栈（cordis + gatewayd + 假上游），注册用户、配账号 / 价格 / 余额，
然后逐条验证 `login` / `whoami` / `models` / `chat` / `usage` / `usage export` /
`health` / `keys` / `admin stats` / `logout`，并**断言 `dizzy chat` 的 `costMicros`
与 `/api/usage` 里那条记录的 `costMicros` 完全相等**。

> 跑之前先确保 7791 / 7792 / 8080 端口空闲（上一次的栈必须停干净），否则会撞
> `EADDRINUSE` 而误判成用例失败。

---

## 9. 已知边界

- `dizzy usage --by key` 是从**返回的明细**聚合的，受 `--limit` 限制，不是全量；
  全量按 key 聚合需要服务端补维度。
- 密码没有终端隐藏输入（见 §4 的说明）。
- `--json` 输出里 `costMicros` 仍是字符串（整数微元），不要当数字解析。
- 交易类操作的确认交互没做：`keys delete` / `accounts enable|disable` 直接执行。
