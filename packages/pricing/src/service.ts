/**
 * 模型价格表（服务名 `pricing`）。
 *
 * 定位：**价格是控制面数据**，不是请求链路上的东西。Go 不读价格、不算钱；
 * 用量插件在一次查询开始时取一份快照，用 `quoteMicrosOf()` 在内存里把 token 换算成费用。
 *
 * 三条纪律：
 * - 金额只以十进制字符串进出，内部换 BigInt 微元；没有任何浮点（AGENTS.md §2.4.3）。
 * - 写者唯一：本插件独占 `dataPath` 指向的 JSON；别的插件只读。
 * - 读不限权，写要求 actor 在 `adminPlugins` 白名单里（默认拒绝）。
 */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context, type Logger } from 'cordis'
import {
  describeError,
  jsonFileStore,
  nowIso,
  type JsonStore,
} from '@dizzyapi/plugin-kit'
import {
  PRICING_CONFIG_SCHEMA,
  type PricingConfig,
  type ResolvedPricingConfig,
} from './config.ts'
import { PricingError, isPricingError } from './errors.ts'
import { normalizeYuan, priceMicrosOf, quoteMicrosOf, quoteMicrosOfPrice } from './money.ts'
import type {
  ModelPrice,
  ModelPriceInput,
  PricingServiceLike,
  PricingSnapshot,
  TokenCounts,
} from './types.ts'

const FILE_VERSION = 1
const MODEL_MAX_LENGTH = 200

interface StoredPrice {
  readonly input: string
  readonly output: string
  readonly cacheRead: string
  readonly cacheWrite: string
  readonly updatedAt: string
}

interface PricingFile {
  readonly version: number
  readonly prices: Readonly<Record<string, StoredPrice>>
}

export class PricingService extends Service implements PricingServiceLike {
  static Config = PRICING_CONFIG_SCHEMA

  /** 价格表不依赖任何别的插件：被单独禁用时只影响费用显示，不影响用量与请求链路。 */
  static inject: readonly string[] = []

  static catalog = {
    capabilities: ['model-pricing'],
    events: [
      {
        name: 'pricing/changed',
        description: '价格表被写入或删除',
        payload: 'model: string, action: upsert|remove',
      },
    ],
    bridge: [],
    storage: [{ key: 'dataPath', kind: 'file', description: '价格表 JSON（元 / 百万 token）' }],
    shapes: {
      ModelPrice: {
        description: '一个模型的四项单价（元 / 百万 token，十进制字符串）',
        fields: {
          model: { type: 'string' },
          inputPerMillion: { type: 'string' },
          outputPerMillion: { type: 'string' },
          cacheReadPerMillion: { type: 'string' },
          cacheWritePerMillion: { type: 'string' },
          currency: { type: 'string' },
          updatedAt: { type: 'string' },
        },
      },
    },
  } as const

  readonly config: ResolvedPricingConfig
  private readonly logger: Logger
  private readonly store: JsonStore<PricingFile>
  private prices = new Map<string, ModelPrice>()
  private queue: Promise<unknown> = Promise.resolve()
  private ready = false

  constructor(ctx: Context, config: PricingConfig | ResolvedPricingConfig = {}) {
    super(ctx, 'pricing')
    this.config = resolveConfig(config)
    const path = resolveDataPath(ctx, this.config.dataPath)
    this.store =
      path === undefined
        ? memoryPricingStore()
        : jsonFileStore<PricingFile>(path, pricingCodec, emptyPricingFile)
    this.logger = ctx.logger('pricing')
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    const file = await this.store.read()
    this.prices = decodePrices(file)
    this.ready = true
    this.logger.info(`价格表已装载：存储 ${this.store.describe}；${this.prices.size} 个模型`)
    yield () => {
      this.ready = false
    }
  }

  // ───────────────────────────────── 读

  list(): readonly ModelPrice[] {
    this.assertReady()
    return [...this.prices.values()]
      .sort((a, b) => a.model.localeCompare(b.model))
      .map(copyPrice)
  }

  get(model: string): ModelPrice | null {
    this.assertReady()
    const price = this.prices.get(normalizeModel(model))
    return price === undefined ? null : copyPrice(price)
  }

  /** 一次性快照：调用方在内存里算整页费用，不要逐行回查。 */
  snapshot(): PricingSnapshot {
    this.assertReady()
    return new Map(this.prices)
  }

  /** 按当前价格算一次请求的应扣费用（整数微元，十进制字符串）。 */
  quote(model: string, tokens: TokenCounts): string {
    return quoteMicrosOf(this.snapshot(), normalizeModel(model), tokens).toString()
  }

  // ───────────────────────────────── 写

  async set(actor: string, model: string, input: ModelPriceInput): Promise<ModelPrice> {
    this.assertAdmin(actor)
    const name = normalizeModel(model)
    const now = nowIso()
    const price: ModelPrice = {
      model: name,
      inputPerMillion: normalizePrice(input.inputPerMillion, 'inputPerMillion'),
      outputPerMillion: normalizePrice(input.outputPerMillion, 'outputPerMillion'),
      cacheReadPerMillion: normalizePrice(input.cacheReadPerMillion ?? 0, 'cacheReadPerMillion'),
      cacheWritePerMillion: normalizePrice(input.cacheWritePerMillion ?? 0, 'cacheWritePerMillion'),
      currency: 'CNY',
      updatedAt: now,
    }
    // 先验证能换算成微元，避免写进一份永远算不出费用的表。
    priceMicrosOf(price)
    await this.exclusive(async () => {
      this.prices.set(name, price)
      await this.persist()
    })
    this.ctx.emit('pricing/changed', name, 'upsert')
    return copyPrice(price)
  }

