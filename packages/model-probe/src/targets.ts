/**
 * 「这一轮要探哪些模型」与「停摆原因怎么判」——两块纯逻辑，不碰存储与网络。
 *
 * 抽出来的原因：这两块是本插件里**唯一有判断**的地方，放进 service 里会被
 * 编排代码埋掉，也没法单独测。
 */
import type { ModelHubSeam } from './seams.ts'
import type { ModelProbeBlockedReason } from './types.ts'

export interface CatalogTargets {
  readonly models: readonly string[]
  /** 目录里一个模型都没有（多半是没配价格 / 没配账号）。 */
  readonly emptyCatalog: boolean
}

/**
 * 从模型目录里挑出要探的模型。
 *
 * 只取**有账号声明**的（`accountCount > 0`）：没有任何账号提供的模型根本路由不到，
 * 探它只会得到 `MODEL_NOT_SERVED`；而那种「不可用」`modelhub` 已经用 `no_account`
 * 说清楚了，不必再花一次请求去重复。
 *
 * 白名单（`probeModels`）里出现目录中没有的名字不是错误 —— 那个模型可能还没账号提供。
 */
export function pickTargets(
  catalog: ReturnType<ModelHubSeam['catalog']>,
  whitelist: readonly string[],
): CatalogTargets {
  const names = new Set<string>()
  for (const entry of catalog.available) if (entry.accountCount > 0) names.add(entry.model)
  for (const entry of catalog.unavailable) if (entry.accountCount > 0) names.add(entry.model)

  const models = whitelist.length === 0 ? [...names].sort() : whitelist.filter((model) => names.has(model)).sort()
  return { models, emptyCatalog: catalog.available.length === 0 && catalog.unavailable.length === 0 }
}

/** 一轮结束时该挂哪个停摆原因；`null` = 正常。 */
export interface BlockVerdict {
  readonly reason: ModelProbeBlockedReason
  readonly detail: string
}

/**
 * 根据「这一轮里出现过的探测侧错误码」决定停摆原因。
 *
 * 顺序有意义：余额问题排在 key 问题前面 —— 两者都会 402/401，但余额是更常见的那个，
 * 而且给的处置建议完全不同（去充值 vs 去重建 key）。
 */
export function decideBlocked(
  codes: ReadonlySet<string>,
  context: { readonly probeUserId: number; readonly gatewayBaseUrl: string },
): BlockVerdict {
  if (codes.has('INSUFFICIENT_BALANCE')) {
    return {
      reason: 'probe_user_balance_exhausted',
      detail:
        `探测用户 #${String(context.probeUserId)} 余额不足（402 INSUFFICIENT_BALANCE），探测已停摆；` +
        '这不是模型故障',
    }
  }
  if (codes.has('API_KEY_EXPIRED') || codes.has('API_KEY_INVALID') || codes.has('API_KEY_SPENDING_LIMIT')) {
    return { reason: 'probe_key_rejected', detail: `探测 key 被网关拒绝（${[...codes].join(' / ')}）` }
  }
  if (codes.has('gateway_unreachable') || codes.has('probe_timeout')) {
    return { reason: 'gateway_unreachable', detail: `连不上探测目标网关 ${context.gatewayBaseUrl}` }
  }
  return {
    reason: 'probe_key_rejected',
    detail: `本轮过半探测失败于探测侧原因：${[...codes].slice(0, 5).join(' / ')}`,
  }
}
