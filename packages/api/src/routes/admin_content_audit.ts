/**
 * /api/admin_content_audit 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { assertOnlyKeys } from '../params.ts'
import {
  contentAuditInputOf,
  contentAuditPatchOf,
  contentAuditRuleMetadata,
  contentAuditRuleOf,
  contentAuditStatusOf,
} from '../views/audit.ts'
import { auditActorOf, audited } from '../audit.ts'
import { API_ACTOR } from '../constants.ts'
import { notFound, toApiError } from '../errors.ts'
import { IncomingMessage, ServerResponse } from 'node:http'
import type { ContentAuditRuleLike } from '../types.ts'
import { requireAdmin } from '../http_session.ts'
import { allowMethod, allowRead, jsonBody, sendJson, sendMethodNotAllowed } from '../http_respond.ts'

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
export async function routeAdminContentAudit(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
parts: readonly string[],
): Promise<void> {
  const { view: adminView } = await requireAdmin(host, req)
  const identity = { actor: auditActorOf(adminView), actorPlugin: API_ACTOR }
  const contentAudit = host.requireContentAudit()

  if (parts.length === 2) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!allowRead(host, req, res)) return
      const rules = contentAudit.list(API_ACTOR)
      sendJson(host, req, res, 200, {
        items: rules.map(contentAuditRuleOf),
        status: contentAuditStatusOf(await contentAudit.status()),
      })
      return
    }
    if (req.method === 'POST') {
      const body = await jsonBody(host, req)
      assertOnlyKeys(body, ['pattern', 'action', 'category', 'enabled', 'note'])
      const input = contentAuditInputOf(body)
      const rule = await audited<ContentAuditRuleLike>(
        host.runtime,
        identity,
        {
          action: 'content_audit.rule.create',
          targetType: 'content-audit-rule',
          summary: `新增内容审核规则（${input.action === 'log' ? 'log' : 'block'}）`,
          metadataOf: (created) => contentAuditRuleMetadata(created),
        },
        () => contentAudit.create(API_ACTOR, input),
      )
      sendJson(host, req, res, 200, { rule: contentAuditRuleOf(rule) })
      return
    }
    sendMethodNotAllowed(host, req, res, ['GET', 'HEAD', 'POST'])
    return
  }

  // `push` 是固定子路径；规则 id 一律是 `car_` 前缀，不会撞车。
  if (parts.length === 3 && parts[2] === 'push') {
    if (!allowMethod(host, req, res, ['POST'])) return
    sendJson(host, req, res, 200, { revision: await contentAudit.pushNow() })
    return
  }

  if (parts.length === 3) {
    const id = parts[2] as string
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!allowRead(host, req, res)) return
      const rule = contentAudit.get(API_ACTOR, id)
      if (rule === null) throw notFound('没有这条内容审核规则')
      sendJson(host, req, res, 200, { rule: contentAuditRuleOf(rule) })
      return
    }
    if (req.method === 'PATCH') {
      const body = await jsonBody(host, req)
      assertOnlyKeys(body, ['pattern', 'action', 'category', 'enabled', 'note'])
      const patch = contentAuditPatchOf(body)
      const rule = await audited<ContentAuditRuleLike>(
        host.runtime,
        identity,
        {
          action: 'content_audit.rule.update',
          targetType: 'content-audit-rule',
          targetId: id,
          summary: '修改内容审核规则',
          metadata: { fields: Object.keys(patch) },
          metadataOf: (updated) => contentAuditRuleMetadata(updated),
        },
        () => contentAudit.update(API_ACTOR, id, patch),
      )
      sendJson(host, req, res, 200, { rule: contentAuditRuleOf(rule) })
      return
    }
    if (req.method === 'DELETE') {
      const removed = await audited<boolean>(
        host.runtime,
        identity,
        {
          action: 'content_audit.rule.delete',
          targetType: 'content-audit-rule',
          targetId: id,
          summary: '删除内容审核规则',
        },
        () => contentAudit.remove(API_ACTOR, id),
      )
      sendJson(host, req, res, 200, { removed })
      return
    }
    sendMethodNotAllowed(host, req, res, ['GET', 'HEAD', 'PATCH', 'DELETE'])
    return
  }

  throw notFound('没有这个内容审核接口')
}
