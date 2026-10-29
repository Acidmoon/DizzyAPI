/**
 * 闸门快照的**构建**：把外部只读来源（价格表 / key 上限 / 用量）变成两份推送载荷。
 *
 * 这个文件只放纯函数，不碰定时器、桥与生命周期：
 * - 推送循环 → `service.ts`
 * - 类型 → `types.ts`
 *
 * 两份载荷都是**心跳式**推的（内容不变也推，`generation` 递增）：Go 侧按 TTL 判新鲜度，
 * 「内容没变就跳过推送」会让定价闸门 fail-closed 全 503（额度闸门 2026-10-29 的生产事故
 * 是同一类错误）。
 */
import { createHash } from 'node:crypto'
import { GateFeedError } from './errors.ts'
import type {
  ApiKeySeam,
  KeySpendEntryPayload,
  KeySpendSnapshotPayload,
  PriceEntryPayload,
  PricingSeam,
  PricingSnapshotPayload,
  UsageSeam,
} from './types.ts'

/** 消费快照的缓存键：用量游标 + 带上限的 key 集合。两者都没变就复用上一轮的总额。 */
export interface SpendCache {
  readonly cursor: string
  readonly signature: string
  readonly entries: readonly KeySpendEntryPayload[]
  readonly revision: string
}

/** 构建快照所需的外部来源。缺 apiKey / usage 时推空快照（Go 侧按未知放行）。 */
export interface SnapshotSources {
  readonly pricing: PricingSeam
  readonly apiKey: ApiKeySeam | undefined
  readonly usage: UsageSeam | undefined
}

/** 价格快照的构建结果（载荷 + 条数，供 status() 用）。 */
export interface PriceSnapshot {
  readonly payload: PricingSnapshotPayload
  readonly count: number
}

/** 消费快照的构建结果；`cached` 为真表示这一轮复用了缓存（没有重算）。 */
export interface SpendSnapshot {
  readonly payload: KeySpendSnapshotPayload
  readonly limitedKeys: number
  readonly cached: boolean
  readonly cache: SpendCache | undefined
}

/**
 * 价格快照：模型名 + 四项单价（元 / 百万 token，十进制字符串）。
 *
 * 客户端不校验单价语义（那是 pricing 的事），但仍然拒绝明显不是十进制字符串的值：
 * Go 侧形状校验失败会整份拒绝，推一份注定被拒的快照只会让闸门一直 503。
 */
export function buildPriceSnapshot(
  sources: SnapshotSources,
  nextGeneration: () => number,
): PriceSnapshot {
  const entries: PriceEntryPayload[] = []
  for (const price of sources.pricing.list()) {
    for (const [field, value] of [
      ['inputPerMillion', price.inputPerMillion],
      ['outputPerMillion', price.outputPerMillion],
      ['cacheReadPerMillion', price.cacheReadPerMillion],
      ['cacheWritePerMillion', price.cacheWritePerMillion],
    ] as const) {
      if (typeof value !== 'string' || !/^[0-9]+(\.[0-9]+)?$/.test(value)) {
        throw new GateFeedError(
          'GATE_FEED_PRICE_INVALID',
          `模型价格 ${price.model} 的 ${field} 不是十进制数字串：${String(value)}`,
        )
      }
    }
    entries.push({
      model: price.model,
      inputPerMillion: price.inputPerMillion,
      outputPerMillion: price.outputPerMillion,
      cacheReadPerMillion: price.cacheReadPerMillion,
      cacheWritePerMillion: price.cacheWritePerMillion,
    })
  }
  entries.sort((left, right) => left.model.localeCompare(right.model))
  return {
    payload: {
      version: 1,
      generation: nextGeneration(),
      revision: hashOf(entries),
      prices: entries,
    },
    count: entries.length,
  }
}

/**
 * 每个 key 的累计消费：只算「配了金额上限」的 key（其余 key Go 侧不判金额）。
 *
 * 数据来源是 `usage`（读取时按当前价格表算费用）：花钱的事实只有 TS 知道，
 * Go 只读、只比大小。用量插件 / api-key 插件缺席时推空快照——
 * Go 侧把它当「没有这个 key 的消费记录」，按未知放行（可用性优先）。
 *
 * **成本护栏**：判「有没有超上限」只需要一个总数，而 `usage.summary()` 是 O(历史行数)
 * 的全表聚合。心跳内容必须每轮都推（generation 递增，Go 按 TTL 判新鲜度），
 * 但**内容可以复用**：用量游标与 key 集合都没变就复用上一轮的结果。
 */
export async function buildKeySpendSnapshot(
  sources: SnapshotSources,
  nextGeneration: () => number,
  cache: SpendCache | undefined,
): Promise<SpendSnapshot> {
  const apiKey = sources.apiKey
  const usage = sources.usage

  // 只有「配了金额上限」的 key 需要算（其余 key Go 侧根本不判金额）。
  let limited: readonly { readonly id: string }[] = []
  if (apiKey !== undefined && usage !== undefined) {
    limited = (await apiKey.listAll()).filter((key) => key.spendingLimitMicros !== null)
  }
  const signature = limited
    .map((key) => key.id)
    .sort()
    .join(',')
  const cursor = usage === undefined || usage.status === undefined ? null : cursorOf(usage.status())

  // 缓存命中：key 集合与用量游标都没变 → 直接复用上一轮算出来的消费总额。
  if (
    cache !== undefined &&
    cursor !== null &&
    cache.cursor === cursor &&
    cache.signature === signature
  ) {
    return {
      payload: {
        version: 1,
        generation: nextGeneration(),
        revision: cache.revision,
        entries: cache.entries,
      },
      limitedKeys: cache.entries.length,
      cached: true,
      cache,
    }
  }

  const entries: KeySpendEntryPayload[] = []
  if (usage !== undefined) {
    for (const key of limited) {
      const summary = usage.summary({
        fromMs: 0,
        toMs: Number.MAX_SAFE_INTEGER,
        apiKeyId: key.id,
      })
      const spent = summary.totals.costMicros
      if (typeof spent !== 'string' || !/^[0-9]+$/.test(spent)) {
        throw new GateFeedError(
          'GATE_FEED_SPEND_INVALID',
          `用量汇总返回的费用不是非负十进制微元：${String(spent)}`,
        )
      }
      entries.push({ keyId: key.id, spentMicros: spent })
    }
  }
  entries.sort((left, right) => left.keyId.localeCompare(right.keyId))
  const revision = hashOf(entries)
  return {
    payload: {
      version: 1,
      generation: nextGeneration(),
      revision,
      entries,
    },
    limitedKeys: entries.length,
    cached: false,
    cache: cursor === null ? undefined : { cursor, signature, entries, revision },
  }
}

/** 内容哈希：快照的 revision（内容相同 → revision 相同，generation 仍递增）。 */
export function hashOf(entries: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 32)
}

/** 用量游标：epoch 变了（gatewayd 重启）也算变，靠它判「有没有新用量」。 */
export function cursorOf(status: { readonly epoch: string | null; readonly lastSeq: number }): string {
  return `${status.epoch ?? ''}:${String(status.lastSeq)}`
}
