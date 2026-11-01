/**
 * `POST /api/accounts/bulk`：上游账号的批量启停 / 批量改字段。
 *
 * ## 为什么单独一个文件
 *
 * 1. 它是一条**独立的新增路由**（旧 SSR 页 `/admin/accounts` 直接调服务方法，一直没暴露成
 *    HTTP；SPA 页面要批量操作就必须有它），与单条 CRUD 的判定顺序没有关系；
 * 2. `routes/admin_accounts.ts` 已经 400+ 行，把这一块塞进去会让它继续膨胀（§5.6）。
 *
 * ## 语义
 *
 * - **逐项成功或失败**（`BulkOperationResult`），不是全有或全无：一个账号坏掉不影响其它条。
 * - **审计一条记账**：`account.bulk_enable` / `account.bulk_disable` / `account.bulk_update`。
 *   批量删除**不在这里** —— 删除是逐条独立审计的高危动作，页面按 `DELETE /api/accounts/:id`
 *   逐条发，不做「一条审计盖掉 N 次删除」。
 * - `enabled` **不许**出现在 `patch` 里：启停走独立通道（服务端 `bulkUpdate` 也会拒），
 *   否则「批量改名字」会顺手把账号全部启用，而审计上看不出来。
 */
import type { ApiServer } from '../http.ts'
import type { AccountAdminPort } from '../types.ts'
import { API_ACTOR } from '../constants.ts'
import { badRequest, ApiError } from '../errors.ts'
import { allowMethod, jsonBody, sendJson } from '../http_respond.ts'
import { audited, type AuditIdentity } from '../audit.ts'
import { normalizeBulkOperation } from '../views/account.ts'
import {
  ACCOUNT_PATCH_FIELDS,
  accountPatchOf,
  assertOnlyKeys,
  isPlainObject,
  readStringArray,
  requiredString,
} from '../params.ts'
import { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 这条路由额外用到的三个批量方法。
 *
 * 刻意**不**把它们声明进 `types.ts` 的 `AccountAdminPort`：那个文件已经超 §5.6 上限
 * （只许缩短不许加长）。这里用交叉类型表达「账号管理端口 + 三个可选批量方法」，
 * 调用方 `requireAccountAdmin()` 的返回值可以直接传进来。
 */
interface AccountBulkMethods {
  bulkEnable?(actor: string, ids: readonly string[]): Promise<unknown>
  bulkDisable?(actor: string, ids: readonly string[]): Promise<unknown>
  bulkUpdate?(actor: string, ids: readonly string[], patch: unknown): Promise<unknown>
}

/** 审计里最多带多少个账号 id（再多只报条数，免得一条审计塞进整页 id）。 */
const MAX_AUDIT_IDS = 20

export async function routeAccountBulk(
  host: ApiServer,
  req: IncomingMessage,
  res: ServerResponse,
  identity: AuditIdentity,
  accountAdmin: AccountAdminPort & AccountBulkMethods,
): Promise<void> {
  if (!allowMethod(host, req, res, ['POST'])) return
  const body = await jsonBody(host, req)
  assertOnlyKeys(body, ['action', 'ids', 'patch'])
  const action = requiredString(body, 'action')
  const ids = readStringArray(body.ids, 'ids')
  if (ids.length === 0) throw badRequest('ids 不能为空')
  const metadata = { count: ids.length, ids: ids.slice(0, MAX_AUDIT_IDS) }

  if (action === 'enable' || action === 'disable') {
    const method = action === 'enable' ? accountAdmin.bulkEnable : accountAdmin.bulkDisable
    if (typeof method !== 'function') {
      throw new ApiError('API_ACCOUNT_BULK_UNAVAILABLE', 503, '账号管理服务不支持批量启停')
    }
    const enabled = action === 'enable'
    const label = enabled ? '启用' : '停用'
    sendJson(
      host,
      req,
      res,
      200,
      normalizeBulkOperation(
        await audited(
          host.runtime,
          identity,
          {
            action: enabled ? 'account.bulk_enable' : 'account.bulk_disable',
            targetType: 'account',
            summary: `批量${label}上游账号 ${String(ids.length)} 个`,
            metadata,
          },
          () => method.call(accountAdmin, API_ACTOR, ids),
        ),
      ),
    )
    return
  }

  if (action === 'update') {
    const bulkUpdate = accountAdmin.bulkUpdate
    if (typeof bulkUpdate !== 'function') {
      throw new ApiError('API_ACCOUNT_BULK_UNAVAILABLE', 503, '账号管理服务不支持批量改字段')
    }
    if (!isPlainObject(body.patch)) throw badRequest('patch 必须是 JSON 对象')
    if (Object.hasOwn(body.patch, 'enabled')) {
      throw badRequest('patch 不能带 enabled：启停请用 action=enable / disable')
    }
    // 客户端档案**不参与批量**：哪个账号挂哪套指纹是一账号一决定（owner 也没要批量挂），
    // 批量把它改成一刀切只会让「这条账号本来能通」悄悄失效。
    if (Object.hasOwn(body.patch, 'clientProfile')) {
      throw badRequest('patch 不能带 clientProfile：客户端档案请逐条账号在编辑弹窗里选')
    }
    assertOnlyKeys(body.patch, ACCOUNT_PATCH_FIELDS)
    const patch = accountPatchOf(body.patch)
    const fields = Object.keys(patch)
    if (fields.length === 0) throw badRequest('patch 至少要声明一个字段')
    sendJson(
      host,
      req,
      res,
      200,
      normalizeBulkOperation(
        await audited(
          host.runtime,
          identity,
          {
            action: 'account.bulk_update',
            targetType: 'account',
            summary: `批量修改上游账号 ${String(ids.length)} 个的字段：${fields.join(' / ')}`,
            metadata: { ...metadata, fields },
          },
          () => bulkUpdate.call(accountAdmin, API_ACTOR, ids, patch),
        ),
      ),
    )
    return
  }

  throw badRequest('action 只能是 enable / disable / update')
}
