/**
 * 页面渲染 / 动作测试的共用夹具：**不起 HTTP**，直接给页面模块喂一个 `PageContext`。
 *
 * 为什么不用真 HTTP：这些用例要验的是「页面拿到什么、写出去什么」，不是路由与鉴权
 * （那些在 `web.test.ts` / `admin-accounts.test.ts` 里用真服务验）。直接调页面模块
 * 少一半样板、也不抢端口。
 *
 * 只放**夹具**，不放断言：断言留在各页自己的测试文件里。
 */
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import type { ActionContext, PageContext, PageModule } from '../../src/layout.ts'
import type { AuditEntryView, AuditLike, SessionView, WebRuntime } from '../../src/runtime.ts'

/** 管理员会话（管理台页面都要求 `role: 'admin'`）。 */
export const ADMIN_SESSION: SessionView = {
  sessionId: 'session-1',
  userId: 7,
  user: {
    id: 7,
    name: 'root',
    status: 'enabled',
    role: 'admin',
    balance: 2_500_000n,
    balanceEnabled: true,
    concurrencyLimit: null,
    avatar: null,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
  },
  expiresAt: '2099-10-19T00:00:00.000Z',
}

/** 所有端口都是 `undefined` 的服务表；用例按需替换自己关心的那几个。 */
export function emptyServices(): WebRuntime {
  return {
    user: undefined,
    auth: undefined,
    apiKey: undefined,
    usage: undefined,
    pricing: undefined,
    modelhub: undefined,
    settings: undefined,
    catalog: undefined,
    accountAdmin: undefined,
    redeem: undefined,
    billing: undefined,
    topup: undefined,
    fontSmiley: undefined,
    audit: undefined,
    observability: undefined,
    contentAudit: undefined,
    gateFeed: undefined,
  }
}

let templatePromise: Promise<PageTemplateService> | undefined

/** 模板服务是纯服务（不起 HTTP、不读写存储），整个测试进程共用一个就够。 */
export async function templateOf(): Promise<PageTemplateService> {
  templatePromise ??= (async () => {
    const ctx = new Context()
    await ctx.plugin(PageTemplateService)
    return ctx.get('pageTemplate') as PageTemplateService
  })()
  return templatePromise
}

export function pageContext(
  module: PageModule,
  services: WebRuntime,
  template: PageTemplateService,
  query = '',
): PageContext {
  return {
    path: module.path,
    title: module.title,
    query: new URLSearchParams(query),
    user: ADMIN_SESSION,
    t: template,
    services,
    notice: null,
    // 界面偏好 CSS（字号 / 字距）：默认站值 = 空串，页面就不引用主题表。
    themeCss: '',
    // 侧栏顺序：默认站顺序（空数组 = 不覆盖任何一项）。
    navOrder: [],
    takeSecret: () => undefined,
  }
}

export function actionContext(
  module: PageModule,
  services: WebRuntime,
  template: PageTemplateService,
  form: string,
  query = '',
): ActionContext {
  return {
    ...pageContext(module, services, template, query),
    form: new URLSearchParams(form),
    cookieName: 'dizzyapi_session',
    secure: false,
    token: 'token-1',
    setCookie: () => undefined,
    stashSecret: () => 'stashed-secret-id',
  }
}

/** 渲染一页（`query` 是查询串，例如 `edit=k1`）。 */
export async function renderPage(module: PageModule, services: WebRuntime, query = ''): Promise<string> {
  return module.render(pageContext(module, services, await templateOf(), query))
}

/** 直接跑一个页面动作，返回它给出的 303 目标地址。 */
export async function runAction(
  module: PageModule,
  services: WebRuntime,
  name: string,
  form: string,
  query = '',
): Promise<string> {
  const action = module.actions?.[name]
  assert.ok(action !== undefined, `页面 ${module.path} 没有动作 ${name}`)
  return action(actionContext(module, services, await templateOf(), form, query))
}

/** 审计桩：只记 `record`，`list` / `stats` 调用即失败（用例不该用到它们）。 */
export function auditSpy(): AuditLike & { readonly entries: AuditEntryView[] } {
  const entries: AuditEntryView[] = []
  return {
    entries,
    record(entry) {
      entries.push(entry)
      return undefined
    },
    list() {
      throw new Error('这个桩不提供 list')
    },
    stats() {
      throw new Error('这个桩不提供 stats')
    },
  }
}
