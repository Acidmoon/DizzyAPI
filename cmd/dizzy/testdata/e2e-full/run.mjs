/**
 * 完整链路实测（手工夹具，不是单测）：真 cordis 控制面 + 真 gatewayd + 假上游。
 *
 * 它验证的是方案 §3 第 5 批那几条验收里最硬的两条：
 *   1. `dizzy login` / `whoami` / `keys create` / `usage` 走会话路径能通；
 *   2. `dizzy chat` 打印的 token 与**花费**，与 `/api/usage` 的 costMicros 对上。
 *
 * 用法（仓库根，先 pnpm build:all + 起假上游）：
 *   node cmd/dizzy/testdata/e2e-full/run.mjs
 *
 * 它**不**进 `pnpm test`：拉起整个栈太慢，且需要真进程。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { createServer, Socket } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const binDir = join(repoRoot, 'bin')
const isWindows = process.platform === 'win32'
const exe = (name) => join(binDir, isWindows ? `${name}.exe` : name)

// 临时 DIZZY_HOME 放仓库内的 .e2e-tmp：这台机器上从工作区启动的进程写 C 盘
// 用户目录会被环境限制拒绝（同一二进制从别处启动就能写）。
const tempRoot = join(repoRoot, '.e2e-tmp')
// 临时根可能被上一次清理删掉，用前先建（mkdtemp 不会自己补父目录）。
mkdirSync(tempRoot, { recursive: true })
const workDir = mkdtempSync(join(tempRoot, 'full-'))
const dizzyHome = join(workDir, 'home')
const logPath = join(workDir, 'stack.log')

// 每次运行用唯一的邮箱 / 用户名：`data/` 是跨运行保留的（gitignore），
// 固定邮箱在第二次跑时会撞「邮箱已占用」——auth 按防枚举策略静默受理，
// 于是验证码根本不会发，夹具就卡在等验证码上。唯一化让它可以反复跑。
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const email = `cli-e2e-${runId}@example.com`
const userName = `cli-e2e-${runId}`
// 实测用密码（本地栈，仅本次运行有效；形状刻意不像真实秘密）。
const password = 'e2e-password-9f3a2b'
const model = 'fake-model'

// 用户 id 在提权时从库里读出来，不写死。
let userId = 0

const children = []

main()
  .then((ok) => {
    cleanup()
    if (!ok) process.exit(1)
  })
  .catch((error) => {
    console.error('\n❌ 实测失败：', error)
    cleanup()
    process.exit(1)
  })

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGKILL')
    } catch {}
  }
}

async function main() {
  for (const binary of ['gatewayd', 'dizzy', 'fake-upstream']) {
    if (!existsSync(exe(binary))) throw new Error(`缺少二进制 ${exe(binary)}；先 pnpm build:all`)
  }
  console.log('临时目录：', workDir)

  // 1) 假上游
  const upstreamAddr = await freeAddr()
  children.push(spawn(exe('fake-upstream'), ['-addr', upstreamAddr], { stdio: 'ignore' }))
  await waitTCP(upstreamAddr, 5000)
  console.log('假上游：', `http://${upstreamAddr}`)

  // 2) 真栈：cordis + gatewayd（account-priority 会自己拉起 gatewayd）
  const stackLog = []
  const stack = spawn(
    process.execPath,
    ['--expose-internals', 'node_modules/cordis/bin.js', 'run'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        NODE_OPTIONS: '--import tsx --import @cordisjs/unyaml',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(stack)
  stack.stdout.on('data', (chunk) => stackLog.push(chunk.toString()))
  stack.stderr.on('data', (chunk) => stackLog.push(chunk.toString()))

  await waitFor(() => stackLog.join('').includes('7791'), 60000, 'cordis 启动')
  console.log('控制面：http://127.0.0.1:7791')

  // 3) 注册用户（验证码走 log 投递，从日志里捞）
  await registerUser(stackLog)

  // 4) 把用户提成管理员（实测夹具直接改库；CLI 自己绝不碰库）
  promoteToAdmin()

  // 5) 用 admin 会话配好：上游账号 + 价格 + 余额
  const adminCookie = await login()
  await createAccount(adminCookie, upstreamAddr)
  await setPricing(adminCookie)
  await adjustBalance(adminCookie)

  // 6) 现在用 dizzy 自己跑全流程
  let failures = 0

  failures += await step('dizzy login', async () => {
    const result = await dizzy(['login', '--email', email], { env: { DIZZYAPI_PASSWORD: password } })
    assert(result.code === 0, `退出码应为 0，得到 ${result.code}\n${result.stderr}`)
    assert(result.stdout.includes('已登录'), '应打印「已登录」')
  })

  failures += await step('dizzy whoami', async () => {
    const result = await dizzy(['whoami'])
    assert(result.code === 0, `退出码应为 0，得到 ${result.code}\n${result.stderr}`)
    assert(result.stdout.includes(email), '应显示邮箱')
    assert(result.stdout.includes('admin'), '应显示 admin 角色')
  })

  failures += await step('dizzy models（Bearer key 路径）', async () => {
    const key = await createKeyViaDizzy()
    process.env.DIZZYAPI_KEY = key
    // key 快照是**异步**推到 gatewayd 的（account-priority 的 KEYS_PUSH_DEBOUNCE_MS=100）。
    // 建完立刻打 /v1/* 会撞上「快照还没到」→ 401 INVALID_API_KEY。
    // 这不是 CLI 的 bug，是夹具必须等的那一小段最终一致时间。等**这个 key 真能用**为止：
    // 用日志里的 keys=N 数不可靠（那是全站计数，`keys list` 只给当前用户）。
    await waitFor(
      async () => (await dizzy(['models'])).code === 0,
      15000,
      'dizzy models 用新 key 成功（key 快照落定）',
    )
    const result = await dizzy(['models'])
    assert(result.code === 0, `退出码应为 0，得到 ${result.code}\n${result.stderr}`)
    assert(result.stdout.includes(model), `应列出 ${model}`)
  })

  let chatCostMicros = ''
  let chatReqId = ''
  failures += await step('dizzy chat：打印 token 与花费（与 /api/usage 对账）', async () => {
    const result = await dizzy(['chat', '-m', model, '--json', '对账测试'])
    assert(result.code === 0, `退出码应为 0，得到 ${result.code}\n${result.stderr}`)
    const parsed = JSON.parse(result.stdout)
    assert(parsed.usage?.prompt_tokens === 100, 'prompt_tokens 应为 100')
    assert(parsed.usage?.completion_tokens === 50, 'completion_tokens 应为 50')
    assert(typeof parsed.costMicros === 'string' && parsed.costMicros !== '', '应带回 costMicros')
    assert(
      typeof parsed.reqId === 'string' && parsed.reqId.startsWith('req-'),
      `应带回响应头 X-Request-Id 的 reqId，得到 ${JSON.stringify(parsed.reqId)}`,
    )

    // 权威值：/api/usage 里那条记录的 costMicros。
    const usage = await getUsage()
    const record = usage.records.items.find((item) => item.reqId === parsed.reqId)
    assert(record !== undefined, `在 /api/usage 里找不到 reqId=${parsed.reqId}`)
    assert(
      record.costMicros === parsed.costMicros,
      `chat 的 costMicros（${parsed.costMicros}）与 /api/usage（${record.costMicros}）不一致`,
    )
    chatCostMicros = parsed.costMicros
    chatReqId = parsed.reqId
    console.log(`    token 与费用一致：costMicros=${parsed.costMicros}（reqId ${parsed.reqId}）`)
  })

  failures += await step('dizzy usage show <reqId>：与 chat 的 costMicros 完全一致', async () => {
    const result = await dizzy(['usage', 'show', chatReqId, '--json'])
    assert(result.code === 0, `退出码应为 0，得到 ${result.code}\n${result.stderr}`)
    const parsed = JSON.parse(result.stdout)
    assert(parsed.record.reqId === chatReqId, `reqId 不一致：${parsed.record.reqId}`)
    assert(
      parsed.record.costMicros === chatCostMicros,
      `详情费用（${parsed.record.costMicros}）与 chat（${chatCostMicros}）不一致`,
    )
    // 非流式请求没有首字延迟：必须是 null（「没采集」），不能是 0（「极快」）。
    assert(parsed.record.ttftMs === null, `非流式的 ttftMs 应为 null，得到 ${parsed.record.ttftMs}`)
    console.log(`    精确对账一致：reqId=${parsed.record.reqId} · costMicros=${parsed.record.costMicros} · ttftMs=null`)
  })

  failures += await step('dizzy usage --by model：与 /api/usage 一致', async () => {
    const viaDizzy = await dizzy(['usage', '--range', '7d', '--by', 'model'])
    assert(viaDizzy.code === 0, `退出码应为 0，得到 ${viaDizzy.code}\n${viaDizzy.stderr}`)
    const usage = await getUsage()
    const totals = usage.totals
    // 费用值应出现在 CLI 输出里（元 + 微元两种形式）。
    const yuan = formatMicros(totals.costMicros)
    assert(viaDizzy.stdout.includes(totals.costMicros), `CLI 输出应含微元值 ${totals.costMicros}`)
    assert(viaDizzy.stdout.includes(yuan), `CLI 输出应含元值 ${yuan}`)
    assert(viaDizzy.stdout.includes(model), `CLI 输出应含模型名 ${model}`)
    console.log(`    汇总一致：请求 ${totals.requests} · costMicros=${totals.costMicros}（${yuan}）`)
  })

  failures += await step('dizzy usage --by key：标明是本地聚合、覆盖范围', async () => {
    const result = await dizzy(['usage', '--range', '7d', '--by', 'key'])
    assert(result.code === 0, `退出码应为 0，得到 ${result.code}\n${result.stderr}`)
    assert(result.stdout.includes('按 key 聚合：覆盖最近'), `应标明覆盖范围：${result.stdout}`)
    assert(result.stdout.includes('不是全量'), '应明确说不是全量')
    assert(result.stdout.includes('e2e-key'), `按 key 聚合里应出现 e2e-key：${result.stdout}`)
    console.log('    覆盖范围已标注（本地聚合，不是全量）')
  })

  failures += await step('dizzy usage --json：costMicros 与 chat 一致', async () => {
    const result = await dizzy(['usage', '--range', '7d', '--json'])
    assert(result.code === 0, `退出码应为 0，得到 ${result.code}\n${result.stderr}`)
    const parsed = JSON.parse(result.stdout)
    assert(Array.isArray(parsed.records.items), 'records.items 应是数组')
    const found = parsed.records.items.some((item) => item.costMicros === chatCostMicros)
    assert(found, `明细里应有一条 costMicros=${chatCostMicros}`)
  })

  failures += await step('dizzy usage export：CSV 表头正确', async () => {
    const result = await dizzy(['usage', 'export', '--range', '7d'])
    assert(result.code === 0, `退出码应为 0，得到 ${result.code}\n${result.stderr}`)
    assert(result.stdout.includes('time,api_key,model'), 'CSV 应带表头')
    assert(result.stdout.includes(model), 'CSV 应含模型名')
  })

  failures += await step('dizzy health：两端都健康，退出码 0', async () => {
    const result = await dizzy(['health'])
    assert(result.code === 0, `退出码应为 0，得到 ${result.code}\n${result.stderr}`)
    assert(result.stdout.includes('ok'), '应报告 ok')
  })

  failures += await step('dizzy keys list：不打印完整 key', async () => {
    const result = await dizzy(['keys', 'list'])
    assert(result.code === 0, `退出码应为 0，得到 ${result.code}\n${result.stderr}`)
    assert(result.stdout.includes('sk-dz-'), '应列出 key')
    assert(result.stdout.includes('…'), '默认应显示掩码')
  })

  failures += await step('dizzy admin stats（管理员视图）', async () => {
    const result = await dizzy(['admin', 'stats'])
    assert(result.code === 0, `退出码应为 0，得到 ${result.code}\n${result.stderr}`)
  })

  failures += await step('dizzy logout', async () => {
    const result = await dizzy(['logout'])
    assert(result.code === 0, `退出码应为 0，得到 ${result.code}\n${result.stderr}`)
  })

  failures += await step('dizzy usage（登出后应退出码 3）', async () => {
    const result = await dizzy(['usage'])
    assert(result.code === 3, `退出码应为 3，得到 ${result.code}\n${result.stderr}`)
  })

  console.log('')
  if (failures > 0) {
    console.error(`❌ ${failures} 项失败`)
    writeFileSync(logPath, stackLog.join(''))
    console.error('栈日志：', logPath)
    return false
  }
  console.log('✅ 完整链路实测全部通过')
  return true
}

// ───────────────────────────── 步骤 3~5：准备环境 ─────────────────────────────

async function registerUser(stackLog) {
  const request = await api('POST', '/api/auth/register/request', {
    body: { email, password, name: userName },
  })
  assert(request.status === 200, `注册请求失败：${JSON.stringify(request.body)}`)

  // 验证码走 mailer 的 log 投递：在栈日志里找「验证码：NNNNNN」。
  const code = await waitForValue(
    () => {
      const text = stackLog.join('')
      const match = text.match(/验证码[：:]\s*(\d{6})/) || text.match(/\b(\d{6})\b/)
      return match?.[1]
    },
    30000,
    '验证码出现在日志里',
  ).catch((error) => {
    // 失败时把日志尾巴打出来，否则只看到一个「超时」没法排障。
    writeFileSync(logPath, stackLog.join(''))
    console.error('栈日志尾部：\n', stackLog.join('').slice(-3000))
    throw error
  })
  const confirm = await api('POST', '/api/auth/register/confirm', { body: { email, code } })
  assert(confirm.status === 200, `注册确认失败：${JSON.stringify(confirm.body)}`)
  console.log('已注册用户：', email)
}

/** 实测夹具直接改库把用户提成管理员；CLI 自己绝不碰库（一个数据一个写者）。 */
function promoteToAdmin() {
  const db = new DatabaseSync(join(repoRoot, 'data/users.db'))
  db.exec('PRAGMA busy_timeout=5000')
  db.prepare('UPDATE users SET role = ? WHERE name = ?').run('admin', userName)
  const row = db.prepare('SELECT id, role FROM users WHERE name = ?').get(userName)
  db.close()
  assert(row !== undefined, '应能找到刚注册的用户')
  userId = row.id
  console.log('已把用户提成管理员：', JSON.stringify(row))
}

