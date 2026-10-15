import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/**
 * 密码与令牌的密码学原语，全部来自 node:crypto，不引第三方库。
 *
 * 三条纪律：
 * 1. 密码只存 scrypt 派生值 + 每用户随机盐，参数随哈希一起写进字符串，便于将来升级。
 * 2. 验证码与会话令牌都只存哈希：存储文件泄漏不等于会话被拿走。
 * 3. 比较一律用 timingSafeEqual，不用 `===`（避免计时侧信道）。
 */

const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64
const PREFIX = 'scrypt'

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return [
    PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$')
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== PREFIX) return false

  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false

  const salt = Buffer.from(parts[4], 'base64')
  const expected = Buffer.from(parts[5], 'base64')
  if (salt.length === 0 || expected.length === 0) return false

  const derived = await derive(password, salt, expected.length, { N: n, r, p })
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/**
 * 邮箱不存在时也走一次等价的 scrypt，避免用响应时间区分「邮箱不存在」与「密码错误」。
 * 结果固定在构造时算一次。
 */
let dummyHash: Promise<string> | undefined
export async function consumeDummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword('dizzyapi-dummy-verify-target')
  await verifyPassword(await dummyHash, password)
}

/** 十进制验证码，位数可配；用 randomInt 而不是 Math.random（无偏、可预测性低）。 */
export function randomCode(digits: number): string {
  const max = 10 ** digits
  return String(randomInt(0, max)).padStart(digits, '0')
}

export function randomSalt(): string {
  return randomBytes(16).toString('hex')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** 会话令牌与 id：令牌给客户端，id 用于在会话列表里指认（不敏感）。 */
export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

export function randomSessionId(): string {
  return randomBytes(8).toString('hex')
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

function derive(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error)
      else resolve(derivedKey)
    })
  })
}
