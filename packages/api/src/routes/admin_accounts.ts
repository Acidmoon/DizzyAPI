/**
 * /api/admin_accounts 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { accountCredentialOf, assertOnlyKeys, isPlainObject, nullableString, nullableStringArray, nullableStringMap, optionalInteger, optionalString, optionalStringArray, optionalStringMap, parseIntegerParam, requiredBoolean, requiredString } from '../params.ts'
import { accountOf, normalizeBulkImport } from '../views/account.ts'
import { auditActorOf, audited } from '../audit.ts'
import { API_ACTOR } from '../constants.ts'
import { ApiError, badRequest, notFound } from '../errors.ts'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { requireAdmin } from '../http_session.ts'
import { allowMethod, jsonBody, sendJson, sendMethodNotAllowed } from '../http_respond.ts'

// ───────────────────────────────── 管理员：上游账号 ─────────────────────────────────

export async function routeAccounts(host: ApiServer, req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
  const { view: adminView } = await requireAdmin(host, req)
  const identity = { actor: auditActorOf(adminView), actorPlugin: API_ACTOR }
  const accountAdmin = host.requireAccountAdmin()

  if (parts.length === 1) {
    if (req.method === 'POST') {
      const create = accountAdmin.create
      if (typeof create !== 'function') {
        throw new ApiError('API_ACCOUNT_CREATE_UNAVAILABLE', 503, '账号管理服务不支持新建账号')
      }
      const body = await jsonBody(host, req)
      assertOnlyKeys(body, [
        'provider',
        'kind',
        'label',
        'email',
        'subject',
        'baseUrl',
        'protocol',
        'models',
        'modelMap',
        'priority',
        'enabled',
        'credential',
      ])
      const provider = requiredString(body, 'provider')
      const kind = requiredString(body, 'kind')
      const label = requiredString(body, 'label')
      const email = optionalString(body, 'email')
      const subject = optionalString(body, 'subject')
      const baseUrl = optionalString(body, 'baseUrl')
      const protocol = optionalString(body, 'protocol')
      const models = optionalStringArray(body, 'models')
      const modelMap = optionalStringMap(body, 'modelMap')
      const priority = optionalInteger(body, 'priority', 0, 1000)
      const enabled = body.enabled === undefined ? undefined : requiredBoolean(body, 'enabled')
      const credential = accountCredentialOf(body.credential)
      const input = {
        provider,
        kind,
        label,
        ...(email === undefined ? {} : { email }),
        ...(subject === undefined ? {} : { subject }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(protocol === undefined ? {} : { protocol }),
        ...(models === undefined ? {} : { models }),
        ...(modelMap === undefined ? {} : { modelMap }),
        ...(priority === undefined ? {} : { priority }),
        ...(enabled === undefined ? {} : { enabled }),
        ...(credential === undefined ? {} : { credential }),
      }
      sendJson(host, 
        req,
        res,
        200,
        accountOf(
          await audited(
            host.runtime,
            identity,
            {
              action: 'account.create',
              targetType: 'account',
              summary: `新建上游账号 ${label}`,
              metadata: { provider, kind },
              metadataOf: (account) => ({ accountId: accountOf(account).id }),
            },
            () => create.call(accountAdmin, API_ACTOR, input),
          ),
        ),
      )
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendMethodNotAllowed(host, req, res, ['GET', 'HEAD', 'POST'])
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const provider = url.searchParams.get('provider') ?? undefined
    const status = url.searchParams.get('status') ?? undefined
    const cursor = parseIntegerParam(url.searchParams.get('cursor'), 'cursor', 0, 0, 1_000_000)
    const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 50, 1, 200)
    const all = await accountAdmin.list({
      ...(provider === undefined || provider === '' ? {} : { provider }),
      ...(status === undefined || status === '' ? {} : { status }),
    })
    const offset = cursor ?? 0
    const size = limit ?? 50
    const page = all.slice(offset, offset + size)
    sendJson(host, req, res, 200, {
      items: page.map(accountOf),
      nextCursor: offset + size < all.length ? String(offset + size) : null,
    })
    return
  }

  if (parts.length === 2 && parts[1] === 'import') {
    if (!allowMethod(host, req, res, ['POST'])) return
    const body = await jsonBody(host, req)
    // body 里有 `source` 时按 new-api / sub2api / 纯 key 的来源格式导入；否则沿用逐项格式。
    if (Object.hasOwn(body, 'source')) {
      const importSource = accountAdmin.importSource
      if (typeof importSource !== 'function') {
        throw new ApiError('API_ACCOUNT_IMPORT_UNAVAILABLE', 503, '账号管理服务不支持按来源导入')
      }
      assertOnlyKeys(body, ['source', 'payload', 'defaults'])
      const source = requiredString(body, 'source')
      const payload = requiredString(body, 'payload')
      const defaults = Object.hasOwn(body, 'defaults') ? body.defaults : undefined
      const input = { source, payload, ...(defaults === undefined ? {} : { defaults }) }
      sendJson(host, 
        req,
        res,
        200,
        normalizeBulkImport(
          await audited(
            host.runtime,
            identity,
            {
              action: 'account.import',
              targetType: 'account',
              summary: `按来源批量导入上游账号（${source}）`,
              // 只记来源格式与选项，**绝不记 payload**（里面是 key / 凭据）。
              metadata: { source, hasDefaults: defaults !== undefined },
            },
            () => importSource.call(accountAdmin, API_ACTOR, input),
          ),
        ),
      )
      return
    }
    const bulk = accountAdmin.importAccounts
    if (typeof bulk !== 'function') {
      throw new ApiError('API_ACCOUNT_IMPORT_UNAVAILABLE', 503, '账号管理服务不支持批量导入')
    }
    sendJson(host, 
      req,
      res,
      200,
      normalizeBulkImport(
        await audited(
          host.runtime,
          identity,
          {
            action: 'account.import',
            targetType: 'account',
            summary: '批量导入上游账号（逐项格式）',
          },
          () => bulk.call(accountAdmin, API_ACTOR, body),
        ),
      ),
    )
    return
  }

  if (parts.length === 3 && parts[1] === 'import' && parts[2] === 'preview') {
    if (!allowMethod(host, req, res, ['POST'])) return
    const body = await jsonBody(host, req)
    if (Object.hasOwn(body, 'source')) {
      const previewSource = accountAdmin.previewImportSource
      if (typeof previewSource !== 'function') {
        throw new ApiError('API_ACCOUNT_IMPORT_UNAVAILABLE', 503, '账号管理服务不支持按来源导入')
      }
      assertOnlyKeys(body, ['source', 'payload', 'defaults'])
      const source = requiredString(body, 'source')
      const payload = requiredString(body, 'payload')
      const defaults = Object.hasOwn(body, 'defaults') ? body.defaults : undefined
      const input = { source, payload, ...(defaults === undefined ? {} : { defaults }) }
      sendJson(host, req, res, 200, previewSource.call(accountAdmin, input))
      return
    }
    const preview = accountAdmin.previewImport
    if (typeof preview !== 'function') {
      throw new ApiError('API_ACCOUNT_IMPORT_UNAVAILABLE', 503, '账号管理服务不支持导入预检')
    }
    sendJson(host, req, res, 200, preview.call(accountAdmin, body))
    return
  }

  const id = parts[1] as string
  if (parts.length === 2) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      sendJson(host, req, res, 200, accountOf(await accountAdmin.get(id)))
      return
    }
    if (req.method === 'PATCH') {
      const body = await jsonBody(host, req)
      assertOnlyKeys(body, [
        'label',
        'email',
        'subject',
        'baseUrl',
        'protocol',
        'models',
        'modelMap',
        'priority',
        'enabled',
      ])
      const hasMeta =
        Object.hasOwn(body, 'label') ||
        Object.hasOwn(body, 'email') ||
        Object.hasOwn(body, 'subject') ||
        Object.hasOwn(body, 'baseUrl') ||
        Object.hasOwn(body, 'protocol') ||
        Object.hasOwn(body, 'models') ||
        Object.hasOwn(body, 'modelMap') ||
        Object.hasOwn(body, 'priority')
      const hasEnabled = Object.hasOwn(body, 'enabled')
      if (!hasMeta && !hasEnabled) throw badRequest('没有可修改的字段')

      if (hasMeta) {
        const patch: {
          label?: string
          email?: string | null
          subject?: string | null
          baseUrl?: string | null
          protocol?: string | null
          models?: string[] | null
          modelMap?: Record<string, string> | null
          priority?: number
        } = {}
        if (Object.hasOwn(body, 'label')) patch.label = requiredString(body, 'label')
        if (Object.hasOwn(body, 'email')) patch.email = nullableString(body, 'email')
        if (Object.hasOwn(body, 'subject')) patch.subject = nullableString(body, 'subject')
        if (Object.hasOwn(body, 'baseUrl')) patch.baseUrl = nullableString(body, 'baseUrl')
        if (Object.hasOwn(body, 'protocol')) patch.protocol = nullableString(body, 'protocol')
        if (Object.hasOwn(body, 'models')) patch.models = nullableStringArray(body, 'models')
        if (Object.hasOwn(body, 'modelMap')) patch.modelMap = nullableStringMap(body, 'modelMap')
        if (Object.hasOwn(body, 'priority')) patch.priority = optionalInteger(body, 'priority', 0, 1000)
        await audited(
          host.runtime,
          identity,
          {
            action: 'account.update',
            targetType: 'account',
            targetId: id,
            summary: `修改上游账号 ${id} 的字段：${Object.keys(patch).join(' / ')}`,
            metadata: { fields: Object.keys(patch) },
          },
          () => accountAdmin.update(API_ACTOR, id, patch),
        )
      }
      if (hasEnabled) {
        const enabled = requiredBoolean(body, 'enabled')
        await audited(
          host.runtime,
          identity,
          {
            action: enabled ? 'account.enable' : 'account.disable',
            targetType: 'account',
            targetId: id,
            summary: `${enabled ? '启用' : '停用'}上游账号 ${id}`,
            metadata: { enabled },
          },
          () => (enabled ? accountAdmin.enable(API_ACTOR, id) : accountAdmin.disable(API_ACTOR, id)),
        )
      }
      sendJson(host, req, res, 200, accountOf(await accountAdmin.get(id)))
      return
    }
    if (req.method === 'DELETE') {
      await audited(
        host.runtime,
        identity,
        {
          action: 'account.remove',
          targetType: 'account',
          targetId: id,
          summary: `删除上游账号 ${id}`,
        },
        () => accountAdmin.remove(API_ACTOR, id),
      )
      sendJson(host, req, res, 200, { removed: true })
      return
    }
    sendMethodNotAllowed(host, req, res, ['GET', 'HEAD', 'PATCH', 'DELETE'])
    return
  }

  if (parts.length === 3 && parts[2] === 'test') {
    if (!allowMethod(host, req, res, ['POST'])) return
    const testConnection = accountAdmin.testConnection
    if (typeof testConnection !== 'function') {
      throw new ApiError('API_ACCOUNT_TEST_UNAVAILABLE', 503, '账号管理服务不支持连通性测试')
    }
    const body = await jsonBody(host, req)
    assertOnlyKeys(body, ['model', 'protocol'])
    const model = optionalString(body, 'model')
    const protocol = optionalString(body, 'protocol')
    const input = {
      ...(model === undefined ? {} : { model }),
      ...(protocol === undefined ? {} : { protocol }),
    }
    sendJson(host, req, res, 200, await testConnection.call(accountAdmin, id, input))
    return
  }

  if (parts.length === 3 && parts[2] === 'credentials') {
    if (!allowMethod(host, req, res, ['POST'])) return
    const importCredentials = accountAdmin.importCredentials
    if (typeof importCredentials !== 'function') {
      throw new ApiError('API_ACCOUNT_IMPORT_UNAVAILABLE', 503, '账号管理服务不支持导入凭据')
    }
    const body = await jsonBody(host, req)
    const payload = body.payload
    if (typeof payload !== 'string' && !isPlainObject(payload)) {
      throw badRequest('payload 必须是字符串或 JSON 对象')
    }
    const format = optionalString(body, 'format')
    const input = { payload, ...(format === undefined ? {} : { format }) }
    sendJson(host, 
      req,
      res,
      200,
      accountOf(
        await audited(
          host.runtime,
          identity,
          {
            action: 'account.import_credentials',
            targetType: 'account',
            targetId: id,
            summary: `为上游账号 ${id} 导入凭据`,
            // 只记格式；**payload 里是凭据，绝不进审计**。
            metadata: { format: format ?? 'auto' },
          },
          () => importCredentials.call(accountAdmin, API_ACTOR, id, input),
        ),
      ),
    )
    return
  }

  throw notFound('没有这个账号接口')
}
