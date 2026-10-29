/**
 * /api/admin_audit 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { parseIntegerParam, queryStringOf } from '../params.ts'
import { API_ACTOR } from '../constants.ts'
import { ApiError, toApiError } from '../errors.ts'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AuditQueryLike } from '../types.ts'

/**
 * `GET /api/admin/audit`：管理员操作审计（只读，时间倒序分页）。
 *
 * 查询参数：
 * - `actor` / `actorPlugin` / `action` / `targetType` / `targetId`：精确匹配；
 * - `from` / `to`：毫秒时间范围，左闭右开；
 * - `limit`（1..200，默认 50）/ `offset`（默认 0）；
 * - `stats=1`：附带汇总（总量 / 今天 / 24 小时 / 失败数 / Top 动作与操作者）。
 *
 * 读权限由审计服务判（`adminPlugins` 白名单，actor 是本插件）。审计服务缺席只让这条
 * 路由 503——**写操作照常成功**，审计是旁路（见 `audit.ts`）。
 */
export async function routeAdminAudit(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
url: URL,
): Promise<void> {
  await host.requireAdmin(req)
  if (!host.allowRead(req, res)) return
  const audit = host.runtime.audit()
  if (audit === undefined) {
    throw new ApiError('AUDIT_UNAVAILABLE', 503, '审计服务不在运行：暂时不能查询审计记录')
  }

  const query: {
    actor?: string
    actorPlugin?: string
    action?: string
    targetType?: string
    targetId?: string
    fromMs?: number
    toMs?: number
    limit?: number
    offset?: number
  } = {}
  for (const key of ['actor', 'actorPlugin', 'action', 'targetType', 'targetId'] as const) {
    const value = queryStringOf(url, key)
    if (value !== undefined) query[key] = value
  }
  const fromMs = parseIntegerParam(url.searchParams.get('from'), 'from', 0, 0, Number.MAX_SAFE_INTEGER)
  if (fromMs !== undefined && fromMs > 0) query.fromMs = fromMs
  const toMs = parseIntegerParam(url.searchParams.get('to'), 'to', 0, 0, Number.MAX_SAFE_INTEGER)
  if (toMs !== undefined && toMs > 0) query.toMs = toMs
  const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 50, 1, 200)
  if (limit !== undefined) query.limit = limit
  const offset = parseIntegerParam(url.searchParams.get('offset'), 'offset', 0, 0, 10_000_000)
  if (offset !== undefined) query.offset = offset

  const page = audit.list(API_ACTOR, query as AuditQueryLike)
  const wantStats = url.searchParams.get('stats') === '1'
  host.sendJson(req, res, 200, {
    items: page.items,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    ...(wantStats ? { stats: audit.stats(API_ACTOR) } : {}),
  })
}

// ───────────────────────────────── 管理员：内容审核 ─────────────────────────────────

/**
 * 管理面内容审核规则：`/api/admin/content-audit`。
 *
 * - `GET` → `{ items, status }`：规则列表 + 推送健康度 + Go 侧命中统计；
 * - `POST` → 新增规则（`pattern` 必填，`action` 默认 `block`）；
 * - `GET|PATCH|DELETE .../<id>` → 读一条 / 改一条 / 删一条（`enabled` 用来启停单条规则）；
 * - `POST .../push` → 立刻推一次（排障用），回 `{ revision }`。
 *
 * 三条纪律：
 * - **规则**的语义校验（长度 / 去重 / 上限 / 控制字符）全在插件里，这里只做形状校验，
 *   插件抛的稳定码由 `toApiError` 映射状态码；
 * - **审计在调用点记**：插件对 `audit` 零依赖，actor 只有这里知道。审计元数据里
 *   **不放 pattern**（关键词是管理面数据，没必要扩散到审计表），只放 id / action / 启停；
 * - 列表与状态是**只读**的，`allowRead` 照旧挡非 GET；`status` 里 Go 侧读不到就是 `null`。
 */
