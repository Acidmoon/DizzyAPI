/**
 * 客户端指纹档案（服务名 `clientMask`）—— 档案的**唯一写者**。
 *
 * ## 它解决什么
 *
 * 有的上游按「客户端指纹」判定来源：不带 `x-opencode-session` 会被回
 * `HTTP 400: Request is missing x-opencode-session and cannot be routed efficiently`
 * （owner 2026-11-01 实测）。我们发的是裸 HTTP，官方客户端带的那组头一个都没有。
 *
 * ## 边界（一条都不能越）
 *
 * - **只存「头名 + 头值模板」**，不存秘密、不存令牌、不碰 `credentials`；
 * - **它不注入请求**：真正套用发生在 Go 的 `modules/transport`（TS 侧不知道请求体，
 *   也就没法算 `{{session}}`）。本插件只负责「档案长什么样」；
 * - **只读消费方是 `account-priority`**：它把「账号挂的档案」解析成一小段头，随账号快照推给 Go；
 * - 档案可禁用：禁用后账号挂它等于「不伪装」，但档案本身不丢。
 */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Service, type Context, type Logger } from 'cordis'
import { describeError, isIssueList, type JsonStore } from '@dizzyapi/plugin-kit'

import {
  CLIENT_MASK_CONFIG_SCHEMA,
  resolveClientMaskConfig,
  type ClientMaskConfig,
  type ResolvedClientMaskConfig,
} from './config.ts'
import { ClientMaskError } from './errors.ts'
import { isPresetId, presetProfile } from './presets.ts'
import { createClientMaskStore, mergeProfiles, type ClientMaskSnapshot } from './store.ts'
import {
  MAX_HEADERS_PER_PROFILE,
  validateHeaderName,
  validateHeaderValue,
  validateProfileId,
  validateUserAgent,
} from './template.ts'
import type {
  ClientHeader,
  ClientMaskStatus,
  ClientProfile,
  ClientProfilePatch,
  ResolvedClientMask,
} from './types.ts'

/** 新建 / 全量替换一个档案的入参。 */
export interface ClientProfileInput {
  readonly id: string
  readonly label?: string
  readonly description?: string | null
  readonly enabled?: boolean
  readonly userAgent?: string | null
  readonly headers?: readonly ClientHeader[]
}

export class ClientMaskService extends Service {
  static Config = CLIENT_MASK_CONFIG_SCHEMA

  static catalog = {
    capabilities: ['client-mask-profiles'],
    events: [{ name: 'client-mask/updated', description: '某个客户端档案被改动', payload: 'id: string' }],
    bridge: [],
    storage: [{ key: 'dataPath', kind: 'file', description: '客户端指纹档案 JSON' }],
  } as const

  readonly config: ResolvedClientMaskConfig
  private readonly logger: Logger
  private readonly adminPlugins: readonly string[]
  private readonly store: JsonStore<ClientMaskSnapshot>
  private profiles: readonly ClientProfile[] = []
  private ready = false
  private disposed = false
  /** 落盘串行化：两次并发保存不许互相覆盖。 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: ClientMaskConfig | ResolvedClientMaskConfig = {}) {
    super(ctx, 'clientMask')
    const resolved = resolveClientMaskConfig(config)
    if (isIssueList(resolved)) {
      throw new ClientMaskError(
        'CLIENT_MASK_CONFIG_INVALID',
        `客户端指纹插件配置不合法：${resolved.map((item) => item.message).join('；')}`,
      )
    }
    this.config = resolved
    this.adminPlugins = resolved.adminPlugins
    this.logger = ctx.logger('client-mask')
    this.store = createClientMaskStore(resolveDataPath(ctx, resolved.dataPath))
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    this.profiles = mergeProfiles((await this.store.read()).profiles)
    this.ready = true
    this.ctx.effect(() => () => this.close(), 'client-mask.store')
    // 装载即回写一次：新版本新增的预置会立刻出现在文件里（人可读、可编辑）。
    // 写失败不影响装载（档案仍在内存里可用），只记一条警告。
    try {
      await this.persist()
    } catch (error) {
      this.logger.warn(`写入客户端档案失败（内存里仍然可用）：${describeError(error)}`)
    }
    this.logger.info(
      `客户端指纹档案已装载：${String(this.profiles.length)} 个（${describe(this.profiles)}）；`
        + `伪装总闸 ${this.config.enabled ? '开' : '关'}`,
    )
    yield () => {
      this.disposed = true
    }
  }

  // ───────────────────────────────── 读面

  /** 全部档案（含被禁用的）。返回副本，调用方改不到内部状态。 */
  list(): readonly ClientProfile[] {
    return this.profiles.map((profile) => cloneProfile(profile))
  }

