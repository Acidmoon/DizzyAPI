/**
 * /api/admin_observability 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { ApiError } from '../errors.ts'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { requireAdmin } from '../http_session.ts'
import { allowRead, sendJson } from '../http_respond.ts'

// ───────────────────────────────── 管理员：运维总览 ─────────────────────────────────

/**
 * `GET /api/admin/observability`：运维总览（只读聚合）。
 *
 * 返回 `observability` 插件现算的报告：六块事实 + 每块的**数据源健康度**
 * （`ok` / `degraded` / `unavailable` + 人话原因）+ 异常摘要 `warnings`。
 *
 * 两条纪律：
 * - **单块数据源缺失不是 HTTP 错误**：报告里标 `degraded`，接口照常 200；
 *   只有聚合插件本身不在运行时才 503（`OBSERVABILITY_UNAVAILABLE`）。
 * - 金额一律十进制字符串（整数微元），报告里没有 bigint；账号 id / label / baseUrl
 *   与任何秘密都不出现。
 */
export async function routeAdminObservability(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
): Promise<void> {
  await requireAdmin(host, req)
  if (!allowRead(host, req, res)) return
  const observability = host.runtime.observability()
  if (observability === undefined) {
    throw new ApiError(
      'OBSERVABILITY_UNAVAILABLE',
      503,
      '运维总览服务不在运行：暂时看不到聚合状态',
    )
  }
  sendJson(host, req, res, 200, await observability.observe())
}
