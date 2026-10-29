/**
 * 脱敏：审计表**不是**秘密存放处（AGENTS.md §5.1）。
 *
 * 两道闸：
 *
 * 1. **键名命中**：`password` / `token` / `secret` / `credential` / `authorization` /
 *    `cookie` / `apikey` / `api_key` / `codePlain`… 的值一律替换成 `[已脱敏]`，
 *    不管值长什么样（哪怕它看起来像普通数字）。
 * 2. **值命中**：键名无关，只要字符串里出现已知的秘密形状（`sk-…`、`Bearer …`、
 *    `ghp_…`、`AKIA…`、`xoxb-…`），就把那段替换掉；摘要文本也走这一道。
 *
 * 这不是「猜全部可能」的安全机制，而是**兜底**：调用方本来就不该把秘密塞进审计
 * （`metadata` 只放变化量、字段名、状态这些事实）。两道闸保证「手滑一次」不会留下明文。
 */

/** 替换后的占位符；页面会原样展示，所以用中文短语。 */
export const REDACTED = '[已脱敏]'

/**
 * 键名黑名单。
 *
 * 刻意包含 `codePlain` / `redeemCode`：兑换码明文也算秘密（它的哈希与掩码才是可留的）。
 * 刻意**不**包含 `errorCode` / `status` / `model` 这些正常字段——`errorCode` 里的
 * `code` 不会命中，因为这里按完整键名匹配而不是子串包含。
 */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /password/i,
  /passwd/i,
  /^pwd$/i,
  /secret/i,
  /^token$/i,
  // `accessToken` / `refreshToken` / `sessionToken`：驼峰里以 `Token` 结尾。
  // 不写 `/token/i`，否则 `inputTokens` 这种正常计数也会被抹掉。
  /^[a-zA-Z]*Token$/,
  /_token$/i,
  /^credentials?$/i,
  /credentialValue/i,
  /authorization/i,
  /^cookie$/i,
  /^cookieValue$/i,
  /^api[_-]?key$/i,
  /apiKeyValue/i,
  /^apikey$/i,
  /private[_-]?key/i,
  /^access[_-]?key$/i,
  /client[_-]?secret/i,
  /^code$/i,
  /codePlain/i,
  /redeemCode/i,
  /plaintext/i,
]

/** 值里的秘密形状。命中即替换（大小写不敏感的模式用 `gi`）。 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // OpenAI 风格：sk- / sk-proj- / sk-ant-
  /sk-[A-Za-z0-9_-]{6,}/g,
  // Authorization 头
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // GitHub token
  /gh[pousr]_[A-Za-z0-9]{10,}/g,
  // AWS access key id
  /AKIA[0-9A-Z]{12,}/g,
  // Slack token
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,
]

/** 单条记录的元数据上限：超过就只保留前 N 个键，防止一条记录把库撑大。 */
const MAX_METADATA_KEYS = 32
const MAX_METADATA_DEPTH = 4
const MAX_ARRAY_ITEMS = 32
const MAX_TEXT_LENGTH = 500

/**
 * 把字符串里的秘密形状替换掉，并截断超长文本。
 *
 * 摘要（`summary`）也走这里：调用方可能把用户输入拼进摘要，一段 `sk-...` 就会泄进审计。
 */
export function redactText(value: string): string {
  let text = value
  for (const pattern of SECRET_VALUE_PATTERNS) {
    // 每个 pattern 单独建 lastIndex：直接复用带 g 的正则会跨调用携带位置。
    text = text.replace(new RegExp(pattern.source, pattern.flags.includes('i') ? 'gi' : 'g'), REDACTED)
  }
  if (text.length > MAX_TEXT_LENGTH) {
    text = `${text.slice(0, MAX_TEXT_LENGTH)}…（已截断）`
  }
  return text
}

/** 键名是否命中秘密黑名单。 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

/**
 * 深拷贝并脱敏任意值；调用方给的对象不会被改动。
 *
 * 规则：
 * - 键名命中黑名单 → 整棵子树替换成 `[已脱敏]`（不递归它的内容）；
 * - 字符串 → `redactText`；
 * - 数字 / 布尔 / null 原样（金额只以十进制字符串传，所以不会出现丢精度的 number）；
 * - 数组截到 `MAX_ARRAY_ITEMS`，对象只保留前 `MAX_METADATA_KEYS` 个键，深度超过 4 层记 `[过深]`；
 * - 函数 / Symbol / undefined → 丢弃（`undefined` 在 JSON 里本来也会消失）。
 */
export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (value === null) return null
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'object') return undefined
  if (depth >= MAX_METADATA_DEPTH) return '[过深]'

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeMetadata(item, depth + 1))
    return items.filter((item) => item !== undefined)
  }

  const result: Record<string, unknown> = {}
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [key, item] of entries.slice(0, MAX_METADATA_KEYS)) {
    if (isSecretKey(key)) {
      result[key] = REDACTED
      continue
    }
    const sanitized = sanitizeMetadata(item, depth + 1)
    if (sanitized !== undefined) result[key] = sanitized
  }
  return result
}

/**
 * 把元数据整理成可落库的 JSON 文本。
 *
 * 序列化失败（循环引用等）时不抛错：审计记录必须能写下去，退化成只留一句说明。
 */
export function metadataJsonOf(metadata: Readonly<Record<string, unknown>> | undefined): string {
  if (metadata === undefined) return '{}'
  try {
    const sanitized = sanitizeMetadata(metadata)
    if (sanitized === null || typeof sanitized !== 'object') return '{}'
    return JSON.stringify(sanitized)
  } catch {
    return JSON.stringify({ note: '元数据无法序列化，已省略' })
  }
}
