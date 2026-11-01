/**
 * 上游账号管理门面夹具。
 *
 * 从 `test/fixtures.ts` 按域拆出（§5.6：测试文件 500 行上限）。行为逐字未改。
 */
import type {
  AccountAdminPort,
  AccountViewLike,
} from '../../src/types.ts'
import { DomainError } from './support.ts'

export class FakeAccountAdmin implements AccountAdminPort {
  readonly accounts: AccountViewLike[] = [
    {
      id: 'acc_1',
      provider: 'openai',
      kind: 'api_key',
      label: 'primary',
      enabled: true,
      status: 'active',
      email: 'up@example.com',
      subject: 'org-1',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-chat',
      models: ['gpt-5', 'gpt-5-codex'],
      modelMap: { 'gpt-5-codex': 'gpt-5-codex-2025-01-01' },
      priority: 5,
      accessExpiresAt: null,
      refreshDueAt: null,
      lastRefreshAt: null,
      lastError: null,
      failureCount: 0,
      backoffUntil: null,
      lastTestAt: null,
      lastTestOk: null,
      lastTestError: null,
      lastTestLatencyMs: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
    {
      id: 'acc_2',
      provider: 'claude',
      kind: 'oauth',
      label: 'backup',
      enabled: false,
      status: 'needs_reauth',
      email: null,
      subject: null,
      baseUrl: null,
      protocol: null,
      models: null,
      modelMap: null,
      priority: 0,
      accessExpiresAt: null,
      refreshDueAt: null,
      lastRefreshAt: null,
      lastError: 'invalid_grant',
      failureCount: 3,
      backoffUntil: null,
      lastTestAt: null,
      lastTestOk: null,
      lastTestError: null,
      lastTestLatencyMs: null,
      createdAt: '2026-10-02T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    },
  ]
  /** 假装账号记录里有秘密引用名；HTTP 层必须把它剥掉。 */
  readonly extraSecret = { credentialRef: 'credential-ref-acc-1', credentialConfigured: true }
  readonly calls: { method: string; args: unknown[] }[] = []

  list(query: { provider?: string; status?: string } = {}): AccountViewLike[] {
    this.calls.push({ method: 'list', args: [query] })
    return this.accounts.filter(
      (account) =>
        (query.provider === undefined || account.provider === query.provider) &&
        (query.status === undefined || account.status === query.status),
    )
  }

  get(id: string): AccountViewLike {
    this.calls.push({ method: 'get', args: [id] })
    const account = this.accounts.find((item) => item.id === id)
    if (account === undefined) throw new DomainError('IDENTITY_NOT_FOUND', '没有这个账号')
    return { ...account, ...this.extraSecret } as AccountViewLike
  }

  async create(actor: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: 'create', args: [actor, input] })
    const account = {
      id: 'acc_new',
      provider: String(input.provider),
      kind: String(input.kind),
      label: String(input.label),
      enabled: input.enabled !== false,
      status: 'active',
      email: null,
      subject: null,
      baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl : null,
      protocol: typeof input.protocol === 'string' ? input.protocol : null,
      models: Array.isArray(input.models) ? input.models : null,
      modelMap:
        typeof input.modelMap === 'object' && input.modelMap !== null
          ? (input.modelMap as Record<string, string>)
          : null,
      priority: typeof input.priority === 'number' ? input.priority : 0,
      accessExpiresAt: null,
      refreshDueAt: null,
      lastRefreshAt: null,
      lastError: null,
      failureCount: 0,
      backoffUntil: null,
      lastTestAt: null,
      lastTestOk: null,
      lastTestError: null,
      lastTestLatencyMs: null,
      createdAt: '2026-10-03T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
    }
    this.accounts.push(account)
    return { ...account, ...this.extraSecret } as AccountViewLike
  }

