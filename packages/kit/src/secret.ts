/**
 * 秘密的生成、哈希、掩码与常量时间比较。
 *
 * 放在 kit（共用底座）而不是某个插件里：API key、兑换码这类「一次性明文 + 只落哈希」
 * 的做法是同一个模式，插件之间不该互相 import 实现包（AGENTS.md §2.2）。
 *
 * 这里的 sha256 **不是口令哈希**：输入是 128 位以上的随机串，没有低熵口令可爆破，
 * 它只承担「查表键 + 恒定时间比对」两件事。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * 生成 `bytes` 字节随机数的无填充 base64url。
 *
 * 默认 32 字节 = 256 位熵，43 个字符，适合出现在 URL / 头里也不被转义。
 */
export function generateSecret(bytes = 32): string {
  if (!Number.isSafeInteger(bytes) || bytes < 16) {
    throw new Error('generateSecret 至少需要 16 字节随机数')
  }
  return randomBytes(bytes).toString('base64url')
}

/** 明文 → sha256 小写 hex（64 字符）。 */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * 两个 sha256 hex 的常量时间比较。
 *
 * 形状不对直接返回 false（不进入 timingSafeEqual，否则长度不等会抛错）；
 * 查不到记录时调用方应传一串 0 参与比较，让「是否存在」在耗时上不出现明显差异。
 */
export function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/**
 * 掩码：保留末 `visible` 位，其余一律 `****`。
 *
 * 例：`maskSecret('ABCDEFGH')` → `****EFGH`。短串也不会泄露超过末 4 位。
 */
export function maskSecret(value: string, visible = 4): string {
  if (typeof value !== 'string' || value === '') return '****'
  const keep = Math.max(0, Math.min(visible, value.length))
  return `****${value.slice(value.length - keep)}`
}