  /** 一个档案；未知 id 返回 `undefined`（**不抛**：调用方常常是「账号挂了个已删档案」）。 */
  get(id: string): ClientProfile | undefined {
    const found = this.profiles.find((profile) => profile.id === id)
    return found === undefined ? undefined : cloneProfile(found)
  }

  /**
   * 把一个账号挂的档案解析成「要推到 Go 的那一小段」。
   *
   * 返回 `undefined` 的四种情况，页面都要能解释：总闸关了 / 没挂档案 / 档案不存在
   * （被删了）/ 档案被禁用。**都不抛错** —— 账号快照推送不能因为一条坏引用整份失败。
   */
  resolve(id: string | null | undefined): ResolvedClientMask | undefined {
    if (!this.config.enabled) return undefined
    if (id === null || id === undefined || id === '') return undefined
    const profile = this.profiles.find((item) => item.id === id)
    if (profile === undefined || !profile.enabled) return undefined
    return {
      profileId: profile.id,
      userAgent: profile.userAgent,
      headers: profile.headers.map((header) => ({ ...header })),
    }
  }

  status(): ClientMaskStatus {
    const enabledProfiles = this.profiles.filter((profile) => profile.enabled).length
    const builtin = this.profiles.filter((profile) => profile.builtin).length
    return {
      enabled: this.config.enabled,
      profiles: this.profiles.length,
      enabledProfiles,
      builtin,
      custom: this.profiles.length - builtin,
      storage: this.store.describe,
    }
  }

  // ───────────────────────────────── 写面（只对白名单开放）

  /** 新建或全量替换一个档案。内置预置允许改（`reset` 能还原），但 id 不可改。 */
  async upsert(actor: string, input: ClientProfileInput): Promise<ClientProfile> {
    this.assertReady()
    this.assertActor(actor)
    const idError = validateProfileId(input.id)
    if (idError !== null) throw new ClientMaskError('CLIENT_MASK_INPUT_INVALID', idError)
    const next = this.buildProfile(input, this.profiles.find((item) => item.id === input.id))
    return this.commit(next, next.builtin ? `改档案 ${next.id}` : `新建档案 ${next.id}`)
  }

  /** 只改几个键。`null` 表示清空（`description` / `userAgent` 可清成 `null`）。 */
  async update(actor: string, id: string, patch: ClientProfilePatch): Promise<ClientProfile> {
    this.assertReady()
    this.assertActor(actor)
    const existing = this.mustGet(id)
    const merged: ClientProfileInput = {
      id: existing.id,
      label: patch.label ?? existing.label,
      description: patch.description === undefined ? existing.description : patch.description,
      enabled: patch.enabled ?? existing.enabled,
      userAgent: patch.userAgent === undefined ? existing.userAgent : patch.userAgent,
      headers: patch.headers ?? existing.headers,
    }
    const next = this.buildProfile(merged, existing)
    return this.commit(next, `改档案 ${next.id}`)
  }

  /** 删除一个**自定义**档案。内置预置不许删（只能停用或改），否则升级会复活它、语义混乱。 */
  async remove(actor: string, id: string): Promise<{ readonly removed: boolean }> {
    this.assertReady()
    this.assertActor(actor)
    const existing = this.mustGet(id)
    if (existing.builtin) {
      throw new ClientMaskError(
        'CLIENT_MASK_INPUT_INVALID',
        `档案 ${id} 是内置预置：不能删除，只能停用或改；要恢复默认用 reset`,
      )
    }
    this.profiles = this.profiles.filter((profile) => profile.id !== id)
    await this.enqueuePersist()
    this.ctx.emit('client-mask/updated', id)
    return { removed: true }
  }

  /** 把内置预置恢复成出厂值（改坏了用这个；自定义档案不支持 reset）。 */
  async reset(actor: string, id: string): Promise<ClientProfile> {
    this.assertReady()
    this.assertActor(actor)
    const preset = presetProfile(id)
    if (preset === undefined) {
      throw new ClientMaskError('CLIENT_MASK_PROFILE_UNKNOWN', `没有 ${id} 这个内置预置`)
    }
    this.profiles = this.profiles.map((profile) => (profile.id === id ? preset : profile))
    await this.enqueuePersist()
    this.ctx.emit('client-mask/updated', id)
    return cloneProfile(preset)
  }

  // ───────────────────────────────── 内部

