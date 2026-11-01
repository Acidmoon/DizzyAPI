/**
 * 占位符与头值的校验规则。
 *
 * 这里是**安全面**：档案的值会被原样贴到上游请求头上，一旦里面能塞进换行，
 * 就是 HTTP 头注入（`\r\n` 能凭空造出一个新头，甚至拆出第二个请求）；
 * 一旦能塞进秘密，秘密就进了 `data/client-mask.json`、进了桥帧、进了管理页。
 *
 * 规则三条：
 * 1. **头名必须是 HTTP token**，且不许出现在**受保护名单**里（那几条由网关自己决定，
 *    档案改了就会破坏鉴权 / 内容协商 / Host 一致性）；
 * 2. **头值不许有控制字符**（含 `\r` / `\n` / NUL），长度有上限；
 * 3. **值里只允许三种占位符**，其它 `{{...}}` 一律拒绝；**不许像秘密**。
 *
 * Go 侧会再校验一遍（不能只信 TS）：快照里任何一条不合法 → **整份拒绝**，
 * 与 `internal/accounts` 既有口径一致（不许部分应用）。
 */

/** 允许的三个占位符。 */
export const PLACEHOLDER_UUID = '{{uuid}}'
export const PLACEHOLDER_SESSION = '{{session}}'
export const PLACEHOLDER_TIMESTAMP = '{{timestamp}}'

export const ALLOWED_PLACEHOLDERS: readonly string[] = [
  PLACEHOLDER_UUID,
  PLACEHOLDER_SESSION,
  PLACEHOLDER_TIMESTAMP,
]

/**
 * **受保护的请求头**：档案不许覆盖它们。
 *
 * 与 Go 侧 `modules/transport` 的保护名单必须逐字一致（两边各有一份，靠用例钉住）：
 * - `content-type` / `accept` / `accept-encoding` / `content-length` / `transfer-encoding`：
 *   由网关按请求形态与上游协议决定，改了会毁掉流式与编解码；
 * - `host`：改成别的值会让 TLS SNI 与 Host 不一致；
 * - `authorization` / `x-api-key` / `x-goog-api-key`：**鉴权头只由网关自己写**，
 *   档案碰它就是拿账号令牌的位置换一个编造的值；
 * - `user-agent`：UA 有专用字段（`userAgent`），不允许用头重复声明，否则两处打架；
 * - `cookie` / `set-cookie`：会话凭据，不该由档案编造。
 */
export const PROTECTED_HEADERS: readonly string[] = [
  'content-type',
  'content-length',
  'accept',
  'accept-encoding',
  'transfer-encoding',
  'host',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'user-agent',
  'cookie',
  'set-cookie',
]

/** 头名上限（RFC 7230 没有硬上限，但长过头名只可能是攻击）。 */
export const MAX_HEADER_NAME_BYTES = 128
/** 头值上限：真实的指纹头都远小于这个数。 */
export const MAX_HEADER_VALUE_BYTES = 512
/** 一个档案最多几个头。 */
export const MAX_HEADERS_PER_PROFILE = 24
/** 一个档案 id 的长度上限。 */
export const MAX_PROFILE_ID_BYTES = 64

/** HTTP token（RFC 7230 §3.2.6）：头名只能是这些字符。 */
const TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * 「像秘密」的形状。
 *
 * 这不是密码学判断，是**防手滑**：有人把 `sk-xxx` 粘进档案时立刻拒绝，
 * 而不是等它出现在管理页 / 桥帧里才被发现。宁可误拒（管理员改个写法即可）。
 */
const SECRET_LIKE: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /sk-[A-Za-z0-9_-]{8,}/, what: 'API key（sk-…）' },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i, what: 'Bearer 令牌' },
  { pattern: /gh[pousr]_[A-Za-z0-9]{16,}/, what: 'GitHub 令牌' },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/, what: 'GitHub 细粒度令牌' },
  { pattern: /AKIA[0-9A-Z]{16}/, what: 'AWS access key' },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/, what: 'Slack 令牌' },
  { pattern: /AIza[0-9A-Za-z_-]{30,}/, what: 'Google API key' },
]

