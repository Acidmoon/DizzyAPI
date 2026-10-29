/**
 * /api/settings 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { assertOnlyKeys, isPlainObject, optionalString } from '../params.ts'
import { catalogState } from '../views/catalog.ts'
import { auditActorOf, audited } from '../audit.ts'
import { API_ACTOR } from '../constants.ts'
import { ApiError, badRequest, notFound } from '../errors.ts'
import { IncomingMessage, ServerResponse } from 'node:http'
import type { CatalogModuleView, CatalogPort, FrontendPageLike } from '../types.ts'
import { requireAdmin } from '../http_session.ts'
import { allowRead, jsonBody, sendJson, sendMethodNotAllowed } from '../http_respond.ts'

export async function routeSettings(host: ApiServer, req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
  const { view: adminView } = await requireAdmin(host, req)
  const identity = { actor: auditActorOf(adminView), actorPlugin: API_ACTOR }

  if (parts.length === 1) {
    if (!allowRead(host, req, res)) return
    const settings = host.requireSettings()
    const described = await settings.describe()
    // 新 settings 直接返回 `{ namespaces }`；旧实现返回数组。两种都接住。
    const namespaces = Array.isArray(described)
      ? described
      : isPlainObject(described) && Array.isArray(described.namespaces)
        ? described.namespaces
        : null
    if (namespaces === null) {
      throw new ApiError('API_RESPONSE_INVALID', 502, '设置服务返回了无法识别的描述')
    }
    sendJson(host, req, res, 200, { namespaces })
    return
  }

  const ns = parts[1] as string
  if (parts.length === 2) {
    if (req.method === 'POST') {
      const settings = host.requireSettings()
      const body = await jsonBody(host, req)
      assertOnlyKeys(body, ['patch', 'expectedRevision'])
      if (!isPlainObject(body.patch)) throw badRequest('patch 必须是对象')
      const expectedRevision = optionalString(body, 'expectedRevision')
      const patch = body.patch as Record<string, unknown>
      const updated = await audited(
        host.runtime,
        identity,
        {
          action: 'settings.write',
          targetType: 'settings',
          targetId: ns,
          summary: `修改设置 ${ns}：${Object.keys(patch).join(' / ')}`,
          // 只记字段名：设置里可能有 pass / 授权码之类，值不进审计。
          metadata: { fields: Object.keys(patch), expectedRevision: expectedRevision ?? null },
        },
        () => settings.update(API_ACTOR, ns, patch, expectedRevision),
      )
      sendJson(host, req, res, 200, updated)
      return
    }
    if (req.method === 'DELETE') {
      const settings = host.requireSettings()
      const reset = await audited(
        host.runtime,
        identity,
        {
          action: 'settings.reset',
          targetType: 'settings',
          targetId: ns,
          summary: `把设置 ${ns} 重置为 app.yml 的基线`,
        },
        () => settings.reset(API_ACTOR, ns),
      )
      sendJson(host, req, res, 200, reset)
      return
    }
    sendMethodNotAllowed(host, req, res, ['POST', 'DELETE'])
    return
  }

  throw notFound('没有这个设置接口')
}

// ───────────────────────────────── 管理员：目录与设置 ─────────────────────────────────

export async function catalogModules(
host: ApiServer,
catalog: CatalogPort,
): Promise<{ generatedAt: string; modules: readonly CatalogModuleView[] }> {
  // 禁用模块也要列出来（便于排障）；它们是 disabled，不会被当成 available。
  const result = await catalog.query({ includeUnavailable: true })
  let pages: readonly FrontendPageLike[] = []
  try {
    pages = host.runtime.frontend()?.pages() ?? []
  } catch {
    pages = []
  }
  const modules = result.plugins.map((plugin) => {
    const manifest = plugin.manifest as { description?: unknown } | undefined
    const capabilities = Array.isArray(plugin.capabilities) ? plugin.capabilities : []
    return {
      id: plugin.id,
      package: plugin.package,
      kind: plugin.kind,
      state: catalogState(plugin.disabled ? 'disabled' : plugin.state),
      version: null,
      description: typeof manifest?.description === 'string' ? manifest.description : null,
      provides: [...capabilities],
      pages: pages
        .filter((page) => page.owner === plugin.id || page.owner === plugin.package)
        .map((page) => page.path),
    }
  })
  return { generatedAt: result.generatedAt, modules }
}
