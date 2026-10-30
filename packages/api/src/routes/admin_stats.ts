/**
 * /api/admin_stats 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { usageDailyOf, usageModelOf, usageTotalsOf, usageUserOf } from '../views/usage.ts'
import { keyPortResult } from '../views/account.ts'
import { STATS_USER_MAX_PAGES, STATS_USER_PAGE } from '../constants.ts'
import { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiKeyPort, UserLike, UserPort } from '../types.ts'
import { userNameResolver } from './admin_usage.ts'
import { requireAdmin } from '../http_session.ts'
import { allowRead, sendJson } from '../http_respond.ts'

/**
 * `GET /api/admin/stats`：全站计数与 token 汇总。
 *
 * 计数优先用服务的 `count()`；user 的角色 / 状态拆分与 key 的启用拆分需要逐条读，
 * 但 key 的总数绝不为了一个数字加载整表。accountAdmin / apiKey 缺席时对应块全 0，
 * 整个接口照常返回；只有 usage 缺席时 `usage: null`。
 */
export async function adminStats(host: ApiServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  await requireAdmin(host, req)
  if (!allowRead(host, req, res)) return

  const users = await allUsers(host)
  const userPort = host.runtime.user as UserPort & { count?: () => Promise<number> }
  const countedUsers = typeof userPort.count === 'function' ? await userPort.count.call(host.runtime.user) : null
  const userTotal = countedUsers ?? users.length

  const accountAdmin = host.runtime.accountAdmin()
  const accounts = accountAdmin === undefined ? [] : [...(await accountAdmin.list())]

  const apiKey = host.runtime.apiKey()
  const keyPort = apiKey as (ApiKeyPort & { count?: () => Promise<number>; listAll?: () => Promise<unknown> }) | undefined
  let keyTotal: number | null = null
  let keyEnabled = 0
  let keyDisabled = 0
  if (keyPort !== undefined) {
    if (typeof keyPort.count === 'function') {
      try {
        keyTotal = await keyPort.count.call(keyPort)
      } catch {
        keyTotal = null
      }
    }
    if (typeof keyPort.listAll === 'function') {
      try {
        const listed = keyPortResult(await keyPort.listAll.call(keyPort))
        keyEnabled = listed.filter((item) => item.enabled !== false).length
        keyDisabled = listed.length - keyEnabled
        if (keyTotal === null) keyTotal = listed.length
      } catch {
        // key 列表不可读时保留 count()（如果有）或 0，不让整个概览失败。
      }
    }
  }

  const nameOf = userNameResolver(host)
  const usage = host.runtime.usage()
  let usageView: {
    today: ReturnType<typeof usageTotalsOf>
    total: ReturnType<typeof usageTotalsOf>
    series: ReturnType<typeof usageDailyOf>[]
    models: ReturnType<typeof usageModelOf>[]
    topUsers: { userId: number; name: string | null; requests: number; tokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costCents: number; costMicros: string }[]
  } | null = null
  if (usage !== undefined) {
    const stats = usage.stats()
    usageView = {
      today: usageTotalsOf(stats.today),
      total: usageTotalsOf(stats.total),
      series: stats.series.map(usageDailyOf),
      models: stats.models.map(usageModelOf),
      topUsers: await Promise.all(stats.topUsers.map(async (item) => usageUserOf(item, await nameOf(item.userId)))),
    }
  }

  sendJson(host, req, res, 200, {
    generatedAt: host.runtime.now().toISOString(),
    users: {
      total: userTotal,
      admins: users.filter((user) => user.role === 'admin').length,
      enabled: users.filter((user) => user.status === 'enabled').length,
      banned: users.filter((user) => user.status === 'banned').length,
    },
    accounts: {
      total: accounts.length,
      enabled: accounts.filter((account) => account.enabled === true).length,
      disabled: accounts.filter((account) => account.enabled !== true).length,
      needsReauth: accounts.filter((account) => account.status === 'needs_reauth').length,
    },
    keys: {
      total: keyTotal ?? 0,
      enabled: keyEnabled,
      disabled: keyDisabled,
    },
    usage: usageView,
  })
}

/** 分页读完用户表（角色 / 状态拆分要用）；`count()` 只给总数。 */
export async function allUsers(host: ApiServer, ): Promise<UserLike[]> {
  const users: UserLike[] = []
  for (let page = 0; page < STATS_USER_MAX_PAGES; page++) {
    const batch = await host.runtime.user.list({ offset: users.length, limit: STATS_USER_PAGE })
    users.push(...batch)
    if (batch.length < STATS_USER_PAGE) break
  }
  return users
}
