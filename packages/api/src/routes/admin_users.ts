/**
 * /api/admin_users 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { assertOnlyKeys, parseIntegerParam, requiredBoolean, requiredInteger, requiredString } from '../params.ts'
import { adminUserOf, parseUserId } from '../views/session.ts'
import { auditActorOf, audited } from '../audit.ts'
import { API_ACTOR } from '../constants.ts'
import { ApiError, badRequest, notFound } from '../errors.ts'
import { IncomingMessage, ServerResponse } from 'node:http'
import type { UserStatusLike } from '../types.ts'
import { requireAdmin } from '../http_session.ts'
import { allowMethod, allowRead, jsonBody, sendJson, sendMethodNotAllowed } from '../http_respond.ts'

// ───────────────────────────────── 管理员：用户 ─────────────────────────────────

export async function routeUsers(host: ApiServer, req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
  const { view: adminView } = await requireAdmin(host, req)
  const actor = auditActorOf(adminView)

  if (parts.length === 1) {
    if (!allowRead(host, req, res)) return
    const query: { status?: UserStatusLike; offset?: number; limit?: number } = {}
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const status = url.searchParams.get('status')
    if (status !== null && status !== '') {
      if (status !== 'enabled' && status !== 'banned') throw badRequest('status 只能是 enabled / banned')
      query.status = status
    }
    const offset = parseIntegerParam(url.searchParams.get('offset'), 'offset', 0, 0, 1_000_000)
    const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 100, 1, 1_000)
    if (offset !== undefined) query.offset = offset
    if (limit !== undefined) query.limit = limit
    const users = await host.runtime.user.list(query)
    sendJson(host, req, res, 200, { items: users.map(adminUserOf) })
    return
  }

  const id = parseUserId(parts[1])
  if (parts.length === 2) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const user = await host.runtime.user.get(id)
      if (user === undefined) throw notFound('没有这个用户')
      sendJson(host, req, res, 200, adminUserOf(user))
      return
    }
    if (req.method === 'PATCH') {
      const body = await jsonBody(host, req)
      assertOnlyKeys(body, ['name', 'role', 'status', 'balanceEnabled', 'concurrencyLimit'])
      const hasName = Object.hasOwn(body, 'name')
      const hasRole = Object.hasOwn(body, 'role')
      const hasStatus = Object.hasOwn(body, 'status')
      const hasBalanceEnabled = Object.hasOwn(body, 'balanceEnabled')
      const hasConcurrency = Object.hasOwn(body, 'concurrencyLimit')
      if (
        !hasName &&
        !hasRole &&
        !hasStatus &&
        !hasBalanceEnabled &&
        !hasConcurrency
      ) {
        throw badRequest('没有可修改的字段')
      }

      const identity = { actor, actorPlugin: API_ACTOR }
      if (hasName) {
        await audited(
          host.runtime,
          identity,
          {
            action: 'user.rename',
            targetType: 'user',
            targetId: String(id),
            summary: `改名用户 #${id}`,
            metadata: { name: requiredString(body, 'name') },
          },
          () => host.runtime.user.rename(API_ACTOR, id, requiredString(body, 'name')),
        )
      }
      if (hasStatus) {
        const status = requiredString(body, 'status')
        if (status !== 'enabled' && status !== 'banned') throw badRequest('status 只能是 enabled / banned')
        await audited(
          host.runtime,
          identity,
          {
            action: 'user.status.set',
            targetType: 'user',
            targetId: String(id),
            summary: `把用户 #${id} 的状态改为 ${status}`,
            metadata: { status },
          },
          () => host.runtime.user.setStatus(API_ACTOR, id, status),
        )
      }
      if (hasRole) {
        const role = requiredString(body, 'role')
        if (role !== 'admin' && role !== 'user') throw badRequest('role 只能是 admin / user')
        const setRole = host.runtime.user.setRole
        if (typeof setRole !== 'function') {
          throw new ApiError(
            'API_USER_ROLE_UNAVAILABLE',
            503,
            '用户插件没有提供 setRole 接口',
          )
        }
        await audited(
          host.runtime,
          identity,
          {
            action: 'user.role.set',
            targetType: 'user',
            targetId: String(id),
            summary: `把用户 #${id} 的角色改为 ${role}`,
            metadata: { role },
          },
          () => setRole.call(host.runtime.user, API_ACTOR, id, role),
        )
      }
      if (hasBalanceEnabled) {
        const enabled = requiredBoolean(body, 'balanceEnabled')
        const setBalanceEnabled = host.runtime.user.setBalanceEnabled
        if (typeof setBalanceEnabled !== 'function') {
          throw new ApiError(
            'API_USER_BALANCE_ENABLED_UNAVAILABLE',
            503,
            '用户插件没有提供 setBalanceEnabled 接口',
          )
        }
        await audited(
          host.runtime,
          identity,
          {
            action: 'user.balance_enabled.set',
            targetType: 'user',
            targetId: String(id),
            summary: `${enabled ? '打开' : '关闭'}用户 #${id} 的余额展示`,
            metadata: { balanceEnabled: enabled },
          },
          () => setBalanceEnabled.call(host.runtime.user, API_ACTOR, id, enabled),
        )
      }
      if (hasConcurrency) {
        // 并发上限：null = 不限；正整数 = 上限。它是运营限流，不动余额、不写流水。
        const limit =
          body.concurrencyLimit === null ? null : requiredInteger(body, 'concurrencyLimit')
        const setConcurrencyLimit = host.runtime.user.setConcurrencyLimit
        if (typeof setConcurrencyLimit !== 'function') {
          throw new ApiError(
            'API_USER_CONCURRENCY_UNAVAILABLE',
            503,
            '用户插件没有提供 setConcurrencyLimit 接口',
          )
        }
        await audited(
          host.runtime,
          identity,
          {
            action: 'user.concurrency.set',
            targetType: 'user',
            targetId: String(id),
            summary:
              limit === null
                ? `取消用户 #${id} 的并发上限`
                : `把用户 #${id} 的并发上限改为 ${String(limit)}`,
            metadata: { concurrencyLimit: limit },
          },
          () => setConcurrencyLimit.call(host.runtime.user, API_ACTOR, id, limit),
        )
      }

      const user = await host.runtime.user.get(id)
      if (user === undefined) throw notFound('没有这个用户')
      sendJson(host, req, res, 200, adminUserOf(user))
      return
    }
    if (req.method === 'DELETE') {
      await audited(
        host.runtime,
        { actor, actorPlugin: API_ACTOR },
        {
          action: 'user.remove',
          targetType: 'user',
          targetId: String(id),
          summary: `删除用户 #${id}`,
        },
        () => host.runtime.user.remove(API_ACTOR, id),
      )
      sendJson(host, req, res, 200, { removed: true })
      return
    }
    sendMethodNotAllowed(host, req, res, ['GET', 'HEAD', 'PATCH', 'DELETE'])
    return
  }

  if (parts.length === 3 && parts[2] === 'balance') {
    if (!allowMethod(host, req, res, ['POST'])) return
    const body = await jsonBody(host, req)
    assertOnlyKeys(body, ['delta', 'reason'])
    const deltaText = requiredString(body, 'delta')
    if (!/^-?\d+$/.test(deltaText)) throw badRequest('delta 必须是十进制整数字符串（最小单位）')
    const reason = requiredString(body, 'reason')
    const balance = await audited(
      host.runtime,
      { actor, actorPlugin: API_ACTOR },
      {
        action: 'user.balance.adjust',
        targetType: 'user',
        targetId: String(id),
        summary: `调整用户 #${id} 的余额（${deltaText} 微元）：${reason}`,
        // 金额一律十进制字符串：变化量走整数最小单位，不经浮点。
        metadata: { deltaMicros: deltaText, reason },
        metadataOf: (after) => ({ balanceAfterMicros: after.toString() }),
      },
      () => host.runtime.user.adjustBalance(API_ACTOR, id, BigInt(deltaText), reason),
    )
    sendJson(host, req, res, 200, { balanceMinor: balance.toString() })
    return
  }

  throw notFound('没有这个用户接口')
}
