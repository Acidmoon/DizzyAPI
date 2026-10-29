/**
 * **从代码派生文档事实**（自证机制的核心）。
 *
 * 为什么要有这个文件：如果文档里的「错误码表 / 入口路径表 / 协议名表」是**手写**的，
 * 它就会腐烂——代码加了一个入口，文档不会自动知道；测试只能红成「文档没更新」，
 * 而不是「代码有问题」。所以这些**事实性清单一律从代码实时读**，页面渲染的也是读出来的
 * 结果（`api_docs.ts` 把生成的 markdown 表插进叙述里）：
 *
 * - LLM 入口：`internal/httpapi/server.go` 的 `mux.HandleFunc` 注册处（方法看 handler 体里的
 *   `http.MethodPost` / `http.MethodGet`；协议看 `contracts.ProtocolXxx` 实参）
 * - 错误码：Go 侧扫 `contracts.Errorf(http.StatusXxx, "CODE", "说明")` 与
 *   `writeErrorFor(..., http.StatusXxx, "CODE", "说明")`；TS 侧读
 *   `packages/api/src/errors.ts` 的 `ApiErrorCode` 联合、`EXPLICIT_STATUS` 显式表、
 *   `statusOfCode()` 的后缀规则，以及各插件的 `new ApiError('CODE', 状态码, …)` 字面量
 * - 协议名：`contracts/ir.go` 的 `ProtocolXxx Protocol = "…"`
 *
 * **失败策略**：读不到 / 解析不出来**明确失败**（抛出带文件名的错误），不静默返回空表——
 * 空表会让页面显示「没有错误码」，那是比报错更糟的误导。
 *
 * **性能**：结果按进程缓存（源码不会在运行期变）；叙述性 markdown 不缓存，改完立刻生效。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 仓库根目录：本文件在 `packages/web/src/content/` 下。 */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

function read(relative: string): string {
  try {
    return readFileSync(`${ROOT}${relative}`, 'utf8')
  } catch (error) {
    throw new Error(`读不到源码 ${relative}（${error instanceof Error ? error.message : String(error)}）`)
  }
}

/** 递归收集某个根之下、未被排除的源码文件（相对仓库根的 posix 路径）。 */
function collect(roots: readonly string[], extensions: readonly RegExp[]): string[] {
  const found: string[] = []
  const walk = (relative: string): void => {
    let names: string[]
    try {
      names = readdirSync(`${ROOT}${relative}`)
    } catch {
      return
    }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git' || name === 'data' || name === 'bin') continue
      const child = `${relative}/${name}`
      let isDirectory = false
      try {
        isDirectory = statSync(`${ROOT}${child}`).isDirectory()
      } catch {
        continue
      }
      if (isDirectory) walk(child)
      else if (extensions.some((pattern) => pattern.test(name))) found.push(child)
    }
  }
  for (const root of roots) walk(root)
  return found
}

/**
 * Go `http.StatusXxx` → 状态码（键是**去掉 `Status` 前缀**的名字，因为正则已经把
 * `http.Status` 吃掉了）。遇到未登记的名字明确失败（不猜）。
 */
const GO_STATUS: Readonly<Record<string, number>> = {
  OK: 200,
  BadRequest: 400,
  Unauthorized: 401,
  PaymentRequired: 402,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  Conflict: 409,
  UnprocessableEntity: 422,
  RequestEntityTooLarge: 413,
  TooManyRequests: 429,
  InternalServerError: 500,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
}

function goStatus(name: string, where: string): number {
  const status = GO_STATUS[name]
  if (status === undefined) throw new Error(`${where} 用了未登记的 http.Status${name}，先在 api_facts.ts 的 GO_STATUS 里补上`)
  return status
}

// ───────────────────────────── LLM 入口 ─────────────────────────────

/** 一个 LLM 入口（从 Go 注册处读出来）。 */
export interface EntryFact {
  readonly method: string
  readonly path: string
  /** 客户端协议值（空串 = 不分协议，例如 /healthz）。 */
  readonly protocol: string
  /** 代码里用的协议常量名（`ProtocolGemini` 之类），给人对回源码用。 */
  readonly protocolConst: string
}

/** 解析 route 结构体字面量里的 `protocol: contracts.ProtocolXxx`。 */
function protocolOf(block: string): string {
  const match = /protocol:\s*contracts\.(Protocol[A-Za-z]+)/.exec(block)
  return match === null ? '' : match[1]
}