/** 校验头名；返回错误文案，`null` = 合法。 */
export function validateHeaderName(name: string): string | null {
  // 两端空白先 trim：管理员从别处粘贴时经常带空格，trim 之后才是真正的头名。
  // 注意 trim **不会**去掉内嵌换行 —— 那种名字仍是非法 token，会被下面的正则拒掉。
  const trimmed = name.trim()
  if (trimmed === '') return '头名不能为空'
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_HEADER_NAME_BYTES) {
    return `头名太长（上限 ${String(MAX_HEADER_NAME_BYTES)} 字节）`
  }
  if (!TOKEN_PATTERN.test(trimmed)) return `头名含非法字符：${trimmed}`
  if (PROTECTED_HEADERS.includes(trimmed.toLowerCase())) {
    return `头 ${trimmed} 由网关自己决定，档案不许覆盖（受保护名单：${PROTECTED_HEADERS.join(' / ')}）`
  }
  return null
}

/** 校验头值（含占位符规则）；返回错误文案，`null` = 合法。 */
export function validateHeaderValue(value: string): string | null {
  if (Buffer.byteLength(value, 'utf8') > MAX_HEADER_VALUE_BYTES) {
    return `头值太长（上限 ${String(MAX_HEADER_VALUE_BYTES)} 字节）`
  }
  // 控制字符一律拒绝：`\r\n` 就是头注入，`\0` 会截断下游的解析。
  // 制表符在 HTTP 头值里合法（obs-fold 的空白），但这里也拒绝：它没有正当用途。
  if (/[\u0000-\u001f\u007f]/.test(value)) return '头值不能含控制字符（换行会导致头注入）'

  // 占位符：每一处 `{{` 都必须正好是一个允许的占位符。
  const leftovers = value.replace(/\{\{(uuid|session|timestamp)\}\}/g, '')
  if (leftovers.includes('{{') || leftovers.includes('}}')) {
    return `头值里有不认识的占位符（只允许 ${ALLOWED_PLACEHOLDERS.join(' / ')}）`
  }

  for (const rule of SECRET_LIKE) {
    if (rule.pattern.test(value)) return `头值看起来是${rule.what} —— 档案里不许出现秘密值`
  }
  return null
}

/** 校验 UA（同一套规则，只是没有占位符里的 `{{session}}` 也能用 —— 这里不限制）。 */
export function validateUserAgent(value: string): string | null {
  if (Buffer.byteLength(value, 'utf8') > MAX_HEADER_VALUE_BYTES) {
    return `User-Agent 太长（上限 ${String(MAX_HEADER_VALUE_BYTES)} 字节）`
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'User-Agent 不能含控制字符'
  for (const rule of SECRET_LIKE) {
    if (rule.pattern.test(value)) return `User-Agent 看起来是${rule.what} —— 不许出现秘密值`
  }
  return null
}

/** 档案 id 只能是「小写字母 / 数字 / 连字符 / 下划线」，且要短：它会进账号记录与快照。 */
export function validateProfileId(id: string): string | null {
  if (id.trim() === '') return '档案 id 不能为空'
  if (Buffer.byteLength(id, 'utf8') > MAX_PROFILE_ID_BYTES) {
    return `档案 id 太长（上限 ${String(MAX_PROFILE_ID_BYTES)} 字节）`
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    return '档案 id 只能用小写字母 / 数字 / 连字符 / 下划线，并且以字母或数字开头'
  }
  return null
}

/** 值里用到了哪些占位符（管理页展示用）。 */
export function placeholdersIn(value: string): string[] {
  const found = new Set<string>()
  for (const placeholder of ALLOWED_PLACEHOLDERS) {
    if (value.includes(placeholder)) found.add(placeholder)
  }
  return [...found]
}