async function login() {
  const response = await api('POST', '/api/auth/login', { body: { email, password } })
  assert(response.status === 200, `登录失败：${JSON.stringify(response.body)}`)
  const cookie = response.setCookie
  assert(cookie !== undefined, '登录应返回 Set-Cookie')
  return cookie
}

async function createAccount(cookie, upstreamAddr) {
  const response = await api('POST', '/api/accounts', {
    cookie,
    body: {
      provider: 'custom',
      kind: 'api_key',
      label: 'e2e 假上游',
      baseUrl: `http://${upstreamAddr}/v1`,
      protocol: 'openai-chat',
      models: [model],
      enabled: true,
      credential: { payload: 'fake-upstream-token', kind: 'api_key' },
    },
  })
  assert(response.status === 200, `建账号失败：${JSON.stringify(response.body)}`)
  console.log('已建上游账号：', response.body.id)
}

async function setPricing(cookie) {
  // 输入 2 元 / 百万、输出 8 元 / 百万（整数偏好好算）。
  const response = await api('PUT', `/api/pricing/${model}`, {
    cookie,
    body: { inputPerMillion: '2', outputPerMillion: '8', cacheReadPerMillion: '0.5' },
  })
  assert(response.status === 200, `设价格失败：${JSON.stringify(response.body)}`)
  console.log('已设价格：', JSON.stringify(response.body))
}

