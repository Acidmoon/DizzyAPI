/**
 * 账号保管插件（服务名 `identity`）。
 *
 * 职责只有两件（AGENTS.md D17 / D18）：
 * 1. 持久化上游账号记录（订阅 OAuth / 外部 API-key），不碰请求转发与计费；
 * 2. 在访问令牌快过期时，用 refresh_token 向上游换一对新令牌。
 *
 * 秘密的边界：账号文件里**没有**令牌；令牌放在 credentials 插件的
 * `<credentialPrefix>/<account.id>` 引用下。刷新成功时先写凭据、再写账号记录：
 * 反过来的话，账号记录会宣称「已刷新」，而凭据里还是旧令牌，下一次刷新窗口
 * 就要再等一个周期；先写凭据最多只是多刷一次（新 RT 仍然有效）。
 */
import { randomBytes } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context, type Logger } from 'cordis'
import { describeError, nowIso, type JsonStore } from '@dizzyapi/plugin-kit'
import {
  IDENTITY_CONFIG_SCHEMA,
  IDENTITY_DEFAULTS,
  type IdentityConfig,
  type ResolvedIdentityConfig,
} from './config.ts'
import { IdentityError, isIdentityError } from './errors.ts'
import { exchangeRefreshToken, ProviderExchangeError, supportsRefresh } from './providers.ts'
import { createIdentityStore, SNAPSHOT_VERSION, type IdentitySnapshot } from './store.ts'
import type {
  CreateIdentityAccountInput,
  IdentityAccount,
  IdentityAccountKind,
  IdentityHealth,
  IdentityProvider,
  IdentityProtocol,
  IdentityRefreshResult,
  IdentityTestResult,
  IdentityTokenBundle,
  UpdateIdentityAccountInput,
} from './types.ts'

/** credentials 的结构性视图：只声明本插件用到的四个方法，不 import 它的实现。 */
interface CredentialsSeam {
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  resolve(ref: string): string | undefined
  describe(ref: string): { readonly configured: boolean }
}

interface RefreshOutcome {
  readonly account: IdentityAccount
  readonly refreshed: boolean
  readonly error: string | null
}

const MIN_DUE_DELAY_MS = 30_000
const ACCESS_TOKEN_SAFETY_MS = 60_000
const ID_PATTERN = /^acc-[a-f0-9]{12}$/

export class IdentityService extends Service {
  static Config = IDENTITY_CONFIG_SCHEMA

  /** 能力清单：账号元数据的唯一写者 + RT 刷新；令牌在 credentials 里。 */
  static catalog = {
    capabilities: ['upstream-accounts', 'token-refresh', 'account-connectivity-test'],
    events: [
      {
        name: 'identity/account-updated',
        description: '账号记录或凭据发生写入',
        payload: 'id: string, reason: created|updated|credentials|removed',
      },
      { name: 'identity/account-refreshed', description: '一次成功的 RT 交换', payload: 'id: string' },
      {
        name: 'identity/account-failed',
        description: '一次失败的刷新尝试',
        payload: 'id: string, code: string',
      },
    ],
    bridge: [],
    storage: [{ key: 'dataPath', kind: 'file', description: '账号元数据 JSON（不含任何令牌）' }],
    methods: {
      recordTestResult: {
        description:
          '写入最近一次连通性测试结果（lastTest*）；这是运营元数据，不触发 identity/account-updated，也不影响调度',
      },
      setLabels: { description: '写入多标签数组；进 Go 快照的 tags，触发 account-updated' },
      setWeight: { description: '写入权重（> 0）或 null（未声明）；进 Go 快照，触发 account-updated' },
      setConcurrency: { description: '写入并发上限（>= 1）或 null（未声明）；进 Go 快照，触发 account-updated' },
      setHealth: { description: '写入健康状态（unknown / healthy / degraded / unhealthy）；触发 account-updated' },
      autoDisable: {
        description: '系统自动停用：只把 status 改成 auto_disabled，不动 enabled；非 active 账号是 no-op',
      },
      autoEnable: { description: '系统自动恢复：只把 auto_disabled 改回 active，不碰 needs_reauth 与 enabled' },
      reportUsed: {
        description:
          '回报账号最近使用时间（lastUsedAt）：只前进不后退、不改 updatedAt、不发 account-updated；未知账号是 no-op',
      },
    },
  } as const

  readonly config: ResolvedIdentityConfig
  private readonly store: JsonStore<IdentitySnapshot>
  private readonly logger: Logger
  private accounts = new Map<string, IdentityAccount>()
  private ready = false
  private queue: Promise<unknown> = Promise.resolve()
  private readonly inflight = new Map<string, Promise<RefreshOutcome>>()
  private pass: Promise<void> | undefined

  constructor(ctx: Context, config: IdentityConfig | ResolvedIdentityConfig = {}) {
    super(ctx, 'identity')
    this.config = resolveConfig(config)
    this.store = createIdentityStore(resolveDataPath(ctx, this.config.dataPath))
    this.logger = ctx.logger('identity')
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    await this.load()
    this.logger.info(
      `账号保管插件已装载：存储 ${this.store.describe}；${this.accounts.size} 个账号；` +
        `轮询 ${this.config.pollIntervalMs}ms；RT 刷新 claude / openai`,
    )
    const stopScheduler = this.startScheduler()
    // 启动就先跑一轮，别等到第一个轮询间隔。
    void this.runRefreshPass().catch((error) => {
      this.logger.warn(`启动刷新扫描失败：${describeError(error)}`)
    })
    yield () => {
      stopScheduler()
    }
  }

