/**
 * 档案的持久化（整份 JSON，原子写，复用 kit）。
 *
 * 一条纪律：**读到的数据不合法就整份拒绝**（`decode` 抛错），不做「跳过坏的那条」——
 * 静默丢一条档案的后果是某个账号悄悄变回「不伪装」，而页面上看起来一切正常。
 *
 * 另一条：`builtin` **不信文件里的值**，一律由 id 是否属于预置清单决定。
 * 否则有人（或一次手滑的编辑）能把自定义档案标成 `builtin`，管理页就会给它
 * 「内置」的待遇（比如不给删除），身份就乱了。
 */
import { jsonFileStore, memoryStore, type JsonCodec, type JsonStore } from '@dizzyapi/plugin-kit'

import { ClientMaskError } from './errors.ts'
import { isPresetId, presetProfiles } from './presets.ts'
import { validateHeaderName, validateHeaderValue, validateProfileId, validateUserAgent } from './template.ts'
import type { ClientHeader, ClientProfile } from './types.ts'

/** 文件格式版本（将来迁移用；今天只有 1）。 */
export const CLIENT_MASK_STORE_VERSION = 1

export interface ClientMaskSnapshot {
  readonly version: number
  readonly profiles: readonly ClientProfile[]
}

function invalid(message: string): never {
  throw new ClientMaskError('CLIENT_MASK_INPUT_INVALID', `客户端档案数据不合法：${message}`)
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${what} 必须是对象`)
  return value as Record<string, unknown>
}

function readHeaders(raw: unknown, id: string): ClientHeader[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) invalid(`档案 ${id} 的 headers 必须是数组`)
  return raw.map((item) => {
    const record = asRecord(item, `档案 ${id} 的头`)
    const name = record.name
    const value = record.value
    if (typeof name !== 'string' || typeof value !== 'string') invalid(`档案 ${id} 的头必须有 name / value 字符串`)
    const nameError = validateHeaderName(name)
    if (nameError !== null) invalid(`档案 ${id}：${nameError}`)
    const valueError = validateHeaderValue(value)
    if (valueError !== null) invalid(`档案 ${id}：${valueError}`)
    return { name, value }
  })
}

function readProfile(raw: unknown): ClientProfile {
  const record = asRecord(raw, '档案')
  const id = record.id
  if (typeof id !== 'string') invalid('档案缺 id')
  const idError = validateProfileId(id)
  if (idError !== null) invalid(idError)

  const label = typeof record.label === 'string' && record.label.trim() !== '' ? record.label : id
  const description = typeof record.description === 'string' ? record.description : null
  const enabled = record.enabled !== false
  const userAgent = typeof record.userAgent === 'string' && record.userAgent !== '' ? record.userAgent : null
  if (userAgent !== null) {
    const uaError = validateUserAgent(userAgent)
    if (uaError !== null) invalid(`档案 ${id}：${uaError}`)
  }

  return {
    id,
    label,
    description,
    enabled,
    userAgent,
    headers: readHeaders(record.headers, id),
    // 不信文件里的 builtin：内置身份只由 id 决定。
    builtin: isPresetId(id),
  }
}

export const clientMaskCodec: JsonCodec<ClientMaskSnapshot> = {
  encode(value) {
    return {
      version: value.version,
      profiles: value.profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        description: profile.description,
        enabled: profile.enabled,
        userAgent: profile.userAgent,
        headers: profile.headers.map((header) => ({ name: header.name, value: header.value })),
      })),
    }
  },
  decode(raw) {
    const record = asRecord(raw, '档案文件')
    const profiles = record.profiles
    if (!Array.isArray(profiles)) invalid('profiles 必须是数组')
    const seen = new Set<string>()
    const parsed = profiles.map((item) => {
      const profile = readProfile(item)
      if (seen.has(profile.id)) invalid(`档案 id 重复：${profile.id}`)
      seen.add(profile.id)
      return profile
    })
    return { version: CLIENT_MASK_STORE_VERSION, profiles: parsed }
  },
}

/**
 * 把「文件里的档案」与「内置预置」合并。
 *
 * 规则（升级与手工编辑都要能活）：
 * 1. 文件里有的**以文件为准**（管理员改过的 UA / 头都算数）；
 * 2. 文件里缺的预置**补回来**（新版本加了预置，老文件不该看不见它）；
 * 3. 顺序：先按预置清单排，再按文件里自定义的顺序排在后面。
 */
export function mergeProfiles(stored: readonly ClientProfile[]): ClientProfile[] {
  const byId = new Map(stored.map((profile) => [profile.id, profile]))
  const merged: ClientProfile[] = presetProfiles().map((preset) => {
    const saved = byId.get(preset.id)
    if (saved === undefined) return preset
    return { ...saved, builtin: true }
  })
  for (const profile of stored) {
    if (!isPresetId(profile.id)) merged.push({ ...profile, builtin: false })
  }
  return merged
}

/** 文件存储；`path` 为空时退化成内存存储（测试 / 无持久化场景）。 */
export function createClientMaskStore(path: string | undefined): JsonStore<ClientMaskSnapshot> {
  const empty = (): ClientMaskSnapshot => ({ version: CLIENT_MASK_STORE_VERSION, profiles: [] })
  if (path === undefined || path === '') return memoryStore(empty)
  return jsonFileStore(path, clientMaskCodec, empty)
}