  async remove(actor: string, model: string): Promise<boolean> {
    this.assertAdmin(actor)
    const name = normalizeModel(model)
    let removed = false
    await this.exclusive(async () => {
      removed = this.prices.delete(name)
      if (removed) await this.persist()
    })
    if (removed) this.ctx.emit('pricing/changed', name, 'remove')
    return removed
  }

  // ───────────────────────────────── 内部

  private async persist(): Promise<void> {
    const prices: Record<string, StoredPrice> = {}
    for (const [model, price] of this.prices) {
      prices[model] = {
        input: price.inputPerMillion,
        output: price.outputPerMillion,
        cacheRead: price.cacheReadPerMillion,
        cacheWrite: price.cacheWritePerMillion,
        updatedAt: price.updatedAt,
      }
    }
    try {
      await this.store.write({ version: FILE_VERSION, prices })
    } catch (error) {
      throw new PricingError('PRICING_STORE_FAILED', `价格表写入失败：${describeError(error)}`)
    }
  }

  private assertAdmin(actor: string): void {
    const allowed = this.config.adminPlugins ?? []
    if (!allowed.includes(actor)) {
      throw new PricingError('PRICING_FORBIDDEN', `插件 ${actor || '(空)'} 不在价格表管理白名单里`)
    }
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new PricingError('PRICING_CONFIG_INVALID', '价格表尚未装载完成')
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

function resolveConfig(config: PricingConfig | ResolvedPricingConfig): ResolvedPricingConfig {
  return {
    dataPath: config.dataPath,
    adminPlugins: config.adminPlugins,
  }
}

function resolveDataPath(ctx: Context, path: string | undefined): string | undefined {
  if (path === undefined || path === '' || isAbsolute(path)) return path === '' ? undefined : path
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}

function normalizeModel(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PricingError('PRICING_MODEL_INVALID', '模型名必须是字符串')
  }
  const model = value.trim()
  if (model === '' || model.length > MODEL_MAX_LENGTH) {
    throw new PricingError('PRICING_MODEL_INVALID', `模型名长度必须在 1..${MODEL_MAX_LENGTH} 之间`)
  }
  // 控制字符会污染日志与导出；空白只允许出现在中间（上游模型名里很少见，但不拦）。
  if (/[\u0000-\u001f\u007f]/.test(model)) {
    throw new PricingError('PRICING_MODEL_INVALID', '模型名不能包含控制字符')
  }
  return model
}

function normalizePrice(value: string | number, field: string): string {
  try {
    return normalizeYuan(value)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new PricingError('PRICING_PRICE_INVALID', `${field} 不合法：${reason}`)
  }
}

function copyPrice(price: ModelPrice): ModelPrice {
  return { ...price }
}

function emptyPricingFile(): PricingFile {
  return { version: FILE_VERSION, prices: {} }
}

const pricingCodec = {
  encode(file: PricingFile): unknown {
    return { version: file.version, prices: file.prices }
  },
  decode(raw: unknown): PricingFile {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new PricingError('PRICING_STORE_FAILED', '价格表文件必须是 JSON 对象')
    }
    const record = raw as Record<string, unknown>
    const version = record.version ?? FILE_VERSION
    if (version !== FILE_VERSION) {
      throw new PricingError('PRICING_STORE_FAILED', `价格表文件版本不支持：${String(version)}`)
    }
    const prices = record.prices
    if (prices === undefined) return emptyPricingFile()
    if (typeof prices !== 'object' || prices === null || Array.isArray(prices)) {
      throw new PricingError('PRICING_STORE_FAILED', 'prices 必须是对象')
    }
    return { version: FILE_VERSION, prices: prices as Record<string, StoredPrice> }
  },
}

function memoryPricingStore(): JsonStore<PricingFile> {
  let current = emptyPricingFile()
  return {
    describe: 'memory（进程退出即丢）',
    path: undefined,
    async read() {
      return current
    },
    async write(value) {
      current = value
    },
    async close() {
      // 无待落盘状态
    },
  }
}

/** 把文件里的条目解码成领域对象；缺失字段按 0 处理，非法值明确失败。 */
function decodePrices(file: PricingFile): Map<string, ModelPrice> {
  const table = new Map<string, ModelPrice>()
  for (const [model, stored] of Object.entries(file.prices ?? {})) {
    if (typeof stored !== 'object' || stored === null) {
      throw new PricingError('PRICING_STORE_FAILED', `价格表条目 ${model} 不是对象`)
    }
    const entry = stored as Partial<StoredPrice>
    const price: ModelPrice = {
      model: normalizeModel(model),
      inputPerMillion: normalizePrice(entry.input ?? '0', 'input'),
      outputPerMillion: normalizePrice(entry.output ?? '0', 'output'),
      cacheReadPerMillion: normalizePrice(entry.cacheRead ?? '0', 'cacheRead'),
      cacheWritePerMillion: normalizePrice(entry.cacheWrite ?? '0', 'cacheWrite'),
      currency: 'CNY',
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : nowIso(),
    }
    priceMicrosOf(price)
    table.set(price.model, price)
  }
  return table
}

export { quoteMicrosOfPrice }
export type { ModelPrice, ModelPriceInput, PricingServiceLike, PricingSnapshot, TokenCounts }
export { isPricingError }
