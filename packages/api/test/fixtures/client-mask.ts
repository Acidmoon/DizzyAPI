/**
 * 客户端指纹档案的假端口（`clientMask`）。
 *
 * 只实现路由用到的读面三件套与写面四个方法；**语义校验不在这里**
 * （受保护头 / 占位符 / 头值安全都在真插件里，路由只做形状校验），
 * 用例要断的是「路由有没有把该拒的拒掉、该记的记上」。
 */
import type {
  ClientHeaderLike,
  ClientMaskPort,
  ClientMaskStatusLike,
  ClientProfileLike,
} from '../../src/types-client-mask.ts'
import { DomainError } from './support.ts'

function profileOf(input: {
  id: string
  label: string
  headers: ClientHeaderLike[]
  builtin: boolean
  enabled?: boolean
  userAgent?: string | null
  description?: string | null
}): ClientProfileLike {
  return {
    id: input.id,
    label: input.label,
    description: input.description ?? null,
    enabled: input.enabled !== false,
    userAgent: input.userAgent ?? null,
    headers: input.headers,
    builtin: input.builtin,
  }
}

export class FakeClientMask implements ClientMaskPort {
  readonly profiles: ClientProfileLike[] = [
    profileOf({
      id: 'opencode',
      label: 'opencode',
      headers: [{ name: 'x-opencode-session', value: '{{session}}' }],
      builtin: true,
    }),
    profileOf({
      id: 'codex',
      label: 'codex',
      headers: [{ name: 'x-codex-session', value: '{{uuid}}' }],
      builtin: true,
      enabled: false,
    }),
    profileOf({
      id: 'my-browser',
      label: '我的浏览器',
      headers: [{ name: 'x-client', value: 'browser' }],
      builtin: false,
    }),
  ]
  readonly calls: { method: string; args: unknown[] }[] = []

  list(): readonly ClientProfileLike[] {
    this.calls.push({ method: 'list', args: [] })
    return this.profiles.map((item) => ({ ...item, headers: [...item.headers] }))
  }

  get(id: string): ClientProfileLike | undefined {
    this.calls.push({ method: 'get', args: [id] })
    const found = this.profiles.find((item) => item.id === id)
    return found === undefined ? undefined : { ...found, headers: [...found.headers] }
  }

  status(): ClientMaskStatusLike {
    this.calls.push({ method: 'status', args: [] })
    const builtin = this.profiles.filter((item) => item.builtin).length
    return {
      enabled: true,
      profiles: this.profiles.length,
      enabledProfiles: this.profiles.filter((item) => item.enabled).length,
      builtin,
      custom: this.profiles.length - builtin,
      storage: 'memory',
    }
  }

  async upsert(actor: string, input: unknown): Promise<unknown> {
    this.calls.push({ method: 'upsert', args: [actor, input] })
    const record = input as { id?: unknown; label?: unknown; headers?: unknown }
    if (typeof record.id !== 'string' || record.id === '') {
      throw new DomainError('CLIENT_MASK_INPUT_INVALID', 'id 不能为空')
    }
    const existing = this.profiles.find((item) => item.id === record.id)
    const next = profileOf({
      id: record.id,
      label: typeof record.label === 'string' ? record.label : record.id,
      headers: Array.isArray(record.headers) ? (record.headers as ClientHeaderLike[]) : [],
      builtin: existing?.builtin ?? false,
    })
    const index = this.profiles.findIndex((item) => item.id === next.id)
    if (index < 0) this.profiles.push(next)
    else this.profiles[index] = next
    return next
  }

  async update(actor: string, id: string, patch: unknown): Promise<unknown> {
    this.calls.push({ method: 'update', args: [actor, id, patch] })
    const index = this.profiles.findIndex((item) => item.id === id)
    if (index < 0) throw new DomainError('CLIENT_MASK_PROFILE_UNKNOWN', '没有这个客户端档案')
    const record = patch as Record<string, unknown>
    const current = this.profiles[index]!
    const next: ClientProfileLike = {
      ...current,
      label: typeof record.label === 'string' ? record.label : current.label,
      enabled: typeof record.enabled === 'boolean' ? record.enabled : current.enabled,
      userAgent:
        record.userAgent === null
          ? null
          : typeof record.userAgent === 'string'
            ? record.userAgent
            : current.userAgent,
      headers: Array.isArray(record.headers) ? (record.headers as ClientHeaderLike[]) : current.headers,
    }
    this.profiles[index] = next
    return next
  }

  async remove(actor: string, id: string): Promise<unknown> {
    this.calls.push({ method: 'remove', args: [actor, id] })
    const found = this.profiles.find((item) => item.id === id)
    if (found === undefined) throw new DomainError('CLIENT_MASK_PROFILE_UNKNOWN', '没有这个客户端档案')
    if (found.builtin) {
      throw new DomainError('CLIENT_MASK_INPUT_INVALID', `档案 ${id} 是内置预置：不能删除`)
    }
    const index = this.profiles.findIndex((item) => item.id === id)
    this.profiles.splice(index, 1)
    return { removed: true }
  }

  async reset(actor: string, id: string): Promise<unknown> {
    this.calls.push({ method: 'reset', args: [actor, id] })
    const index = this.profiles.findIndex((item) => item.id === id)
    if (index < 0 || this.profiles[index]?.builtin !== true) {
      throw new DomainError('CLIENT_MASK_PROFILE_UNKNOWN', `没有 ${id} 这个内置预置`)
    }
    const preset = profileOf({
      id,
      label: id,
      headers: [{ name: 'x-opencode-session', value: '{{session}}' }],
      builtin: true,
    })
    this.profiles[index] = preset
    return preset
  }
}
