/**
 * 把账号挂的**客户端指纹档案**贴到连通性测试的请求上。
 *
 * ## 为什么要有这个文件
 *
 * 客户端档案原先只在 Go 的 `modules/transport` 里生效 —— 走网关的真实请求会贴头，
 * 而管理台的「测试连通性」是 TS 自己发的裸请求，**一个档案头都不带**。于是
 * opencode 那条账号在页面上测永远是 `HTTP 400: Request is missing x-opencode-session`，
 * 明明档案已经配好。
 *
 * ## 与 Go 逐字对齐（不对齐就是「测试通过、真实请求失败」）
 *
 * - `{{session}}` = `hex(sha256(accountID ‖ 0x00 ‖ 首条 user 消息文本))[0..32]`
 *   （Go `modules/transport/clientmask.go` 的 `sessionIDFor`）；
 * - `{{timestamp}}` = 当前毫秒；`{{uuid}}` = v4；
 * - 受保护头（鉴权 / 内容协商 / Host / Cookie / UA）**档案不许覆盖**，名单与
 *   `contracts.IsProtectedRequestHeader` 一致；
 * - 档案缺席 / 被禁用 / 解析失败 → **什么都不做**，照旧发裸请求（伪装是增强，不是前置依赖）。
 */
import { createHash, randomUUID } from 'node:crypto'

/** 档案解析后的那一小段（`clientMask.resolve()` 的返回形状）。 */
export interface AccountMask {
  readonly userAgent: string | null
  readonly headers: readonly { readonly name: string; readonly value: string }[]
}

/** 模板展开需要的上下文（测试注入固定时间 / 随机源）。 */
export interface MaskVars {
  readonly accountId: string
  /** 即将发往上游的请求体（可能被改写过的形态）。 */
  readonly body: string | undefined
  readonly now?: () => number
  readonly uuid?: () => string
}

export const PLACEHOLDER_UUID = '{{uuid}}'
export const PLACEHOLDER_SESSION = '{{session}}'
export const PLACEHOLDER_TIMESTAMP = '{{timestamp}}'

/**
 * 档案**永远不许覆盖**的请求头（小写）。名单与 Go 的
 * `contracts.IsProtectedRequestHeader` 逐字一致 —— 一处严一处松，松的那处就是绕过口。
 */
export const PROTECTED_REQUEST_HEADERS: readonly string[] = [
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'content-type',
  'content-length',
  'accept',
  'accept-encoding',
  'transfer-encoding',
  'host',
  'cookie',
  'set-cookie',
  'user-agent',
]

/** 头名是否受保护（大小写与两端空白归一）。 */
export function isProtectedRequestHeader(name: string): boolean {
  return PROTECTED_REQUEST_HEADERS.includes(name.trim().toLowerCase())
}

/**
 * 稳定会话 id：**账号 + 首条用户消息**。
 *
 * 完全随机会让 opencode 那类上游失去会话亲和（每轮都当新会话）；整份请求体的哈希
 * 会随对话变长而变。首条 user 消息在同一段对话里不变，正好是亲和需要的粒度。
 * 取不到用户文本时退化成「按账号稳定」—— 仍然稳定，只是粒度变成整个账号。
 */
export function sessionIDFor(accountId: string, body: string | undefined): string {
  const digest = createHash('sha256')
  digest.update(accountId)
  digest.update(Buffer.from([0]))
  digest.update(firstUserText(body))
  return digest.digest('hex').slice(0, 32)
}

/**
 * 从请求体里取首条用户消息的文本（与 Go `firstUserText` 同一套口径）：
 * `messages[]`（chat / anthropic）、`contents[]`（gemini）、`input[]`（responses）。
 * 解析失败返回空串，**不报错**。
 */
export function firstUserText(body: string | undefined): string {
  if (body === undefined || body === '') return ''
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return ''
  }
  if (!isRecord(payload)) return ''
  for (const key of ['messages', 'contents', 'input']) {
    const list = payload[key]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (!isRecord(item)) continue
      if (!isUserRole(item.role)) continue
      const text = textOfEntry(item)
      if (text !== '') return text
    }
  }
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUserRole(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const role = value.trim().toLowerCase()
  return role === 'user' || role === 'human'
}

/** 一个消息对象里的文本：`content`（字符串或分段数组）或 `parts`（分段数组）。 */
function textOfEntry(entry: Record<string, unknown>): string {
  if (typeof entry.content === 'string' && entry.content !== '') return entry.content
  for (const key of ['content', 'parts']) {
    const parts = entry[key]
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (!isRecord(part)) continue
      if (typeof part.text === 'string' && part.text !== '') return part.text
    }
  }
  return ''
}

/** 展开三种占位符；其它内容原样保留（装载阶段已经把非法占位符拒了）。 */
export function expandClientHeaderValue(value: string, vars: MaskVars, session: string): string {
  if (value === '') return ''
  let expanded = value
  if (expanded.includes(PLACEHOLDER_SESSION)) {
    expanded = expanded.split(PLACEHOLDER_SESSION).join(session)
  }
  if (expanded.includes(PLACEHOLDER_TIMESTAMP)) {
    const now = vars.now ?? Date.now
    expanded = expanded.split(PLACEHOLDER_TIMESTAMP).join(String(now()))
  }
  if (expanded.includes(PLACEHOLDER_UUID)) {
    const uuid = vars.uuid ?? randomUUID
    expanded = expanded.split(PLACEHOLDER_UUID).join(uuid())
  }
  return expanded
}

/**
 * 把档案头贴进请求头表（就地修改调用方给的副本）。
 *
 * 顺序与 Go 一致：**先写网关自己的头**（调用方已经写好），档案在其后贴、且跳过受保护头。
 * UA 走专用字段：档案声明了非空 UA 才覆盖。
 */
export function applyAccountMask(headers: Record<string, string>, mask: AccountMask, vars: MaskVars): void {
  const userAgent = mask.userAgent?.trim() ?? ''
  if (userAgent !== '') headers['user-agent'] = userAgent
  if (mask.headers.length === 0) return

  // `{{session}}` 每个请求只算一次：一个档案里多个头引用它必须同值。
  let session: string | null = null
  for (const header of mask.headers) {
    const name = header.name.trim()
    if (name === '') continue
    if (isProtectedRequestHeader(name)) continue
    session ??= sessionIDFor(vars.accountId, vars.body)
    headers[name.toLowerCase()] = expandClientHeaderValue(header.value, vars, session)
  }
}

/**
 * 从任意对象上解析一个账号挂的档案（`clientMask.resolve()`）。
 *
 * 这里刻意用**结构性**取值（不 import client-mask 实现包，插件间不互相依赖）：
 * - 服务不在运行 / 不是这个形状 / 解析抛错 → 一律 `undefined`（照旧发裸请求）；
 * - **绝不把异常抛出去**：伪装是增强，不能让一次连通性测试因为档案坏掉而失败。
 */
export function resolveAccountMask(service: unknown, profileId: string | null | undefined): AccountMask | undefined {
  if (service === undefined || service === null) return undefined
  const resolve = (service as { resolve?: unknown }).resolve
  if (typeof resolve !== 'function') return undefined
  if (profileId === null || profileId === undefined || profileId === '') return undefined
  try {
    const mask = (resolve as (id: string) => AccountMask | undefined).call(service, profileId)
    return mask ?? undefined
  } catch {
    return undefined
  }
}