  // ───────────────────────────────── 读

  get(id: string): IdentityAccount {
    this.assertReady()
    return copyAccount(this.requireAccount(id))
  }

  list(): IdentityAccount[] {
    this.assertReady()
    return [...this.accounts.values()]
      .sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)))
      .map(copyAccount)
  }

  /** 只回答「配没配」，不返回值——与 credentials.describe 的口径一致。 */
  credentialStatus(id: string): { readonly ref: string; readonly configured: boolean } {
    this.assertReady()
    const account = this.requireAccount(id)
    const credentials = this.credentials()
    return {
      ref: account.credentialRef,
      configured: credentials?.describe(account.credentialRef).configured ?? false,
    }
  }

  // ───────────────────────────────── 写

  create(input: CreateIdentityAccountInput): Promise<IdentityAccount> {
    this.assertReady()
    return this.exclusive(async () => {
      const label = input.label.trim()
      if (label === '') throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'label 不能为空')
      if (input.kind !== 'oauth' && input.kind !== 'api_key') {
        throw new IdentityError('IDENTITY_ACCOUNT_INVALID', `不认识的账号类型：${String(input.kind)}`)
      }
      this.assertProvider(input.provider, input.kind)

      const id = this.newId()
      const credentialRef = `${this.config.credentialPrefix}/${id}`
      const bundle = normalizeBundle(input.kind, input.secret)
      const now = nowIso()

      if (bundle !== undefined) await this.writeBundle(credentialRef, bundle)

      const account: IdentityAccount = {
        id,
        provider: input.provider,
        kind: input.kind,
        label,
        enabled: input.enabled ?? true,
        status: 'active',
        credentialRef,
        email: emptyToNull(input.email),
        subject: emptyToNull(input.subject),
        baseUrl: normalizeBaseUrl(input.baseUrl),
        protocol: normalizeProtocol(input.protocol),
        models: normalizeModels(input.models),
        modelMap: normalizeModelMap(input.modelMap),
        clientProfile: normalizeClientProfile(input.clientProfile),
        priority: normalizePriority(input.priority, 0),
        labels: [],
        weight: null,
        concurrency: null,
        health: 'unknown',
        autoDisabledAt: null,
        autoDisabledReason: null,
        lastUsedAt: null,
        accessExpiresAt: bundle?.expiresAt ?? null,
        refreshDueAt: input.kind === 'oauth' ? dueIso(bundle?.expiresAt, this.config.refreshLeadMs) : null,
        lastRefreshAt: null,
        lastError: null,
        failureCount: 0,
        backoffUntil: null,
        lastTestAt: null,
        lastTestOk: null,
        lastTestError: null,
        lastTestLatencyMs: null,
        createdAt: now,
        updatedAt: now,
      }

      const next = new Map(this.accounts)
      next.set(id, account)
      try {
        await this.commit(next)
      } catch (error) {
        // 账号没落盘就别留下一个孤儿秘密。
        if (bundle !== undefined) {
          await this.credentials()?.unset(credentialRef).catch(() => undefined)
        }
        throw error
      }
      this.ctx.emit('identity/account-updated', id, 'created')
      return copyAccount(account)
    })
  }

  update(id: string, patch: UpdateIdentityAccountInput): Promise<IdentityAccount> {
    this.assertReady()
    return this.exclusive(async () => {
      const account = this.requireAccount(id)
      const updated: IdentityAccount = {
        ...account,
        label: patch.label === undefined ? account.label : requireLabel(patch.label),
        email: patch.email === undefined ? account.email : emptyToNull(patch.email ?? undefined),
        subject: patch.subject === undefined ? account.subject : emptyToNull(patch.subject ?? undefined),
        baseUrl: patch.baseUrl === undefined ? account.baseUrl : normalizeBaseUrl(patch.baseUrl),
        protocol: patch.protocol === undefined ? account.protocol : normalizeProtocol(patch.protocol),
        models: patch.models === undefined ? account.models : normalizeModels(patch.models),
        modelMap: patch.modelMap === undefined ? account.modelMap : normalizeModelMap(patch.modelMap),
        clientProfile:
          patch.clientProfile === undefined ? account.clientProfile : normalizeClientProfile(patch.clientProfile),
        priority: patch.priority === undefined ? account.priority : normalizePriority(patch.priority, account.priority),
        labels: patch.labels === undefined ? account.labels : normalizeLabels(patch.labels),
        weight: patch.weight === undefined ? account.weight : normalizeWeight(patch.weight),
        concurrency:
          patch.concurrency === undefined ? account.concurrency : normalizeConcurrency(patch.concurrency),
        enabled: patch.enabled === undefined ? account.enabled : patch.enabled,
        updatedAt: nowIso(),
      }
      const next = new Map(this.accounts)
      next.set(id, updated)
      await this.commit(next)
      this.ctx.emit('identity/account-updated', id, 'updated')
      return copyAccount(updated)
    })
  }

  /**
   * 导入 / 重新授权：写入一对新令牌。
   * 新包缺 refresh_token 时保留旧的（刷新响应常常不轮换 RT）。
   */
  importCredentials(id: string, secret: IdentityTokenBundle): Promise<IdentityAccount> {
    this.assertReady()
    return this.exclusive(async () => {
      const account = this.requireAccount(id)
      const incoming = normalizeBundle(account.kind, secret)
      if (incoming === undefined) {
        throw new IdentityError('IDENTITY_CREDENTIAL_INVALID', '没有可写入的令牌字段')
      }
      const previous = this.tryReadBundle(account)
      const merged: IdentityTokenBundle = {
        ...(previous ?? {}),
        ...incoming,
        ...(incoming.refreshToken !== undefined
          ? {}
          : previous?.refreshToken !== undefined
            ? { refreshToken: previous.refreshToken }
            : {}),
        ...(incoming.clientId !== undefined
          ? {}
          : previous?.clientId !== undefined
            ? { clientId: previous.clientId }
            : {}),
      }
      await this.writeBundle(account.credentialRef, merged)

      const updated: IdentityAccount = {
        ...account,
        status: 'active',
        accessExpiresAt: merged.expiresAt ?? account.accessExpiresAt,
        refreshDueAt:
          account.kind === 'oauth'
            ? dueIso(merged.expiresAt ?? account.accessExpiresAt ?? undefined, this.config.refreshLeadMs)
            : null,
        lastError: null,
        failureCount: 0,
        backoffUntil: null,
        updatedAt: nowIso(),
      }
      const next = new Map(this.accounts)
      next.set(id, updated)
      await this.commit(next)
      this.ctx.emit('identity/account-updated', id, 'credentials')
      return copyAccount(updated)
    })
  }

  remove(id: string): Promise<void> {
    this.assertReady()
    return this.exclusive(async () => {
      const account = this.requireAccount(id)
      const next = new Map(this.accounts)
      next.delete(id)
      await this.commit(next)
      try {
        await this.credentials()?.unset(account.credentialRef)
      } catch (error) {
        // 记录已经删掉，孤儿秘密不影响调度；留一条可供人工清理的日志。
        this.logger.warn(`删除账号 ${id} 后清理凭据 ${account.credentialRef} 失败：${describeError(error)}`)
      }
      this.ctx.emit('identity/account-updated', id, 'removed')
    })
  }

  // ───────────────────────────────── 令牌

  /**
   * 给未来的 transport 用的进程内 seam：返回可用的 access token。
   * **不得**挂到任何 HTTP 路由上（与 credentials.resolve 同一条纪律）。
   */
  async getAccessToken(id: string): Promise<string> {
    this.assertReady()
    const account = this.requireAccount(id)
    if (!account.enabled) {
      throw new IdentityError('IDENTITY_ACCOUNT_DISABLED', `账号 ${id} 已被停用`)
    }

    let bundle = this.readBundle(account)
    if (account.kind === 'api_key') {
      if (bundle.apiKey === undefined || bundle.apiKey === '') {
        throw new IdentityError('IDENTITY_CREDENTIAL_MISSING', `账号 ${id} 没有 API key`)
      }
      return bundle.apiKey
    }

    const expiresAt = bundle.expiresAt === undefined ? undefined : Date.parse(bundle.expiresAt)
    const stillFresh =
      bundle.accessToken !== undefined && expiresAt !== undefined && Number.isFinite(expiresAt)
        ? expiresAt - Date.now() > ACCESS_TOKEN_SAFETY_MS
        : false
    if (stillFresh) return bundle.accessToken as string

    const outcome = await this.refreshAccount(account, 'on-demand')
    if (!outcome.refreshed) {
      throw new IdentityError(
        outcome.account.status === 'needs_reauth' ? 'IDENTITY_ACCOUNT_NEEDS_REAUTH' : 'IDENTITY_REFRESH_FAILED',
        outcome.error ?? `账号 ${id} 刷新失败`,
      )
    }
    bundle = this.readBundle(outcome.account)
    if (bundle.accessToken === undefined || bundle.accessToken === '') {
      throw new IdentityError('IDENTITY_CREDENTIAL_INVALID', `账号 ${id} 刷新后没有 access token`)
    }
    return bundle.accessToken
  }

  /**
   * 记录一次连通性测试的结果。
   *
   * 这是运营元数据，**不触发** `identity/account-updated`：它不改变调度所需的任何字段
   * （enabled / status / 令牌 / 模型），推一份新快照给 Go 没有意义。错误文本应已由调用方
   * 脱敏；这里仍按上限截断，避免把一大段上游响应写进账号文件。
   */
  async recordTestResult(id: string, result: IdentityTestResult): Promise<IdentityAccount> {
    this.assertReady()
    if (typeof result !== 'object' || result === null) {
      throw new IdentityError('IDENTITY_ACCOUNT_INVALID', '测试结果必须是对象')
    }
    if (typeof result.ok !== 'boolean') {
      throw new IdentityError('IDENTITY_ACCOUNT_INVALID', '测试结果的 ok 必须是布尔值')
    }
    if (
      typeof result.latencyMs !== 'number' ||
      !Number.isFinite(result.latencyMs) ||
      result.latencyMs < 0
    ) {
      throw new IdentityError('IDENTITY_ACCOUNT_INVALID', '测试结果的 latencyMs 必须是非负数')
    }
    const testedAt = result.testedAt === undefined ? nowIso() : normalizeTestedAt(result.testedAt)
    const errorText =
      result.error === null || result.error === undefined
        ? null
        : requireTestError(result.error)

    return this.exclusive(async () => {
      const account = this.requireAccount(id)
      const updated: IdentityAccount = {
        ...account,
        lastTestAt: testedAt,
        lastTestOk: result.ok,
        lastTestError: result.ok ? null : errorText,
        lastTestLatencyMs: Math.max(0, Math.round(result.latencyMs)),
        updatedAt: nowIso(),
      }
      const next = new Map(this.accounts)
      next.set(id, updated)
      await this.commit(next)
      return copyAccount(updated)
    })
  }

  // ───────────────────────────────── 运营元数据：标签 / 权重 / 并发 / 健康

  /**
   * 标签集合。标签进 Go 快照（经 account-priority 转成 tags），会改变调度输入，
   * 因此照常发 `identity/account-updated`。`null` / 空数组 = 清空。
   */
  setLabels(id: string, labels: readonly string[] | null): Promise<IdentityAccount> {
    return this.patchAccount(id, (account) => {
      const next = normalizeLabels(labels)
      return sameStringArray(account.labels, next) ? undefined : { labels: next }
    })
  }

  /** 权重（> 0）；`null` = 未声明。未声明进快照时不带这个键，Go 侧按未知处理。 */
  setWeight(id: string, weight: number | null): Promise<IdentityAccount> {
    return this.patchAccount(id, (account) => {
      const next = normalizeWeight(weight)
      return next === account.weight ? undefined : { weight: next }
    })
  }

  /** 并发上限（>= 1）；`null` = 未声明。 */
  setConcurrency(id: string, concurrency: number | null): Promise<IdentityAccount> {
    return this.patchAccount(id, (account) => {
      const next = normalizeConcurrency(concurrency)
      return next === account.concurrency ? undefined : { concurrency: next }
    })
  }

  /**
   * 健康状态。它是调度输入（Go 的 `Filter.Health` 会按它过滤），因此发 updated 事件；
   * 与 `recordTestResult` 那种纯运营元数据不同。
   */
  async setHealth(id: string, health: IdentityHealth): Promise<IdentityAccount> {
    const next = normalizeHealth(health)
    return this.patchAccount(id, (account) => (account.health === next ? undefined : { health: next }))
  }

  /**
   * 系统自动停用：**只改 `status → 'auto_disabled'`，绝不动 `enabled`**。
   * 人的手动开关与自动化是两条线，自动化不得覆盖人的决定。
   * 只有当前 `active` 的账号会被改；已停用 / 待重新授权 / 已经自动停用的都是 no-op。
   */
  async autoDisable(id: string, reason: string): Promise<IdentityAccount> {
    const text = normalizeAutoDisableReason(reason)
    return this.patchAccount(id, (account) => {
      if (account.status !== 'active') return undefined
      return { status: 'auto_disabled', autoDisabledAt: nowIso(), autoDisabledReason: text }
    })
  }

  /**
   * 自动恢复：只把 `auto_disabled` 改回 `active`，**不得**碰 `needs_reauth`，
   * 也**不得**把 `enabled = false` 的账号打开（那条开关只由人决定）。
   */
  autoEnable(id: string): Promise<IdentityAccount> {
    return this.patchAccount(id, (account) => {
      if (account.status !== 'auto_disabled') return undefined
      return { status: 'active', autoDisabledAt: null, autoDisabledReason: null }
    })
  }

  /**
   * 回报「这个账号刚被用过」。由 usage 插件经事件上报、account-admin 节流后调用：
   * `accounts.json` 是整文件原子重写，别为每条用量写一次盘。
   *
   * 对未知账号是 no-op（账号可能刚好被删）；只前进不后退；不改 `updatedAt`、
   * 不发 `identity/account-updated`——它不改变任何调度输入。
   */
  async reportUsed(id: string, at: string): Promise<void> {
    this.assertReady()
    const account = this.accounts.get(id)
    if (account === undefined) return
    const usedAt = normalizeUsedAt(at)
    const previous = account.lastUsedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(account.lastUsedAt)
    if (Date.parse(usedAt) <= previous) return
    await this.exclusive(async () => {
      const current = this.accounts.get(id)
      if (current === undefined) return
      const previousNow =
        current.lastUsedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(current.lastUsedAt)
      if (Date.parse(usedAt) <= previousNow) return
      const next = new Map(this.accounts)
      next.set(id, { ...current, lastUsedAt: usedAt })
      await this.commit(next)
    })
  }

  /**
   * 写一个「运营元数据」补丁：形状不变就不写盘、不发事件。
   * 所有新写口都走这里，保证一次写盘 + 一次事件。
   */
  private patchAccount(
    id: string,
    build: (account: IdentityAccount) => Partial<IdentityAccount> | undefined,
  ): Promise<IdentityAccount> {
    this.assertReady()
    return this.exclusive(async () => {
      const account = this.requireAccount(id)
      const patch = build(account)
      if (patch === undefined) return copyAccount(account)
      const updated: IdentityAccount = { ...account, ...patch, updatedAt: nowIso() }
      const next = new Map(this.accounts)
      next.set(id, updated)
      await this.commit(next)
      this.ctx.emit('identity/account-updated', id, 'updated')
      return copyAccount(updated)
    })
  }

  /** 手动触发一次刷新；失败会 reject，便于面板/运维脚本拿到明确原因。 */
  async refreshNow(id: string): Promise<IdentityAccount> {
    this.assertReady()
    const account = this.requireAccount(id)
    if (account.kind !== 'oauth') {
      throw new IdentityError('IDENTITY_REFRESH_NOT_SUPPORTED', `账号 ${id} 是 ${account.kind}，没有可刷新的令牌`)
    }
    const outcome = await this.refreshAccount(account, 'manual')
    if (!outcome.refreshed) {
      throw new IdentityError(
        outcome.account.status === 'needs_reauth' ? 'IDENTITY_ACCOUNT_NEEDS_REAUTH' : 'IDENTITY_REFRESH_FAILED',
        outcome.error ?? `账号 ${id} 刷新失败`,
      )
    }
    return copyAccount(outcome.account)
  }

  // ───────────────────────────────── 调度

  /**
   * 跑一轮刷新扫描。公开出来是为了测试与运维手动触发；
   * 定时器只是按 `pollIntervalMs` 重复调用它。
   */
  async runRefreshPass(now = Date.now()): Promise<void> {
    this.assertReady()
    if (this.pass !== undefined) {
      await this.pass
      return
    }
    const task = this.doRefreshPass(now).finally(() => {
      this.pass = undefined
    })
    this.pass = task
    await task
  }

  private async doRefreshPass(now: number): Promise<void> {
    const due = [...this.accounts.values()].filter((account) => this.isDue(account, now))
    if (due.length === 0) return

    const workers = Math.min(this.config.refreshConcurrency, due.length)
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= due.length) return
        try {
          await this.refreshAccount(due[index], 'scheduled')
        } catch (error) {
          // refreshAccount 自己会把失败写进账号状态；这里只兜底意外异常。
          this.logger.warn(`账号 ${due[index].id} 刷新异常：${describeError(error)}`)
        }
      }
    }
    await Promise.all(Array.from({ length: workers }, worker))
  }

  private isDue(account: IdentityAccount, now: number): boolean {
    if (account.kind !== 'oauth' || !account.enabled || account.status !== 'active') return false
    if (account.backoffUntil !== null && Date.parse(account.backoffUntil) > now) return false
    if (account.refreshDueAt === null) return true
    return Date.parse(account.refreshDueAt) <= now
  }

  private refreshAccount(account: IdentityAccount, trigger: 'scheduled' | 'manual' | 'on-demand'): Promise<RefreshOutcome> {
    const existing = this.inflight.get(account.id)
    if (existing !== undefined) return existing
    const task = this.doRefresh(account, trigger).finally(() => {
      this.inflight.delete(account.id)
    })
    this.inflight.set(account.id, task)
    return task
  }

  private async doRefresh(
    account: IdentityAccount,
    trigger: 'scheduled' | 'manual' | 'on-demand',
  ): Promise<RefreshOutcome> {
    let bundle: IdentityTokenBundle
    try {
      bundle = this.readBundle(account)
    } catch (error) {
      return this.markFailure(account, error, false)
    }

    if (bundle.refreshToken === undefined || bundle.refreshToken === '') {
      return this.markFailure(
        account,
        new IdentityError('IDENTITY_ACCOUNT_NEEDS_REAUTH', '没有 refresh_token，需要重新导入凭据'),
        false,
      )
    }

    let result
    try {
      result = await exchangeRefreshToken(account.provider, bundle, {
        timeoutMs: this.config.requestTimeoutMs,
        fetch: globalThis.fetch,
      })
    } catch (error) {
      const retryable = error instanceof ProviderExchangeError ? error.retryable : true
      return this.markFailure(account, error, retryable)
    }

    const merged: IdentityTokenBundle = {
      ...bundle,
      accessToken: result.accessToken,
      ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
      ...(result.tokenType !== undefined ? { tokenType: result.tokenType } : {}),
      ...(result.scope !== undefined ? { scope: result.scope } : {}),
      expiresAt: result.expiresAt,
    }

    try {
      await this.writeBundle(account.credentialRef, merged)
    } catch (error) {
      return this.markFailure(account, error, true)
    }

    const updated: IdentityAccount = {
      ...account,
      status: 'active',
      accessExpiresAt: result.expiresAt,
      refreshDueAt: dueIso(result.expiresAt, this.config.refreshLeadMs),
      lastRefreshAt: nowIso(),
      lastError: null,
      failureCount: 0,
      backoffUntil: null,
      updatedAt: nowIso(),
    }
    try {
      await this.commitAccount(updated)
    } catch (error) {
      // 凭据已经更新；账号记录写失败只影响下一个刷新窗口，不让令牌白白丢掉。
      this.logger.warn(`账号 ${account.id} 刷新成功但账号记录写入失败：${describeError(error)}（${trigger}）`)
      return { account: account, refreshed: true, error: null }
    }
    this.ctx.emit('identity/account-refreshed', account.id)
    return { account: updated, refreshed: true, error: null }
  }

  private async markFailure(account: IdentityAccount, error: unknown, retryable: boolean): Promise<RefreshOutcome> {
    const message = redactMessage(error)
    const failureCount = account.failureCount + 1
    const now = Date.now()
    const updated: IdentityAccount = {
      ...account,
      status: retryable ? account.status : 'needs_reauth',
      failureCount,
      backoffUntil: retryable ? new Date(now + this.backoffMs(failureCount)).toISOString() : null,
      lastError: message,
      updatedAt: nowIso(),
    }
    try {
      await this.commitAccount(updated)
    } catch (commitError) {
      this.logger.warn(`账号 ${account.id} 失败状态写入失败：${describeError(commitError)}`)
    }
    const code = isIdentityError(error) ? error.code : error instanceof ProviderExchangeError ? 'PROVIDER_ERROR' : 'REFRESH_FAILED'
    this.ctx.emit('identity/account-failed', account.id, code)
    return { account: updated, refreshed: false, error: message }
  }

  private backoffMs(failureCount: number): number {
    const exponential = this.config.retryBaseMs * 2 ** Math.max(0, failureCount - 1)
    const capped = Math.min(exponential, this.config.retryMaxMs)
    const jitter = 0.75 + Math.random() * 0.5
    return Math.max(250, Math.round(capped * jitter))
  }

  // ───────────────────────────────── 存储与凭据

  private async load(): Promise<void> {
    let snapshot: IdentitySnapshot
    try {
      snapshot = await this.store.read()
    } catch (error) {
      if (isIdentityError(error)) throw error
      throw new IdentityError('IDENTITY_STORE_CORRUPT', `账号存储损坏：${describeError(error)}`)
    }
    this.accounts = new Map(Object.entries(snapshot.accounts))
    this.ready = true
  }

  private async commit(next: Map<string, IdentityAccount>): Promise<void> {
    try {
      await this.store.write({ version: SNAPSHOT_VERSION, accounts: Object.fromEntries(next) })
    } catch (error) {
      throw new IdentityError('IDENTITY_STORE_WRITE_FAILED', `账号文件写入失败：${describeError(error)}`)
    }
    this.accounts = next
  }

  private commitAccount(account: IdentityAccount): Promise<void> {
    return this.exclusive(async () => {
      const next = new Map(this.accounts)
      next.set(account.id, account)
      await this.commit(next)
    })
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private writeBundle(ref: string, bundle: IdentityTokenBundle): Promise<void> {
    const credentials = this.credentials()
    if (credentials === undefined) {
      throw new IdentityError('IDENTITY_CREDENTIAL_MISSING', 'credentials 服务不可用，无法保存令牌')
    }
    return credentials.set(ref, JSON.stringify(bundle))
  }

  private readBundle(account: IdentityAccount): IdentityTokenBundle {
    const credentials = this.credentials()
    if (credentials === undefined) {
      throw new IdentityError('IDENTITY_CREDENTIAL_MISSING', 'credentials 服务不可用，读不到令牌')
    }
    const raw = credentials.resolve(account.credentialRef)
    if (raw === undefined) {
      throw new IdentityError('IDENTITY_CREDENTIAL_MISSING', `凭据 ${account.credentialRef} 尚未配置`)
    }
    return parseBundle(raw, account.credentialRef)
  }

  private tryReadBundle(account: IdentityAccount): IdentityTokenBundle | undefined {
    const credentials = this.credentials()
    if (credentials === undefined) return undefined
    const raw = credentials.resolve(account.credentialRef)
    if (raw === undefined) return undefined
    return parseBundle(raw, account.credentialRef)
  }

  private credentials(): CredentialsSeam | undefined {
    return this.ctx.get('credentials', false) as CredentialsSeam | undefined
  }

  // ───────────────────────────────── 杂项

  private startScheduler(): () => void {
    const timer = setInterval(() => {
      void this.runRefreshPass().catch((error) => {
        this.logger.warn(`刷新扫描失败：${describeError(error)}`)
      })
    }, this.config.pollIntervalMs)
    timer.unref()
    return () => clearInterval(timer)
  }

  private requireAccount(id: string): IdentityAccount {
    const account = this.accounts.get(id)
    if (account === undefined) {
      throw new IdentityError('IDENTITY_ACCOUNT_NOT_FOUND', `没有账号 ${id}`)
    }
    return account
  }

  private assertReady(): void {
    if (!this.ready) throw new IdentityError('IDENTITY_NOT_READY', '账号存储尚未加载完成')
  }

  private assertProvider(provider: IdentityProvider, kind: IdentityAccountKind): void {
    if (provider !== 'claude' && provider !== 'openai' && provider !== 'custom') {
      throw new IdentityError('IDENTITY_PROVIDER_UNSUPPORTED', `不支持的 provider：${String(provider)}`)
    }
    if (kind === 'oauth' && !supportsRefresh(provider)) {
      throw new IdentityError('IDENTITY_PROVIDER_UNSUPPORTED', `${provider} 没有订阅账号的 RT 交换适配器`)
    }
  }

  private newId(): string {
    for (;;) {
      const id = `acc-${randomBytes(6).toString('hex')}`
      if (ID_PATTERN.test(id) && !this.accounts.has(id)) return id
    }
  }
}

