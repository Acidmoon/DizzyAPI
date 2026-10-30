/**
 * API key 夹具（secret 只在 create / rotate 返回值里出现）。
 *
 * 从 `test/fixtures.ts` 按域拆出（§5.6：测试文件 500 行上限）。行为逐字未改。
 */
import type {
  ApiKeyPort,
} from '../../src/types.ts'
import { DomainError } from './support.ts'

export class FakeApiKey implements ApiKeyPort {
  readonly items = new Map<string, Record<string, unknown>>()
  readonly calls: { method: string; args: unknown[] }[] = []
  private sequence = 1

  constructor() {
    this.items.set('key_1', {
      id: 'key_1',
      name: 'ci',
      trackingId: 'trk-1',
      secret: 'sk-dizzy-secret-initial',
      maskedKey: 'sk-dizzy-****0001',
      createdAt: '2026-10-01T00:00:00.000Z',
      lastUsedAt: null,
      appManaged: false,
      enabled: true,
    })
  }

  async list(userId: number): Promise<unknown> {
    this.calls.push({ method: 'list', args: [userId] })
    return [...this.items.values()]
  }

  async count(): Promise<number> {
    this.calls.push({ method: 'count', args: [] })
    return this.items.size
  }

  async listAll(): Promise<unknown> {
    this.calls.push({ method: 'listAll', args: [] })
    return [...this.items.values()].map((item) => ({ ...item, secret: null }))
  }

  async create(userId: number, input: { name: string }): Promise<unknown> {
    this.calls.push({ method: 'create', args: [userId, input] })
    const id = `key_${++this.sequence}`
    const item = {
      id,
      name: input.name,
      trackingId: `trk-${this.sequence}`,
      secret: `sk-dizzy-secret-${this.sequence}`,
      maskedKey: `sk-dizzy-****000${this.sequence}`,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      appManaged: false,
      enabled: true,
    }
    this.items.set(id, item)
    // 真实 apiKey 服务返回 `{ key, secret }`；HTTP 层负责展开。
    return { key: item, secret: `sk-dizzy-secret-${this.sequence}` }
  }

  async update(userId: number, id: string, patch: { name?: string; enabled?: boolean }): Promise<unknown> {
    this.calls.push({ method: 'update', args: [userId, id, patch] })
    const item = this.items.get(id)
    if (item === undefined) throw new DomainError('KEY_NOT_FOUND', '没有这个 key')
    Object.assign(item, patch)
    return item
  }

  async remove(userId: number, id: string): Promise<unknown> {
    this.calls.push({ method: 'remove', args: [userId, id] })
    this.items.delete(id)
    return { removed: true }
  }

  async rotate(userId: number, id: string): Promise<unknown> {
    this.calls.push({ method: 'rotate', args: [userId, id] })
    const item = this.items.get(id)
    if (item === undefined) throw new DomainError('KEY_NOT_FOUND', '没有这个 key')
    item.maskedKey = `sk-dizzy-****rot${this.sequence}`
    item.secret = `sk-dizzy-rotated-${this.sequence}`
    return { key: item, secret: `sk-dizzy-rotated-${this.sequence}` }
  }
}
