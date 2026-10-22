/** 表单 / 查询串的解析与同源校验。 */
import type { IncomingMessage } from 'node:http'

const MAX_BODY = 256 * 1024

export class WebError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
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
  if (typeof host !== 'string') throw new WebError('WEB_ORIGIN', '缺少 Host')
  const expected = `http${isHttps(req) ? 's' : ''}://${host}`
  if (origin !== expected) throw new WebError('WEB_ORIGIN', 'Origin 必须与站点同源')
}

function isHttps(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto']
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https'
}

export function requiredString(params: URLSearchParams, key: string, label: string): string {
  const value = params.get(key)?.trim() ?? ''
  if (value === '') throw new WebError('WEB_FIELD_REQUIRED', `${label}不能为空`)
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

/** 微元 → 带两位小数的元（图轴用）。 */
export function microsToYuan(micros: string): number {
  return Number(micros) / 1_000_000
}