// ───────────────────────────────── 工具

function resolveConfig(config: IdentityConfig): ResolvedIdentityConfig {
  // 仅用于构造函数默认参数；正常路径由 schema 校验后传入完整配置。
  return {
    dataPath: config.dataPath,
    credentialPrefix: config.credentialPrefix ?? IDENTITY_DEFAULTS.credentialPrefix,
    refreshLeadMs: config.refreshLeadMs ?? IDENTITY_DEFAULTS.refreshLeadMs,
    pollIntervalMs: config.pollIntervalMs ?? IDENTITY_DEFAULTS.pollIntervalMs,
    refreshConcurrency: config.refreshConcurrency ?? IDENTITY_DEFAULTS.refreshConcurrency,
    retryBaseMs: config.retryBaseMs ?? IDENTITY_DEFAULTS.retryBaseMs,
    retryMaxMs: config.retryMaxMs ?? IDENTITY_DEFAULTS.retryMaxMs,
    requestTimeoutMs: config.requestTimeoutMs ?? IDENTITY_DEFAULTS.requestTimeoutMs,
  }
}

function resolveDataPath(ctx: Context, path: string | undefined): string | undefined {
  if (path === undefined || isAbsolute(path)) return path
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}

function dueIso(expiresAt: string | undefined, leadMs: number, now = Date.now()): string {
  const expires = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt)
  // 已经过期：立刻到期，别让新导入的旧令牌白等一个最小间隔。
  if (Number.isFinite(expires) && expires <= now) return new Date(now).toISOString()
  const target = Number.isFinite(expires) ? expires - leadMs : now
  return new Date(Math.max(now + MIN_DUE_DELAY_MS, target)).toISOString()
}