async function adjustBalance(cookie) {
  // 1 亿元微 = 100 元。
  const response = await api('POST', `/api/users/${userId}/balance`, {
    cookie,
    body: { delta: '100000000', reason: 'e2e 充值' },
  })
  assert(response.status === 200, `改余额失败：${JSON.stringify(response.body)}`)
  console.log('已设余额：', JSON.stringify(response.body))
}

// ───────────────────────────── dizzy 调用 ─────────────────────────────

/**
 * 建一个 key，返回明文。
 *
 * 注意**不要**用「Go 侧快照里应该有几个 key」去等：`keys list` 是按**当前用户**
 * 返回的，而 gatewayd 的快照是**全站**的（跨运行累加），两个数永远对不上。
 * 正确做法见调用处：等「这个新 key 真的能用」。
 */
async function createKeyViaDizzy() {
  const result = await dizzy(['keys', 'create', '--name', `e2e-key-${runId}`, '--show'])
  assert(result.code === 0, `建 key 失败：${result.stderr}`)
  // 写操作必须先打目标地址：默认 base 指生产，这行是「没打错机器」的最后一道闸。
  assert(
    result.stderr.includes('http://127.0.0.1:7791'),
    `写操作应先打印目标 base，stderr 里没有：${result.stderr}`,
  )
  const match = result.stdout.match(/(sk-dz-[A-Za-z0-9_-]+)/)
  assert(match !== null, `没拿到 key：${result.stdout}`)
  return match[1]
}

