import { jsonFileStore, memoryStore, type JsonCodec, type JsonStore } from '@dizzyapi/plugin-kit'
import { CredentialsError } from './errors.ts'
import { isRef } from './ref.ts'

/**
 * 凭据文件。
 *
 * ```
 * { "version": 1,
 *   "entries": { "dizzyapi/smtp-163": { "value": "…", "createdAt": "…", "updatedAt": "…" } } }
 * ```
 *
 * 这个文件里全是明文秘密，所以**权限位给 0600**（Windows 忽略），且它是
 * gitignored 的——秘密不该进版本库（那正是它存在的理由）。
 */
export interface CredentialRecord {
  readonly value: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface CredentialsSnapshot {
  readonly entries: Readonly<Record<string, CredentialRecord>>
}

export const SNAPSHOT_VERSION = 1

export function emptySnapshot(): CredentialsSnapshot {
  return { entries: {} }
}

interface WireRecord {
  value: string
  createdAt: string
  updatedAt: string
}

interface WireSnapshot {
  version: number
  entries: Record<string, WireRecord>
}

/**
 * 解码是严格的：版本不认识、形状不对、引用名不合法都直接抛。
 *
 * 「尽力恢复」在这里尤其危险——一个被悄悄丢掉的秘密，表现是某个渠道
 * 半死不活地跑着，而不是启动失败；读不出来才是对的行为。
 */
export const credentialsCodec: JsonCodec<CredentialsSnapshot> = {
  encode(value) {
    const wire: WireSnapshot = { version: SNAPSHOT_VERSION, entries: {} }
    for (const [ref, record] of Object.entries(value.entries)) {
      wire.entries[ref] = { value: record.value, createdAt: record.createdAt, updatedAt: record.updatedAt }
    }
    return wire
  },

  decode(raw) {
    const wire = requireObject(raw, '根对象')
    if (wire.version !== SNAPSHOT_VERSION) {
      throw corrupt(`版本不受支持：${String(wire.version)}（本插件只认 ${SNAPSHOT_VERSION}）`)
    }
    const rawEntries = requireObject(wire.entries, 'entries')

    const entries: Record<string, CredentialRecord> = {}
    for (const [ref, value] of Object.entries(rawEntries)) {
      if (!isRef(ref)) throw corrupt(`entries 里有非法的凭据引用名：${ref}`)
      const record = requireObject(value, `entries[${ref}]`)
      if (typeof record.value !== 'string' || record.value === '') {
        throw corrupt(`entries[${ref}].value 必须是非空字符串`)
      }
      if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') {
        throw corrupt(`entries[${ref}] 的时间戳必须是字符串`)
      }
      entries[ref] = { value: record.value, createdAt: record.createdAt, updatedAt: record.updatedAt }
    }
    return { entries }
  },
}

/** 省略路径即纯内存，进程退出即丢。 */
export function createCredentialsStore(dataPath: string | undefined): JsonStore<CredentialsSnapshot> {
  if (dataPath === undefined) return memoryStore(emptySnapshot)

  const inner = jsonFileStore(dataPath, credentialsCodec, emptySnapshot, { mode: 0o600 })
  return {
    ...inner,
    /**
     * kit 的 jsonFileStore 先把文件解析成 JSON 再交给 codec，所以「文件根本不是 JSON」
     * 会在到达 codec 之前抛 SyntaxError。那属于文件损坏，折回 CREDENTIALS_STORE_CORRUPT。
     */
    async read() {
      try {
        return await inner.read()
      } catch (error) {
        if (error instanceof SyntaxError) throw corrupt(`不是合法 JSON（${error.message}）`)
        throw error
      }
    },
  }
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw corrupt(`${where} 不是对象`)
  }
  return value as Record<string, unknown>
}

function corrupt(detail: string): CredentialsError {
  return new CredentialsError('CREDENTIALS_STORE_CORRUPT', `凭据文件损坏：${detail}`)
}