/** 取某个 Go 函数的函数体（从 `func … name(` 起，按花括号配平到函数末尾）。 */
function goFuncBody(files: readonly string[], name: string): string | undefined {
  for (const file of files) {
    const source = read(file)
    const signature = new RegExp(`^func \\([^)]*\\) ${name}\\(`, 'm')
    const match = signature.exec(source)
    if (match === null) continue
    const start = source.indexOf('{', match.index + match[0].length)
    if (start < 0) continue
    let depth = 0
    for (let index = start; index < source.length; index += 1) {
      const char = source[index]
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) return source.slice(start, index + 1)
      }
    }
  }
  return undefined
}

/** handler 体里的方法约束：`r.Method != http.MethodPost` → POST。 */
function methodOfHandlerBody(body: string, where: string): string {
  const post = body.includes('http.MethodPost')
  const get = body.includes('http.MethodGet')
  if (post && !get) return 'POST'
  if (get && !post) return 'GET'
  // Gemini 的 handler 自己不做方法判断，转交给 llmRouteHandler（那是 POST）。
  if (body.includes('llmRouteHandler(')) return 'POST'
  throw new Error(`${where} 的 handler 里既有 / 既无 MethodPost / MethodGet，无法判断方法`)
}

function deriveEntries(): EntryFact[] {
  const httpapi: string[] = ['internal/httpapi/server.go', 'internal/httpapi/gemini.go']
  const server = read('internal/httpapi/server.go')
  const gemini = read('internal/httpapi/gemini.go')
  /** 协议常量名 → 值（`ProtocolOpenAIChat` → `openai-chat`）。 */
  const protocolValues = new Map<string, string>()
  for (const match of read('contracts/ir.go').matchAll(/(Protocol[A-Za-z]+)\s+Protocol\s*=\s*"([a-z-]+)"/g)) {
    protocolValues.set(match[1], match[2])
  }
  const resolveProtocol = (constant: string): string => {
    if (constant === '') return ''
    const value = protocolValues.get(constant)
    if (value === undefined) throw new Error(`contracts/ir.go 里没有协议常量 ${constant}`)
    return value
  }
  const make = (method: string, path: string, constant: string): EntryFact => ({
    method,
    path,
    protocol: resolveProtocol(constant),
    protocolConst: constant,
  })

  // Gemini 的方法名（Gemini 是前缀路由，具体方法在路径后缀里）。
  const geminiMethods = [...gemini.matchAll(/geminiMethod(?:Stream)?GenerateContent\s*=\s*"([A-Za-z]+)"/g)].map(
    (match) => match[1],
  )
  if (geminiMethods.length !== 2) throw new Error('internal/httpapi/gemini.go 里读不到两个 Gemini 方法名')
  const geminiPrefix = /geminiPathPrefix\s*=\s*"([^"]+)"/.exec(gemini)?.[1]
  if (geminiPrefix === undefined) throw new Error('internal/httpapi/gemini.go 里读不到 geminiPathPrefix')

  const entries: EntryFact[] = []
  // 注册形式：mux.HandleFunc("path", <expr>)，expr 可能跨行（llmRoute{…}）。
  for (const match of server.matchAll(/mux\.HandleFunc\("([^"]+)",\s*/g)) {
    const path = match[1]
    const rest = server.slice(match.index + match[0].length)
    const where = `internal/httpapi/server.go 的 ${path} 注册`

    // 直接挂 handler：s.handleXxx
    const direct = /^s\.(handle[A-Za-z]+)/.exec(rest)
    if (direct !== null) {
      const handlerName = direct[1]
      const body = goFuncBody(httpapi, handlerName)
      if (body === undefined) throw new Error(`${where} 指向的 ${handlerName} 找不到函数体`)
      const method = methodOfHandlerBody(body, where)
      const protocol = protocolOf(body)
      if (path.endsWith('/')) {
        // 前缀路由：把方法名展开成具体路径（Gemini 的 :generateContent 等）。
        for (const methodName of geminiMethods) {
          entries.push(make(method, `${path}{model}:${methodName}`, protocol))
        }
      } else {
        entries.push(make(method, path, protocol))
      }
      continue
    }

    // s.llmHandler(contracts.ProtocolXxx, "path")
    const llm = /^s\.llmHandler\(\s*contracts\.(Protocol[A-Za-z]+)/.exec(rest)
    if (llm !== null) {
      entries.push(make('POST', path, llm[1]))
      continue
    }

    // s.llmRouteHandler(llmRoute{ … })（可能跨行）
    if (rest.startsWith('s.llmRouteHandler(')) {
      const block = rest.slice(0, 400)
      entries.push(make('POST', path, protocolOf(block)))
      continue
    }

    throw new Error(`${where} 的注册形式无法识别（新增了注册写法？先在 api_facts.ts 里支持它）`)
  }

  if (entries.length === 0) throw new Error('internal/httpapi/server.go 里没读到任何 mux.HandleFunc 注册')
  return entries
}