async function getUsage() {
  const response = await api('GET', '/api/usage?range=7d&limit=20', { cookie: await login() })
  assert(response.status === 200, `查用量失败：${JSON.stringify(response.body)}`)
  return response.body
}

function dizzy(args, options = {}) {
  return new Promise((resolvePromise) => {
    // 本地开发时两个入口是两个端口：/v1/* 在 gatewayd，/api/* 在 api 插件。
    const baseArgs = [
      '--base', 'http://127.0.0.1:7791',
      '--llm-base', 'http://127.0.0.1:8080',
      '--api-base', 'http://127.0.0.1:7791',
    ]
    const child = spawn(exe('dizzy'), [...baseArgs, ...args], {
      cwd: repoRoot,
      env: { ...process.env, DIZZY_HOME: dizzyHome, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

// ───────────────────────────── HTTP ─────────────────────────────

async function api(method, path, options = {}) {
  const headers = { 'X-Requested-With': 'dizzyapi' }
  if (options.cookie !== undefined) headers.Cookie = options.cookie
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(`http://127.0.0.1:7791${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let body
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    body = text
  }
  const setCookieRaw = response.headers.get('set-cookie')
  const cookie = setCookieRaw === null ? undefined : setCookieRaw.split(';')[0]
  return { status: response.status, body, setCookie: cookie }
}

// ───────────────────────────── 工具 ─────────────────────────────

async function step(title, action) {
  process.stdout.write(`\n--- ${title} ---\n`)
  try {
    await action()
    console.log('    ✓ 通过')
    return 0
  } catch (error) {
    console.error('    ✗ 失败：', error.message)
    return 1
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function freeAddr() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePromise(`127.0.0.1:${port}`))
    })
    server.on('error', reject)
  })
}

async function waitTCP(addr, timeoutMs) {
  const [host, port] = addr.split(':')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const connected = await new Promise((resolvePromise) => {
      const socket = new Socket()
      socket.setTimeout(500)
      socket.connect(Number(port), host, () => {
        socket.end()
        resolvePromise(true)
      })
      socket.on('error', () => {
        socket.destroy()
        resolvePromise(false)
      })
      socket.on('timeout', () => {
        socket.destroy()
        resolvePromise(false)
      })
    })
    if (connected) return
    await sleep(100)
  }
  throw new Error(`等待 ${addr} 超时`)
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // 必须 await：谓词可能是 async（例如「再打一次 dizzy models 看通不通」）。
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`等待「${what}」超时`)
}

async function waitForValue(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value !== undefined) return value
    await sleep(100)
  }
  throw new Error(`等待「${what}」超时`)
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** 整数微元 → 元字符串（与 CLI 的 formatMicros 同口径）。 */
function formatMicros(micros) {
  const value = BigInt(micros)
  const negative = value < 0n
  const absolute = negative ? -value : value
  const unit = 1000000n
  const whole = absolute / unit
  const fraction = (absolute % unit).toString().padStart(6, '0').replace(/0+$/, '')
  const text = fraction === '' ? whole.toString() : `${whole}.${fraction}`
  return `${negative && absolute !== 0n ? '-' : ''}${text}`
}