function normalizeBundle(kind: IdentityAccountKind, secret: IdentityTokenBundle | undefined): IdentityTokenBundle | undefined {
  if (secret === undefined) return undefined
  const bundle: IdentityTokenBundle = {
    ...(clean(secret.accessToken) !== undefined ? { accessToken: clean(secret.accessToken) } : {}),
    ...(clean(secret.refreshToken) !== undefined ? { refreshToken: clean(secret.refreshToken) } : {}),
    ...(clean(secret.tokenType) !== undefined ? { tokenType: clean(secret.tokenType) } : {}),
    ...(clean(secret.scope) !== undefined ? { scope: clean(secret.scope) } : {}),
    ...(clean(secret.clientId) !== undefined ? { clientId: clean(secret.clientId) } : {}),
    ...(clean(secret.apiKey) !== undefined ? { apiKey: clean(secret.apiKey) } : {}),
    ...(secret.expiresAt !== undefined && Number.isFinite(Date.parse(secret.expiresAt))
      ? { expiresAt: new Date(Date.parse(secret.expiresAt)).toISOString() }
      : {}),
  }
  if (kind === 'api_key' && bundle.apiKey === undefined) {
    throw new IdentityError('IDENTITY_CREDENTIAL_INVALID', 'api_key 账号必须提供 apiKey')
  }
  if (kind === 'oauth' && bundle.accessToken === undefined && bundle.refreshToken === undefined) {
    throw new IdentityError('IDENTITY_CREDENTIAL_INVALID', 'oauth 账号至少要提供 accessToken 或 refreshToken')
  }
  return Object.keys(bundle).length === 0 ? undefined : bundle
}