  async update(actor: string, id: string, patch: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: 'update', args: [actor, id, patch] })
    return this.replace(id, patch)
  }

  async enable(actor: string, id: string): Promise<unknown> {
    this.calls.push({ method: 'enable', args: [actor, id] })
    return this.replace(id, { enabled: true })
  }

  async disable(actor: string, id: string): Promise<unknown> {
    this.calls.push({ method: 'disable', args: [actor, id] })
    return this.replace(id, { enabled: false })
  }

  async remove(actor: string, id: string): Promise<unknown> {
    this.calls.push({ method: 'remove', args: [actor, id] })
    return { removed: true }
  }

  async bulkEnable(actor: string, ids: readonly string[]): Promise<unknown> {
    this.calls.push({ method: 'bulkEnable', args: [actor, ids] })
    return this.applyAll(ids, { enabled: true })
  }

  async bulkDisable(actor: string, ids: readonly string[]): Promise<unknown> {
    this.calls.push({ method: 'bulkDisable', args: [actor, ids] })
    return this.applyAll(ids, { enabled: false })
  }

  async bulkUpdate(actor: string, ids: readonly string[], patch: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: 'bulkUpdate', args: [actor, ids, patch] })
    // 真服务会拒 `enabled`（它只认元数据字段）；夹具也照做，别把错误吞掉。
    if (Object.hasOwn(patch, 'enabled')) {
      throw new DomainError('ACCOUNT_ADMIN_INPUT_INVALID', 'enabled 请用 batchEnable / batchDisable')
    }
    return this.applyAll(ids, patch)
  }

  /** 逐项成功或失败（与真服务的 `BulkOperationResult` 同形）。 */
  private applyAll(ids: readonly string[], patch: Record<string, unknown>): unknown {
    const items = ids.map((id) => {
      const account = this.accounts.find((item) => item.id === id)
      if (account === undefined) {
        return {
          id,
          ok: false,
          account: null,
          error: { code: 'IDENTITY_NOT_FOUND', message: '没有这个账号' },
        }
      }
      return { id, ok: true, account: this.replace(id, patch), error: null }
    })
    const succeeded = items.filter((item) => item.ok).length
    return { total: items.length, succeeded, failed: items.length - succeeded, items }
  }

  async importCredentials(actor: string, id: string, input: unknown): Promise<unknown> {
    this.calls.push({ method: 'importCredentials', args: [actor, id, input] })
    return this.get(id)
  }

  async importAccounts(actor: string, input: unknown): Promise<unknown> {
    this.calls.push({ method: 'importAccounts', args: [actor, input] })
    return {
      total: 1,
      created: 1,
      failed: 0,
      items: [{ index: 0, ok: true, account: this.get('acc_1'), error: null }],
    }
  }

  previewImport(input: unknown): unknown {
    this.calls.push({ method: 'previewImport', args: [input] })
    return {
      format: 'api-key',
      provider: 'openai',
      kind: 'api_key',
      email: null,
      subject: null,
      expiresAt: null,
      hasAccessToken: false,
      hasRefreshToken: false,
      hasApiKey: true,
    }
  }

  async testConnection(
    id: string,
    input: { model?: string; protocol?: string },
  ): Promise<{
    ok: boolean
    status: number | null
    latencyMs: number
    model: string | null
    protocol: string | null
    error: string | null
    testedAt: string
    request: { prompt: string | null; model: string | null; protocol: string; endpoint: string }
    response: { status: number; bodySnippet: string; truncated: boolean } | null
  }> {
    this.calls.push({ method: 'testConnection', args: [id, input] })
    const account = this.accounts.find((item) => item.id === id)
    if (account === undefined) throw new DomainError('IDENTITY_NOT_FOUND', '没有这个账号')
    const model = input.model ?? account.models?.[0] ?? null
    const protocol = input.protocol ?? account.protocol ?? 'openai-chat'
    return {
      ok: true,
      status: 200,
      latencyMs: 123,
      model,
      protocol,
      error: null,
      testedAt: '2026-10-21T00:00:00.000Z',
      // 详情块：真服务从**实际发出去的请求**取值，这里用同样的形状。
      request: {
        prompt: 'hi',
        model,
        protocol,
        endpoint: 'https://api.openai.com/v1/chat/completions',
      },
      response: { status: 200, bodySnippet: '{"id":"chatcmpl-1"}', truncated: false },
    }
  }

  previewImportSource(input: unknown): unknown {
    this.calls.push({ method: 'previewImportSource', args: [input] })
    const source = (input as { source?: string }).source ?? 'auto'
    return {
      source: source === 'auto' ? 'plain-keys' : source,
      total: 1,
      items: [
        {
          index: 0,
          ok: true,
          label: 'from-source',
          provider: 'openai',
          kind: 'api_key',
          baseUrl: null,
          models: null,
          error: null,
        },
      ],
    }
  }

  async importSource(actor: string, input: unknown): Promise<unknown> {
    this.calls.push({ method: 'importSource', args: [actor, input] })
    return {
      total: 1,
      created: 1,
      failed: 0,
      items: [{ index: 0, ok: true, account: this.get('acc_1'), error: null }],
    }
  }

  private replace(id: string, patch: Record<string, unknown>): AccountViewLike {
    const index = this.accounts.findIndex((item) => item.id === id)
    if (index < 0) throw new DomainError('IDENTITY_NOT_FOUND', '没有这个账号')
    const updated = { ...this.accounts[index]!, ...patch, updatedAt: new Date().toISOString() }
    this.accounts[index] = updated
    return { ...updated, ...this.extraSecret } as AccountViewLike
  }
}
