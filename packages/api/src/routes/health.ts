/**
 * /api/health 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { priorityState } from '../views/catalog.ts'
import { API_VERSION } from '../constants.ts'
import type { GatewayComponentHealth, GatewayHealthState, GatewayHealthView } from '../types.ts'

export async function health(host: ApiServer, ): Promise<GatewayHealthView> {
  const components: GatewayComponentHealth[] = [
    { name: 'api', state: 'ok', detail: `listen 127.0.0.1:${host.port}` },
    { name: 'auth', state: 'ok' },
  ]

  try {
    await host.runtime.user.list({ limit: 1 })
    components.push({ name: 'user', state: 'ok' })
  } catch {
    components.push({ name: 'user', state: 'down', detail: '读取用户表失败' })
  }

  const frontend = host.runtime.frontend()
  if (frontend === undefined) {
    // 只有确认「新前端 web 在跑」时，旧 SPA 未启用才算正常；否则仍是缺失。
    const web = host.runtime.web()
    components.push(web === undefined
      ? { name: 'frontend', state: 'degraded', detail: '服务不在运行' }
      : { name: 'frontend', state: 'ok', detail: '旧 SPA 未启用（由 web 接管）' })
  } else {
    try {
      const current = await frontend.current()
      components.push({
        name: 'frontend',
        state: current === null ? 'degraded' : 'ok',
        ...(current === null ? { detail: '没有安装前端资源' } : { detail: `asset ${current.version}` }),
      })
    } catch {
      components.push({ name: 'frontend', state: 'down', detail: '前端宿主不可用' })
    }
  }

  const catalog = host.runtime.catalog()
  if (catalog === undefined) {
    components.push({ name: 'catalog', state: 'degraded', detail: '服务不在运行' })
  } else {
    try {
      const snapshot = await catalog.query({ includeUnavailable: false })
      components.push({ name: 'catalog', state: 'ok', detail: `${snapshot.plugins.length} 个活动插件` })
    } catch {
      components.push({ name: 'catalog', state: 'down', detail: '能力目录不可用' })
    }
  }

  components.push(
    host.runtime.accountAdmin() === undefined
      ? { name: 'account-admin', state: 'degraded', detail: '服务不在运行' }
      : { name: 'account-admin', state: 'ok' },
  )

  let bridge: GatewayHealthView['bridge'] = { connected: false, transport: null, address: null }
  const priority = host.runtime.accountPriority()
  if (priority === undefined) {
    components.push({ name: 'account-priority', state: 'degraded', detail: '服务不在运行' })
  } else {
    try {
      const status = await priority.status()
      bridge = {
        connected: status.bridgeConnected === true,
        transport: status.transport ?? null,
        address: status.address ?? null,
      }
      components.push({
        name: 'account-priority',
        state: priorityState(status.state),
        detail: `state=${status.state} revision=${status.revision ?? '—'} accounts=${status.accounts}`,
      })
    } catch {
      components.push({ name: 'account-priority', state: 'down', detail: '状态查询失败' })
    }
  }

  const state: GatewayHealthState = components.some((component) => component.state === 'down')
    ? 'down'
    : components.some((component) => component.state === 'degraded')
      ? 'degraded'
      : 'ok'

  return {
    state,
    at: host.runtime.now().toISOString(),
    version: API_VERSION,
    uptimeSec: host.runtime.uptimeSec(),
    descriptorRevision: null,
    bridge,
    components,
  }
}

// ───────────────────────────────── 内部工具 ─────────────────────────────────
