import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from 'cordis'
import { describeError, type JsonStore } from '@dizzyapi/plugin-kit'
import { CREDENTIALS_CONFIG_SCHEMA, type ResolvedCredentialsConfig } from './config.ts'
import { CredentialsError } from './errors.ts'
import { isRef, normalizeRef } from './ref.ts'
import { createCredentialsStore, type CredentialRecord, type CredentialsSnapshot } from './store.ts'

/** 关于一个凭据能对外说的话。**没有 value 字段**，结构上就回不了值。 */
export interface CredentialDescription {
  readonly configured: boolean
  readonly createdAt?: string
  readonly updatedAt?: string
}

/** 秘密长度上限：授权码 / API key 都远小于它，超了多半是拿错东西来塞。 */
const VALUE_MAX_LENGTH = 4096

/**
 * 凭据插件：**秘密的唯一写者**（AGENTS.md D8 的落实）。
 *
 * 三条边界：
 *
 * 1. **值只进不出给管理面**。`describe` / `list` 的返回类型里根本没有 value；
 *    只有进程内消费者能用 `resolve` 取到值。将来加 HTTP 路由时，路由只接
 *    `set` / `unset` / `describe` / `list`，`resolve` 不进路由层。
 * 2. **改动先落盘再改内存**，落盘失败不留半个内存状态。
 * 3. **读的时候表一定建好了**：装载由 `[Service.init]` 承担，cordis 会等它跑完
 *    才把服务标成 ACTIVE；真在装载完成前被读到（非严格 get 会这样），
 *    抛 CREDENTIALS_NOT_READY 而不是回一个「没有这个凭据」。
 *
 * 成员不能用 `#` 私有字段：cordis 以 Proxy 作 receiver 调用服务方法，
 * `#` 字段的 brand check 会抛「Receiver must be an instance of class」。
 */
export class CredentialsService extends Service {
  static Config = CREDENTIALS_CONFIG_SCHEMA

  readonly config: ResolvedCredentialsConfig
  private store: JsonStore<CredentialsSnapshot>
  private entries: Map<string, CredentialRecord> | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: ResolvedCredentialsConfig = {}) {
    super(ctx, 'credentials')
    this.config = config
    this.store = createCredentialsStore(resolveDataPath(ctx, config.dataPath))

    const logger = ctx.logger('credentials')
    logger.info(`凭据插件已装载：存储 ${this.store.describe}；对外只回报「配没配」，不回值`)
    if (config.dataPath === undefined) {
      logger.warn('没有配置 dataPath：凭据只存在内存里，进程一重启就没了')
    }

    // 注册即副作用：插件被卸载时这里跟着回收（AGENTS.md D5）。
    ctx.effect(() => () => this.store.close(), 'credentials.store')
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    this.entries = await this.load()
  }

  // ───────────────────────────── 写面（值只进不出） ─────────────────────────────

  /** 写入或覆盖一个凭据。**永不回显值**，也不返回任何包含值的东西。 */
  async set(ref: string, value: string): Promise<void> {
    const name = normalizeRef(ref)
    const secret = normalizeValue(value)

    await this.exclusive(async () => {
      const table = this.table()
      const now = new Date().toISOString()
      const existing = table.get(name)
      const next = new Map(table)
      next.set(name, { value: secret, createdAt: existing?.createdAt ?? now, updatedAt: now })
      await this.commit(next)
      this.ctx.emit('credentials/reference-updated', name)
    })
  }

  /** 删除一个凭据。不存在也算成功（幂等）——它要的只是「之后没有」。 */
  async unset(ref: string): Promise<void> {
    const name = normalizeRef(ref)

    await this.exclusive(async () => {
      const table = this.table()
      if (!table.has(name)) return
      const next = new Map(table)
      next.delete(name)
      await this.commit(next)
      this.ctx.emit('credentials/reference-updated', name)
    })
  }

  // ───────────────────────────── 读面（值只在进程内） ─────────────────────────────

  /**
   * 只看「有没有」。这是管理面唯一能问的读法，**绝不返回值**。
   *
   * 引用名不合法时不抛，回 `{ configured: false }`：这是个探测接口，
   * 对垃圾输入，「不可用」就是正确答案；真写错了名字会在投递时以
   * MAILER_CREDENTIAL_MISSING 明确失败。
   */
  describe(ref: string): CredentialDescription {
    const record = isRef(ref) ? this.table().get(ref) : undefined
    if (record === undefined) return { configured: false }
    return { configured: true, createdAt: record.createdAt, updatedAt: record.updatedAt }
  }

  /** 只有名字，没有值。 */
  list(): readonly string[] {
    return [...this.table().keys()]
  }

  /**
   * 取值。**这是唯一返回值的方法**，只对进程内消费者开放；任何面向界面 /
   * HTTP 的读取都必须走 describe / list。
   *
   * 同步返回：表在装载时就建好了，值都在内存里。这样依赖方不必把异步
   * 塞进本来同步的路径（cordis 明确不支持异步配置校验）。
   */
  resolve(ref: string): string | undefined {
    if (!isRef(ref)) return undefined
    return this.table().get(ref)?.value
  }

  // ───────────────────────────────── 内部 ─────────────────────────────────

  private async load(): Promise<Map<string, CredentialRecord>> {
    try {
      const snapshot = await this.store.read()
      return new Map(Object.entries(snapshot.entries))
    } catch (error) {
      if (error instanceof CredentialsError) throw error
      throw new CredentialsError('CREDENTIALS_STORE_UNREADABLE', `读取凭据文件失败：${describeError(error)}`)
    }
  }

  private table(): Map<string, CredentialRecord> {
    if (this.entries === undefined) {
      throw new CredentialsError('CREDENTIALS_NOT_READY', '凭据表尚未装载完成，此刻不能读写')
    }
    return this.entries
  }

  /** 先落盘、再改内存：落盘失败时内存里的表原样不动，不会出现「读到自己没写成功的东西」。 */
  private async commit(next: Map<string, CredentialRecord>): Promise<void> {
    try {
      await this.store.write({ entries: Object.fromEntries(next) })
    } catch (error) {
      throw new CredentialsError('CREDENTIALS_STORE_UNWRITABLE', `写入凭据文件失败：${describeError(error)}`)
    }
    this.entries = next
  }

  /** 串行执行：同一时刻只有一次「读表 → 改 → 落盘」在进行。 */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.then(noop, noop)
    return result
  }
}

function noop(): void {
  // 只用来把队列里失败的 promise 咽掉，避免污染下一次 task
}

function normalizeValue(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new CredentialsError('CREDENTIALS_VALUE_INVALID', '凭据值必须是非空字符串')
  }
  if (value.includes('\u0000')) {
    throw new CredentialsError('CREDENTIALS_VALUE_INVALID', '凭据值不得包含 NUL 字符')
  }
  if (value.length > VALUE_MAX_LENGTH) {
    throw new CredentialsError('CREDENTIALS_VALUE_INVALID', `凭据值最长 ${VALUE_MAX_LENGTH} 个字符`)
  }
  return value
}

function resolveDataPath(ctx: Context, path: string | undefined): string | undefined {
  if (path === undefined || isAbsolute(path)) return path
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}
