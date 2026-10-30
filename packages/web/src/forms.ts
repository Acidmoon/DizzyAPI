/** 表单 / 查询串的解析与同源校验。 */
import type { IncomingMessage } from 'node:http'

const MAX_BODY = 256 * 1024

/**
 * 业务错误。
 *
 * `field` 是**出错字段的表单 name**（可选）。有值时 `web` 会把它带进失败重定向
 * （`?err=…&field=…`），页面顶部的提示条带上 `data-field`，客户端脚本据此把
 * 错误**搬到那个字段下方**并聚焦它（「错误就地显示 + 聚焦第一个错误」）。
 * 技术性字段（隐藏的 id）不挂 field：它们没有可见控件可以抬头。
 */
export class WebError extends Error {
  readonly code: string
  readonly field: string | undefined
  constructor(code: string, message: string, field?: string) {
    super(message)
    this.code = code
    this.field = field
  }
}

/** 读取 `application/x-www-form-urlencoded` 请求体。 */
export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY) throw new WebError('WEB_BODY_TOO_LARGE', '提交内容过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return new URLSearchParams(text)
}

/**
 * 业务错误 → 给人看的一句话。
 *
 * 带稳定 code 的错误（`WebError`，或下游插件抛的 `USER_…` / `API_KEY_…`）显示它自己的
 * 中文消息；其余一律兜底，**不泄露内部细节**（堆栈、SQL、上游响应都不该出现在页面上）。
 * 放在 `forms.ts`：`WebError` 定义在这，判断「什么算可展示的业务错误」与它同源。
 */
export function describeError(error: unknown): string {
  if (error instanceof WebError) return error.message
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (
      typeof code === 'string' &&
      /^[A-Z][A-Z0-9_]+$/.test(code) &&
      error.message.length > 0 &&
      error.message.length <= 160 &&
      !error.message.includes('\n')
    ) {
      return error.message
    }
  }
  return '操作失败，请稍后再试'
}

/**
 * 失败动作的 303 目标地址：`<page>?err=…[&field=…]`。
 *
 * 为什么放在这里：`describeError` 决定「给人看的那句话」，`field` 决定「这句话该
 * 贴在哪个字段下方」，两者是同一件事（把内部错误翻成用户能照着改的提示）。
 * 放在 `service.ts` 的 catch 里会把那个文件继续撑大（本就 460+ 行）。
 */
export function errorRedirect(pagePath: string, error: unknown): string {
  const query = new URLSearchParams({ err: describeError(error) })
  const field = error instanceof WebError && typeof error.field === 'string' ? error.field : undefined
  if (field !== undefined && field !== '') query.set('field', field)
  return `${pagePath}?${query.toString()}`
}

/**
 * 这条动作请求是不是 `fetch` 发起的（不要 303 重定向）。
 *
 * 判据是 `X-Requested-With: dizzyapi`：自定义头**跨站表单加不了**（跨站 fetch 想加
 * 就得过 CORS 预检，而我们不放行），所以它和 `assertSameOrigin` 一起用很安全。
 * 用法只有一处：侧栏拖动排序落库（`client-nav-order.ts`）——它只关心成没成，
 * 跟着 303 把整页 HTML 再拉一遍是纯浪费。
 */
export function wantsNoRedirect(req: IncomingMessage): boolean {
  return req.headers['x-requested-with'] === 'dizzyapi'
}

/** 表单 POST 必须是同源：浏览器会带 Origin，跨站表单会被 SameSite 与这里一起拦住。 */
export function assertSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin
  if (origin === undefined) {
    // 非浏览器客户端 / 老浏览器：没有 Origin 时只接受 same-origin 的 Sec-Fetch-Site
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin') {
      throw new WebError('WEB_CROSS_SITE', '拒绝跨站提交')
    }
    return
  }
  const host = req.headers['x-forwarded-host'] ?? req.headers.host
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new WebError('WEB_ORIGIN', 'Origin 不合法')
  }
  // 比较 host（含端口），不比较协议：反向代理会把 Origin 改写成回环地址。
  if (typeof host !== 'string' || parsed.host !== host) {
    throw new WebError('WEB_ORIGIN', 'Origin 必须与站点同源')
  }
}

function isHttps(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto']
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https'
}

export function requiredString(params: URLSearchParams, key: string, label: string): string {
  const value = params.get(key)?.trim() ?? ''
  // 挂上字段名，失败回跳时就地提示在字段下方（`id` 这类隐藏字段不挂）。
  if (value === '') throw new WebError('WEB_FIELD_REQUIRED', `${label}不能为空`, key === 'id' ? undefined : key)
  return value
}

export function optionalString(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim()
  return value === undefined || value === '' ? undefined : value
}

export function boolField(params: URLSearchParams, key: string): boolean {
  return params.get(key) === '1' || params.get(key) === 'on' || params.get(key) === 'true'
}

/** 微元（1 元 = 1_000_000）→ `¥1,137.94`。 */
export function formatYuan(micros: bigint | string | number): string {
  const value = typeof micros === 'bigint' ? micros : BigInt(micros)
  const negative = value < 0n
  const abs = negative ? -value : value
  const yuan = abs / 1_000_000n
  const cents = (abs % 1_000_000n) / 10_000n
  return `${negative ? '-' : ''}¥${yuan.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`
}

/**
 * 元（十进制字符串，最多 6 位小数）→ 整数微元。**只做字符串拆分，不经过浮点**。
 *
 * 表单里的金额是给人看的「元」，服务层的额度是整数微元（1 元 = 1_000_000 微元）；
 * 换算必须在字符串上做，`Number` / `parseFloat` 会把 0.1 变成 0.100000000000000005…
 */
export function parseYuanToMicros(text: string): bigint {
  const value = text.trim()
  const match = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(value)
  if (match === null) {
    throw new WebError('WEB_AMOUNT_INVALID', '金额必须是正数，最多 6 位小数')
  }
  const whole = BigInt(match[1] as string)
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0'))
  return whole * 1_000_000n + fraction
}

/** 微元 → 带两位小数的元（图轴用）。 */
export function microsToYuan(micros: string): number {
  return Number(micros) / 1_000_000
}