// ───────────────────────────── 协议名 ─────────────────────────────

function deriveProtocols(): { name: string; value: string }[] {
  const source = read('contracts/ir.go')
  const protocols = [...source.matchAll(/(Protocol[A-Za-z]+)\s+Protocol\s*=\s*"([a-z-]+)"/g)].map((match) => ({
    name: match[1],
    value: match[2],
  }))
  if (protocols.length === 0) throw new Error('contracts/ir.go 里没读到协议常量')
  return protocols
}

// ───────────────────────────── 错误码（Go） ─────────────────────────────

/** 一条错误码事实。 */
export interface ErrorFact {
  readonly code: string
  readonly status: number
  /** 出处（源码文件，相对仓库根）。 */
  readonly source: string
  /** 代码里自带的人话说明（Go 侧能读出来；TS 侧多为动态消息，通常为空）。 */
  readonly message: string
}

function deriveGatewayErrors(): ErrorFact[] {
  const files = collect(['contracts', 'modules', 'internal'], [/\.go$/]).filter(
    (file) => !/_test\.go$/.test(file),
  )
  // 先建 Go 常量名 → {码值, 定义处文件}（`CodeAllAccountsSaturated = "ALL_ACCOUNTS_SATURATED"`）。
  // 定义处要留着：构造点常常只写常量名，字面量只在定义文件里出现，「出处」应该指定义文件。
  const constants = new Map<string, { code: string; file: string }>()
  for (const file of files) {
    for (const match of read(file).matchAll(/(Code[A-Za-z]+)\s*=\s*"([A-Z][A-Z0-9_]+)"/g)) {
      constants.set(match[1], { code: match[2], file })
    }
  }

  const found = new Map<string, ErrorFact>()
  const record = (code: string, status: number, message: string, file: string): void => {
    const existing = found.get(code)
    // 同一个码可能有多处构造（同一状态码是常态）；保留第一条非空说明。
    if (existing === undefined) {
      found.set(code, { code, status, source: file, message })
      return
    }
    if (existing.message === '' && message !== '') {
      found.set(code, { ...existing, message })
    }
  }

  // 形式一：contracts.Errorf(http.StatusXxx, "CODE" | contracts.CodeXxx, "说明")
  const errorf =
    /Errorf\(\s*http\.Status([A-Za-z]+),\s*(?:"([A-Z][A-Z0-9_]+)"|contracts\.(Code[A-Za-z]+))(?:\s*,\s*"([^"]*)")?/g
  // 形式二：writeErrorFor(w, protocol, http.StatusXxx, "CODE", "说明")
  const writeError =
    /writeErrorFor\([^;]*?http\.Status([A-Za-z]+),\s*"([A-Z][A-Z0-9_]+)"(?:\s*,\s*"([^"]*)")?/g
  // 形式三：&contracts.StageError{ Status: NNN, Code: CodeXxx, Message: "说明" }
  // （阶段模块用这种；字段顺序固定为 Status → Code → Message，见 modules/*/errors.go）
  const stageError =
    /&contracts\.StageError\{\s*Status:\s*(\d{3}),\s*Code:\s*(?:Code([A-Za-z]+)|"([A-Z][A-Z0-9_]+)")(?:\s*,\s*Message:\s*(?:"([^"]*)"|fmt\.Sprintf\("([^"]*)")?)?/g

  for (const file of files) {
    const source = read(file)
    for (const match of source.matchAll(errorf)) {
      const definition = match[2] === undefined ? constants.get(match[3]) : undefined
      const code = match[2] ?? definition?.code
      if (code === undefined) throw new Error(`${file} 里引用了未定义的常量 ${match[3]}`)
      record(code, goStatus(match[1], file), match[4] ?? '', definition?.file ?? file)
    }
    for (const match of source.matchAll(writeError)) {
      record(match[2], goStatus(match[1], file), match[3] ?? '', file)
    }
    for (const match of source.matchAll(stageError)) {
      const definition = match[3] === undefined ? constants.get(`Code${match[2]}`) : undefined
      const code = match[3] ?? definition?.code
      if (code === undefined) throw new Error(`${file} 的 StageError 引用了未定义的常量 Code${match[2]}`)
      record(code, Number(match[1]), match[4] ?? match[5] ?? '', definition?.file ?? file)
    }
  }

  if (found.size < 10) throw new Error(`Go 侧只读到 ${found.size} 个错误码，解析规则可能失效了`)
  return [...found.values()].sort((a, b) => a.code.localeCompare(b.code))
}

// ───────────────────────────── 错误码（TS 产品面） ─────────────────────────────

/** `statusOfCode()` 的后缀兜底规则（从源码里读，不复制一份）。 */
function deriveSuffixRules(): { pattern: RegExp; status: number }[] {
  const source = read('packages/api/src/errors.ts')
  const body = source.slice(source.indexOf('export function statusOfCode'))
  const rules: { pattern: RegExp; status: number }[] = []
  for (const match of body.matchAll(/if \(\/(.+?)\/\.test\(code\)\) return (\d{3})/g)) {
    rules.push({ pattern: new RegExp(match[1]), status: Number(match[2]) })
  }
  if (rules.length === 0) throw new Error('packages/api/src/errors.ts 的 statusOfCode() 里没读到后缀规则')
  return rules
}

function deriveProductErrors(): ErrorFact[] {
  const errorsFile = 'packages/api/src/errors.ts'
  const source = read(errorsFile)

  const unionBlock = source.slice(source.indexOf('export type ApiErrorCode'), source.indexOf('export class ApiError'))
  const union = [...unionBlock.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((match) => match[1])

  const explicitBlock = source.slice(
    source.indexOf('const EXPLICIT_STATUS'),
    source.indexOf('export function statusOfCode'),
  )
  const explicit = new Map<string, number>()
  for (const match of explicitBlock.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*(\d{3}),/gm)) {
    explicit.set(match[1], Number(match[2]))
  }

  // 各插件的 new ApiError('CODE', 状态码, '消息') 字面量（自带状态码，最可靠；
  // 消息多数是运行时拼的，只有字面量能读，读不到就留空 = 页面显示「—」，不编。
  const literals = new Map<string, { status: number; source: string; message: string }>()
  const tsFiles = collect(['packages'], [/\.ts$/]).filter((file) => !/\.test\.ts$/.test(file))
  for (const file of tsFiles) {
    for (const match of read(file).matchAll(/new ApiError\('([A-Z][A-Z0-9_]+)',\s*(\d{3})(?:,\s*'([^'\\]*)')?/g)) {
      const existing = literals.get(match[1])
      const message = match[3] ?? ''
      if (existing === undefined) {
        literals.set(match[1], { status: Number(match[2]), source: file, message })
      } else if (existing.message === '' && message !== '') {
        literals.set(match[1], { ...existing, message })
      }
    }
  }

  const suffixes = deriveSuffixRules()
  const resolve = (code: string): number => {
    const explicitStatus = explicit.get(code)
    if (explicitStatus !== undefined) return explicitStatus
    const literal = literals.get(code)
    if (literal !== undefined) return literal.status
    for (const rule of suffixes) if (rule.pattern.test(code)) return rule.status
    return 500
  }

  const codes = new Set<string>([...union, ...explicit.keys(), ...literals.keys()])
  if (codes.size < 20) throw new Error(`TS 侧只读到 ${codes.size} 个错误码，解析规则可能失效了`)

  const facts: ErrorFact[] = []
  for (const code of codes) {
    const literal = literals.get(code)
    const isInErrors = union.includes(code) || explicit.has(code)
    facts.push({
      code,
      status: resolve(code),
      source: isInErrors ? errorsFile : (literal?.source ?? errorsFile),
      message: literal?.message ?? '',
    })
  }
  return facts.sort((a, b) => a.code.localeCompare(b.code))
}

// ───────────────────────────── 对外 ─────────────────────────────

export interface ApiCodeFacts {
  readonly entries: readonly EntryFact[]
  readonly protocols: readonly { name: string; value: string }[]
  readonly gatewayErrors: readonly ErrorFact[]
  readonly productErrors: readonly ErrorFact[]
}

let cached: ApiCodeFacts | undefined

/** 从代码派生全部事实（进程内缓存：源码不会在运行期变）。 */
export function readCodeFacts(): ApiCodeFacts {
  if (cached !== undefined) return cached
  cached = {
    entries: deriveEntries(),
    protocols: deriveProtocols(),
    gatewayErrors: deriveGatewayErrors(),
    productErrors: deriveProductErrors(),
  }
  return cached
}
