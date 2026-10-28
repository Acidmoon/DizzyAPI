/**
 * 兑换码的生成、规范化、哈希与掩码。
 *
 * **生成与兑换必须走同一个规范化函数**（`normalizeCode`）：用户输入的分隔符与大小写
 * 不该影响能否兑换；规范化之后再算哈希，落库的 `code_hash` 是规范化明文的 sha256。
 *
 * 明文只在这里与 `createBatch` 的返回值里存在；本文件之外没有任何地方保留它。
 */
import { randomBytes } from 'node:crypto'
import { hashSecret, maskSecret } from '@dizzyapi/plugin-kit'
import { RedeemError } from './errors.ts'
import {
  REDEEM_CODE_ALPHABET,
  REDEEM_CODE_GROUP,
  REDEEM_CODE_LENGTH,
} from './types.ts'

/** 规范化之后的码形状：24 位 Crockford base32（无 I / L / O / U）。 */
const CODE_PATTERN = new RegExp(`^[0-9A-HJKMNP-TV-Z]{${REDEEM_CODE_LENGTH}}$`)

/** 生成 24 位码（120 位熵）。256 % 32 === 0，取模不引入偏差。 */
export function generateCode(): string {
  const bytes = randomBytes(REDEEM_CODE_LENGTH)
  let out = ''
  for (let index = 0; index < REDEEM_CODE_LENGTH; index += 1) {
    out += REDEEM_CODE_ALPHABET[bytes[index]! % REDEEM_CODE_ALPHABET.length]
  }
  return out
}

/**
 * 规范化用户输入的码：trim → 去掉分隔符（`-` 与所有空白）→ 转大写。
 *
 * 非法输入只回稳定 code，不回显输入本身（避免把输入反射进错误信息）。
 */
export function normalizeCode(value: unknown): string {
  if (typeof value !== 'string') {
    throw new RedeemError('REDEEM_CODE_INVALID', '兑换码格式不正确')
  }
  const normalized = value.replace(/[\s-]+/g, '').toUpperCase()
  if (!CODE_PATTERN.test(normalized)) {
    throw new RedeemError('REDEEM_CODE_INVALID', '兑换码格式不正确')
  }
  return normalized
}

/** 展示用的分组形式：`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`。 */
export function formatCodeForDisplay(code: string): string {
  const groups: string[] = []
  for (let index = 0; index < code.length; index += REDEEM_CODE_GROUP) {
    groups.push(code.slice(index, index + REDEEM_CODE_GROUP))
  }
  return groups.join('-')
}

/** 规范化明文的 sha256 hex（查表键；比对时再走常量时间比较）。 */
export function codeDigest(code: string): string {
  return hashSecret(code)
}

/** 掩码：末 4 位，例如 `****A3F7`。列表、日志、余额流水里只允许出现它。 */
export function codeMask(code: string): string {
  return maskSecret(code, 4)
}