  /** 校验入参并拼出完整档案（`builtin` 只由 id 决定，不接受调用方声明）。 */
  private buildProfile(input: ClientProfileInput, existing: ClientProfile | undefined): ClientProfile {
    const label = (input.label ?? existing?.label ?? input.id).trim()
    if (label === '') throw new ClientMaskError('CLIENT_MASK_INPUT_INVALID', '档案名不能为空')

    const userAgent = input.userAgent === undefined ? (existing?.userAgent ?? null) : input.userAgent
    if (userAgent !== null) {
      const uaError = validateUserAgent(userAgent)
      if (uaError !== null) throw new ClientMaskError('CLIENT_MASK_INPUT_INVALID', uaError)
    }

    const rawHeaders = input.headers ?? existing?.headers ?? []
    if (!Array.isArray(rawHeaders)) {
      throw new ClientMaskError('CLIENT_MASK_INPUT_INVALID', 'headers 必须是数组')
    }
    if (rawHeaders.length > MAX_HEADERS_PER_PROFILE) {
      throw new ClientMaskError(
        'CLIENT_MASK_INPUT_INVALID',
        `一个档案最多 ${String(MAX_HEADERS_PER_PROFILE)} 个头（当前 ${String(rawHeaders.length)} 个）`,
      )
    }
    const seen = new Set<string>()
    const headers: ClientHeader[] = rawHeaders.map((header) => {
      const nameError = validateHeaderName(header.name)
      if (nameError !== null) throw new ClientMaskError('CLIENT_MASK_INPUT_INVALID', nameError)
      const valueError = validateHeaderValue(header.value)
      if (valueError !== null) throw new ClientMaskError('CLIENT_MASK_INPUT_INVALID', valueError)
      const lower = header.name.toLowerCase()
      if (seen.has(lower)) {
        throw new ClientMaskError('CLIENT_MASK_INPUT_INVALID', `头 ${header.name} 重复声明了两次`)
      }
      seen.add(lower)
      return { name: header.name, value: header.value }
    })

    return {
      id: input.id,
      label,
      description: input.description === undefined ? (existing?.description ?? null) : input.description,
      enabled: input.enabled ?? existing?.enabled ?? true,
      userAgent,
      headers,
      builtin: isPresetId(input.id),
    }
  }

  private async commit(next: ClientProfile, what: string): Promise<ClientProfile> {
    const others = this.profiles.filter((profile) => profile.id !== next.id)
    this.profiles = mergeOrder([...others, next])
    this.logger.info(`${what}：${next.label}（${String(next.headers.length)} 个头）`)
    // 写面不返回「未落盘的假成功」：await 到真的写完，写失败就抛给调用方。
    await this.enqueuePersist()
    this.ctx.emit('client-mask/updated', next.id)
    return cloneProfile(next)
  }

  /** 落盘串行化：两次并发保存按到达顺序写，不互相覆盖。 */
  private enqueuePersist(): Promise<void> {
    const task = this.queue.then(() => this.persist())
    this.queue = task.catch(() => undefined)
    return task
  }

  private async persist(): Promise<void> {
    await this.store.write({ version: 1, profiles: this.profiles })
  }

  private mustGet(id: string): ClientProfile {
    const found = this.profiles.find((profile) => profile.id === id)
    if (found === undefined) throw new ClientMaskError('CLIENT_MASK_PROFILE_UNKNOWN', `没有 ${id} 这个档案`)
    return found
  }

  private assertActor(actor: string): void {
    const name = actor.trim()
    if (!this.adminPlugins.includes(name)) {
      throw new ClientMaskError(
        'CLIENT_MASK_ACTOR_FORBIDDEN',
        `插件 ${name === '' ? '（空）' : name} 未被授权改客户端档案（当前授权：${this.adminPlugins.join(' / ') || '无'}）`,
      )
    }
  }

  private assertReady(): void {
    if (!this.ready || this.disposed) {
      throw new ClientMaskError('CLIENT_MASK_NOT_READY', '客户端指纹插件尚未就绪')
    }
  }

  private close(): void {
    this.disposed = true
    void this.store.close().catch(() => undefined)
  }
}

/** 预置在前、自定义在后（与 `mergeProfiles` 同一口径，改动后也不乱序）。 */
function mergeOrder(profiles: readonly ClientProfile[]): ClientProfile[] {
  const presets = profiles.filter((profile) => profile.builtin)
  const custom = profiles.filter((profile) => !profile.builtin)
  return [...presets, ...custom]
}

function cloneProfile(profile: ClientProfile): ClientProfile {
  return { ...profile, headers: profile.headers.map((header) => ({ ...header })) }
}

function describe(profiles: readonly ClientProfile[]): string {
  const enabled = profiles.filter((profile) => profile.enabled).length
  return `启用 ${String(enabled)} / 停用 ${String(profiles.length - enabled)}`
}

function resolveDataPath(ctx: Context, path: string): string {
  if (path === '' || isAbsolute(path)) return path
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}