function parseBundle(raw: string, ref: string): IdentityTokenBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new IdentityError('IDENTITY_CREDENTIAL_INVALID', `凭据 ${ref} 不是合法 JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new IdentityError('IDENTITY_CREDENTIAL_INVALID', `凭据 ${ref} 必须是 JSON 对象`)
  }
  const source = parsed as Record<string, unknown>
  const bundle: Record<string, string> = {}
  for (const key of ['accessToken', 'refreshToken', 'tokenType', 'scope', 'clientId', 'apiKey', 'expiresAt']) {
    const value = source[key]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      throw new IdentityError('IDENTITY_CREDENTIAL_INVALID', `凭据 ${ref} 的 ${key} 不是字符串`)
    }
    bundle[key] = value
  }
  return bundle as IdentityTokenBundle
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function emptyToNull(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'baseUrl 必须是合法的 http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'baseUrl 只支持 http / https')
  }
  return trimmed.replace(/\/+$/, '')
}

/** 只接受枚举里的协议值或 `null` / `undefined`；非法值明确失败，不静默降级。 */
function normalizeProtocol(value: string | null | undefined): IdentityProtocol | null {
  if (value === undefined || value === null) return null
  if (
    value === 'openai-chat' ||
    value === 'openai-responses' ||
    value === 'anthropic' ||
    value === 'gemini'
  ) {
    return value
  }
  throw new IdentityError(
    'IDENTITY_ACCOUNT_INVALID',
    'protocol 只能是 openai-chat / openai-responses / anthropic / gemini',
  )
}

function normalizePriority(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'priority 必须是 0–1000 的整数')
  }
  return value
}

const LABELS_MAX_ENTRIES = 50
const LABEL_MAX_LENGTH = 100
const WEIGHT_MAX = 1_000_000
const CONCURRENCY_MAX = 10_000
const AUTO_DISABLE_REASON_MAX = 500

/**
 * 标签集合：trim、丢弃空串、去重、保序；`null` / `undefined` → 空数组。
 * 存储层不解释 `key:value` 约定——那是 account-priority 的标签映射。
 */
function normalizeLabels(value: readonly string[] | null | undefined): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'labels 必须是字符串数组或 null')
  }
  if (value.length > LABELS_MAX_ENTRIES) {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', `labels 最多 ${LABELS_MAX_ENTRIES} 个`)
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'labels 的元素必须是字符串')
    }
    const label = item.trim()
    if (label === '') continue
    if (label.length > LABEL_MAX_LENGTH) {
      throw new IdentityError('IDENTITY_ACCOUNT_INVALID', `单个标签最长 ${LABEL_MAX_LENGTH} 个字符`)
    }
    rejectControlCharacters(label, '标签')
    if (seen.has(label)) continue
    seen.add(label)
    result.push(label)
  }
  return result
}

/** 权重：`null` = 未声明；否则必须是大于 0 且有限的数值（Go 侧同口径）。 */
function normalizeWeight(value: number | null): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > WEIGHT_MAX) {
    throw new IdentityError(
      'IDENTITY_ACCOUNT_INVALID',
      `weight 必须是大于 0 且不超过 ${WEIGHT_MAX} 的有限数值，或 null`,
    )
  }
  return value
}

/** 并发上限：`null` = 未声明；否则是 1–10000 的整数（0 不是「无上限」，是非法）。 */
function normalizeConcurrency(value: number | null): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > CONCURRENCY_MAX) {
    throw new IdentityError(
      'IDENTITY_ACCOUNT_INVALID',
      `concurrency 必须是 1–${CONCURRENCY_MAX} 的整数，或 null`,
    )
  }
  return value
}

/** 健康状态：只接受与 Go 侧 `contracts.HealthState` 对齐的四个值。 */
function normalizeHealth(value: unknown): IdentityHealth {
  if (value === 'unknown' || value === 'healthy' || value === 'degraded' || value === 'unhealthy') {
    return value
  }
  throw new IdentityError(
    'IDENTITY_ACCOUNT_INVALID',
    'health 只能是 unknown / healthy / degraded / unhealthy',
  )
}

function normalizeAutoDisableReason(value: string): string {
  if (typeof value !== 'string') {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', '自动停用原因必须是字符串')
  }
  const reason = value.trim()
  if (reason === '') {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', '自动停用原因不能为空')
  }
  return reason.length > AUTO_DISABLE_REASON_MAX ? `${reason.slice(0, AUTO_DISABLE_REASON_MAX)}…` : reason
}

function normalizeUsedAt(value: string): string {
  if (typeof value !== 'string') {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'lastUsedAt 必须是可识别的时间')
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'lastUsedAt 必须是可识别的时间')
  }
  return new Date(parsed).toISOString()
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

const MODELS_MAX_ENTRIES = 200
const MODEL_NAME_MAX_LENGTH = 200

/**
 * 对外模型名列表。`undefined` / `null` → `null`；逐个 trim、丢弃空串、去重、保序；
 * 空数组归一成 `null`（「没声明」与「声明了个空的」是同一件事）。非法值明确失败。
 */
function normalizeModels(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'models 必须是字符串数组或 null')
  }
  if (value.length > MODELS_MAX_ENTRIES) {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', `models 最多 ${MODELS_MAX_ENTRIES} 个`)
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'models 的元素必须是字符串')
    }
    const name = item.trim()
    if (name === '') continue
    if (name.length > MODEL_NAME_MAX_LENGTH) {
      throw new IdentityError('IDENTITY_ACCOUNT_INVALID', `模型名最长 ${MODEL_NAME_MAX_LENGTH} 个字符`)
    }
    rejectControlCharacters(name, '模型名')
    if (seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result.length === 0 ? null : result
}

/**
 * 客户端指纹档案 id。
 *
 * **这里只校验形状，不校验「这个档案存不存在」**：档案归 `clientMask` 插件管，identity 是
 * 存储方。查不到的 id 在推快照时会被 `clientMask.resolve()` 解析成「不伪装」（安全降级），
 * 页面上会显示成「引用了不存在的档案」等管理员处置 —— 比在这里拒绝、让账号改不动更好。
 *
 * 规则刻意**比 `clientMask` 宽松**（只要求非空、不太长、无控制字符）：
 * 一边严一边松会让「档案建得出来、账号却挂不上」。真正的 id 规则由写入方（clientMask）定。
 */
function normalizeClientProfile(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'clientProfile 必须是字符串或 null')
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > 128) {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'clientProfile 最长 128 个字符')
  }
  rejectControlCharacters(trimmed, 'clientProfile')
  return trimmed
}

/**
 * 对外模型名 → 上游真实模型名。`undefined` / `null` → `null`；键值都 trim 且非空；
 * 空对象归一成 `null`。非对象 / 非字符串值 / 控制字符 / 超长明确失败。
 */
function normalizeModelMap(value: unknown): Record<string, string> | null {  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'modelMap 必须是字符串映射或 null')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MODELS_MAX_ENTRIES) {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', `modelMap 最多 ${MODELS_MAX_ENTRIES} 项`)
  }
  const result: Record<string, string> = {}
  for (const [rawKey, rawValue] of entries) {
    if (typeof rawValue !== 'string') {
      throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'modelMap 的值必须是字符串')
    }
    const key = rawKey.trim()
    const mapped = rawValue.trim()
    if (key === '' || mapped === '') continue
    if (key.length > MODEL_NAME_MAX_LENGTH || mapped.length > MODEL_NAME_MAX_LENGTH) {
      throw new IdentityError('IDENTITY_ACCOUNT_INVALID', `modelMap 的键与值最长 ${MODEL_NAME_MAX_LENGTH} 个字符`)
    }
    rejectControlCharacters(key, 'modelMap 的键')
    rejectControlCharacters(mapped, 'modelMap 的值')
    result[key] = mapped
  }
  return Object.keys(result).length === 0 ? null : result
}

function rejectControlCharacters(value: string, field: string): void {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', `${field}不得包含控制字符`)
  }
}

function requireLabel(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new IdentityError('IDENTITY_ACCOUNT_INVALID', 'label 不能为空')
  return trimmed
}

function normalizeTestedAt(value: string): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', '测试结果的 testedAt 必须是可识别的时间')
  }
  return new Date(parsed).toISOString()
}

function requireTestError(value: string): string {
  if (typeof value !== 'string') {
    throw new IdentityError('IDENTITY_ACCOUNT_INVALID', '测试结果的 error 必须是字符串或 null')
  }
  return value.length > 2000 ? `${value.slice(0, 2000)}…` : value
}

function copyAccount(account: IdentityAccount): IdentityAccount {
  return { ...account }
}

/** 错误信息里不带令牌；ProviderExchangeError 本身只包含状态码与 OAuth 错误码。 */
function redactMessage(error: unknown): string {
  if (isIdentityError(error)) return error.message
  if (error instanceof ProviderExchangeError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
