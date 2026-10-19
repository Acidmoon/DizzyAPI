/**
 * 页面 / 设置卡 / 插槽清单。
 *
 * 清单是**数据**，不是前端代码：某个插件的页面与设置卡由它自己的条目声明，
 * 前端只按 owner 与「当前启用的插件集合」过滤。插件被禁用时，它的条目自动消失，
 * 不需要改前端（AGENTS.md D13、D5）。
 *
 * 贡献来源有两种：
 * 1. 内置静态清单（下面的 `BUILT_IN_CONTRIBUTIONS`），owner 是包名；
 * 2. 运行期 `frontend.registerContributions(owner, bundle)`，调用方用 `ctx.effect()`
 *    把 disposer 挂在自己身上，插件卸载时条目一起消失。其他插件应当用**可选注入**
 *    取 `frontend`，不要写进 `static inject`——前端被禁用不该让业务插件停在 PENDING。
 */
import { createHash } from 'node:crypto'
import { isFrontendError, FrontendError } from './errors.ts'

export const CORE_OWNER = '@dizzyapi/plugin-frontend'
export const MANIFEST_SCHEMA_VERSION = 1

export type FrontendArea = 'console' | 'admin'

export interface FrontendAreaInfo {
  readonly label: string
  readonly root: string
  readonly description: string
}

export type PageView =
  | { readonly kind: 'overview'; readonly flavor: FrontendArea }
  | { readonly kind: 'usage' }
  | { readonly kind: 'keys' }
  | { readonly kind: 'topup' }
  | { readonly kind: 'redirect'; readonly to: string }
  | { readonly kind: 'accounts' }
  | { readonly kind: 'users' }
  | { readonly kind: 'profile' }
  | { readonly kind: 'catalog' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'placeholder'; readonly note: string }
  /** 由插件自己的同源 ESM 模块挂载；模块默认导出 `mount(root, context)`。 */
  | { readonly kind: 'remote'; readonly module: string; readonly exportName?: string }

export interface FrontendPage {
  readonly id: string
  /** 贡献者的包名或 app.yml entry id；`core` 例外，永远可见。 */
  readonly owner: string
  readonly area: FrontendArea
  /** 完整路由路径，例如 `/admin/accounts`；允许 `:id` 形式的段。 */
  readonly path: string
  readonly title: string
  /** 导航显示的短标签；省略时用 title。 */
  readonly nav: string
  /** 侧栏图标名；前端只认识一小组内置线稿图标，未知值回退成圆点。 */
  readonly icon?: string
  /** 不进入侧栏导航（例如 `/console` → `/console/usage` 的别名页、个人资料页）。 */
  readonly hidden?: boolean
  readonly description?: string
  readonly order: number
  readonly view: PageView
}

export interface FrontendSettingsCard {
  readonly id: string
  readonly owner: string
  readonly title: string
  readonly description?: string
  /** 设置插件的命名空间（app.yml entry 的 id）。 */
  readonly namespace: string
  readonly order: number
}

export interface FrontendSlot {
  readonly id: string
  readonly owner: string
  /** 例如 `admin.overview.after`。 */
  readonly slot: string
  readonly title: string
  readonly body?: string
  /** 站内路径，例如 `/admin/strategies`。 */
  readonly href?: string
  readonly order: number
}

export interface FrontendManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION
  readonly revision: string
  readonly generatedAt: string
  readonly areas: Readonly<Record<FrontendArea, FrontendAreaInfo>>
  readonly enabledPlugins: readonly string[]
  readonly pages: readonly FrontendPage[]
  readonly settingsCards: readonly FrontendSettingsCard[]
  readonly slots: readonly FrontendSlot[]
  /** 由服务层补上：当前静态资源版本与公开基址。 */
  readonly assets?: { readonly version: string; readonly base: string }
}

export interface ContributionBundle {
  readonly pages?: readonly Omit<FrontendPage, 'owner'>[]
  readonly settingsCards?: readonly Omit<FrontendSettingsCard, 'owner'>[]
  readonly slots?: readonly Omit<FrontendSlot, 'owner'>[]
}

interface OwnedContribution {
  readonly token: symbol
  readonly owner: string
  readonly pages: readonly Omit<FrontendPage, 'owner'>[]
  readonly settingsCards: readonly Omit<FrontendSettingsCard, 'owner'>[]
  readonly slots: readonly Omit<FrontendSlot, 'owner'>[]
}

export interface ManifestRegistryOptions {
  readonly contributions?: readonly (ContributionBundle & { readonly owner: string })[]
  readonly now?: () => Date
  readonly enabledPlugins?: Iterable<string>
}

export const FRONTEND_AREAS: Readonly<Record<FrontendArea, FrontendAreaInfo>> = {
  console: {
    label: '用户站',
    root: '/console',
    description: '密钥、用量、额度与充值',
  },
  admin: {
    label: '管理台',
    root: '/admin',
    description: '账号池、模块与运行期设置',
  },
}

/**
 * 内置清单只描述「接口形状」，不假装已经知道 owner 的最终视觉稿。
 * 缺少参考设计的页面明确用 `placeholder`，见 packages/console/DESIGN.md。
 */
export const BUILT_IN_CONTRIBUTIONS: readonly (ContributionBundle & { readonly owner: string })[] = [
  {
    owner: CORE_OWNER,
    pages: [
      {
        id: 'core.console.root',
        area: 'console',
        path: '/console',
        title: '用量信息',
        nav: '用量信息',
        hidden: true,
        order: -1,
        view: { kind: 'redirect', to: '/console/usage' },
      },
      {
        id: 'core.console.usage',
        area: 'console',
        path: '/console/usage',
        title: '用量信息',
        nav: '用量信息',
        icon: 'usage',
        description: '余额、消费与令牌用量；所有金额由整数分换算显示。',
        order: 0,
        view: { kind: 'usage' },
      },
      {
        id: 'core.console.keys',
        area: 'console',
        path: '/console/api_keys',
        title: 'API keys',
        nav: 'API keys',
        icon: 'keys',
        description: '签发、改名与吊销 API key；完整 key 只在创建时显示一次。',
        order: 10,
        view: { kind: 'keys' },
      },
      {
        id: 'core.console.topup',
        area: 'console',
        path: '/console/top_up',
        title: '充值',
        nav: '充值',
        icon: 'topup',
        description: '在线充值；到账由 Go 的支付模块负责，前端不接触支付凭据。',
        order: 20,
        view: { kind: 'topup' },
      },
      {
        id: 'core.console.transactions',
        area: 'console',
        path: '/console/transactions',
        title: '账单',
        nav: '账单',
        icon: 'billing',
        description: '账单与发票页面等待参考设计。',
        order: 30,
        view: {
          kind: 'placeholder',
          note: '参考源码里有 /transactions 路由，但没有提供账单页面的完整 DOM；当前保留导航与占位。',
        },
      },
      {
        id: 'core.console.profile',
        area: 'console',
        path: '/console/profile',
        title: '个人资料',
        nav: '个人资料',
        hidden: true,
        order: 40,
        view: { kind: 'profile' },
      },
      {
        id: 'core.admin.overview',
        area: 'admin',
        path: '/admin',
        title: '概览',
        nav: '概览',
        icon: 'overview',
        description: '网关健康、模块目录与已启用插件的管理入口。',
        order: 0,
        view: { kind: 'overview', flavor: 'admin' },
      },
      {
        id: 'core.admin.users',
        area: 'admin',
        path: '/admin/users',
        title: '用户',
        nav: '用户',
        icon: 'user',
        description: '用户状态、角色、余额显示与余额调整；余额按最小单位整数运算。',
        order: 15,
        view: { kind: 'users' },
      },
      {
        id: 'core.admin.catalog',
        area: 'admin',
        path: '/admin/catalog',
        title: '模块目录',
        nav: '模块目录',
        icon: 'catalog',
        description: '控制面插件与数据面模块的运行状态；禁用项不会出现在导航里。',
        order: 10,
        view: { kind: 'catalog' },
      },
    ],
    settingsCards: [
      {
        id: 'core.frontend.settings',
        title: '前端资源',
        description: '静态资源版本、清单与部署前缀。',
        namespace: 'frontend',
        order: 90,
      },
    ],
    slots: [
      {
        id: 'core.admin.reference',
        slot: 'admin.overview.after',
        title: '参考设计待补',
        body: '管理台的信息架构已按数据接缝搭好；最终版式、字体与间距等 owner 提供参考页面后替换。',
        order: 100,
      },
      {
        id: 'core.console.billing-link',
        slot: 'console.overview.after',
        title: '账单与发票',
        body: '参考源码里有 /transactions 路由，但账单页 DOM 尚未提供；当前保留导航与占位。',
        href: '/console/transactions',
        order: 100,
      },
    ],
  },
  {
    owner: '@dizzyapi/plugin-identity',
    pages: [
      {
        id: 'identity.admin.accounts',
        area: 'admin',
        path: '/admin/accounts',
        title: '账号池',
        nav: '账号池',
        icon: 'accounts',
        description: '上游账号的元数据与运行状态；这里永远不显示访问令牌或刷新令牌。',
        order: 20,
        view: { kind: 'accounts' },
      },
    ],
    settingsCards: [
      {
        id: 'identity.settings',
        title: '账号刷新策略',
        description: '刷新窗口、轮询间隔、退避与超时。',
        namespace: 'identity',
        order: 20,
      },
    ],
  },
  {
    owner: '@dizzyapi/plugin-account-priority',
    pages: [
      {
        id: 'account-priority.admin.strategies',
        area: 'admin',
        path: '/admin/strategies',
        title: '账号优先级',
        nav: '账号优先级',
        icon: 'strategies',
        description: '策略组的写入与预览走 account-priority 服务；页面等待参考设计。',
        order: 30,
        view: {
          kind: 'placeholder',
          note: '策略组编辑器、预览排序与 gatewayd 监管状态需要参考页面。当前策略数据由 accountPriority 服务持有。',
        },
      },
    ],
    settingsCards: [
      {
        id: 'account-priority.settings',
        title: '账号优先级',
        description: 'gatewayd 拉起、超时与重启退避。',
        namespace: 'account-priority',
        order: 30,
      },
    ],
    slots: [
      {
        id: 'account-priority.admin.overview',
        slot: 'admin.overview.after',
        title: '账号优先级',
        body: '策略与 gatewayd 状态由 accountPriority 服务提供；编辑页仍是占位。',
        href: '/admin/strategies',
        order: 20,
      },
    ],
  },
  {
    owner: '@dizzyapi/plugin-settings',
    pages: [
      {
        id: 'settings.admin.settings',
        area: 'admin',
        path: '/admin/settings',
        title: '运行期设置',
        nav: '设置',
        icon: 'settings',
        description: 'app.yml 是基线；这里只写设置插件的覆盖文件。',
        order: 40,
        view: { kind: 'settings' },
      },
    ],
  },
  {
    owner: '@dizzyapi/plugin-mailer',
    settingsCards: [
      {
        id: 'mailer.settings',
        title: '邮件投递',
        description: 'SMTP 传输、发件人与超时；授权码只显示「配没配」。',
        namespace: 'mailer',
        order: 10,
      },
    ],
  },
  {
    owner: '@dizzyapi/plugin-auth',
    settingsCards: [
      {
        id: 'auth.settings',
        title: '注册与登录',
        description: '验证码有效期、会话 TTL 与登录失败限制。',
        namespace: 'auth',
        order: 15,
      },
    ],
  },
]

/**
 * 清单注册表。纯内存、无 I/O、无 cordis 依赖——服务层负责把快照落盘。
 * 所有返回的数组都是新副本；调用方改不到运行期状态。
 */
export class ManifestRegistry {
  private readonly records: OwnedContribution[] = []
  private readonly now: () => Date
  private enabled: ReadonlySet<string>

  constructor(options: ManifestRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.enabled = normalizeEnabled(options.enabledPlugins ?? [])
    for (const bundle of options.contributions ?? BUILT_IN_CONTRIBUTIONS) {
      this.records.push(recordOf(bundle.owner, bundle, Symbol(bundle.owner)))
    }
    validateRecords(this.records)
  }

  /** 运行期注册；返回 disposer，调用方应当把它挂在 `ctx.effect()` 上。 */
  contribute(owner: string, bundle: ContributionBundle): () => void {
    const normalized = assertOwner(owner)
    const token = Symbol(normalized)
    const record = recordOf(normalized, bundle, token)
    const next = [...this.records, record]
    validateRecords(next)
    this.records.push(record)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const index = this.records.findIndex((item) => item.token === token)
      if (index >= 0) this.records.splice(index, 1)
    }
  }

  /**
   * 设置当前启用的插件集合。集合里可以放 app.yml entry id（`identity`）
   * 或包名（`@dizzyapi/plugin-identity`）；owner 匹配任意一种即可。
   * CORE_OWNER 永远可见——这个插件正在运行，本身就是「已启用」。
   */
  setEnabledPlugins(ids: Iterable<string>): readonly string[] {
    this.enabled = normalizeEnabled(ids)
    return [...this.enabled].sort()
  }

  get enabledPlugins(): readonly string[] {
    return [...this.enabled].sort()
  }

  /** 当前可见的完整快照。revision 不包含 generatedAt，同内容同 revision。 */
  snapshot(): FrontendManifest {
    const visible = this.records.filter((record) => this.isVisible(record.owner))
    const pages = visible.flatMap((record) =>
      record.pages.map((page) => ({ ...page, owner: record.owner })),
    )
    const settingsCards = visible.flatMap((record) =>
      record.settingsCards.map((card) => ({ ...card, owner: record.owner })),
    )
    const slots = visible.flatMap((record) =>
      record.slots.map((slot) => ({ ...slot, owner: record.owner })),
    )

    pages.sort(compareByAreaOrderPath)
    settingsCards.sort(compareByOrderId)
    slots.sort((a, b) => a.slot.localeCompare(b.slot) || compareByOrderId(a, b))

    const content = {
      schemaVersion: MANIFEST_SCHEMA_VERSION as typeof MANIFEST_SCHEMA_VERSION,
      areas: FRONTEND_AREAS,
      enabledPlugins: this.enabledPlugins,
      pages,
      settingsCards,
      slots,
    }
    return {
      ...content,
      revision: revisionOf(content),
      generatedAt: this.now().toISOString(),
    }
  }

  private isVisible(owner: string): boolean {
    if (owner === CORE_OWNER || this.enabled.has(owner)) return true
    // app.yml 的 entry id（`identity`）与包名（`@dizzyapi/plugin-identity`）
    // 指的是同一个插件；`collectEnabledPlugins` 两个都收，手工传其中一个也能匹配。
    const short = shortPluginName(owner)
    if (short !== undefined && this.enabled.has(short)) return true
    for (const id of this.enabled) {
      if (shortPluginName(id) === owner) return true
    }
    return false
  }
}

function shortPluginName(value: string): string | undefined {
  const prefix = '@dizzyapi/plugin-'
  return value.startsWith(prefix) ? value.slice(prefix.length) : undefined
}

function recordOf(owner: string, bundle: ContributionBundle, token: symbol): OwnedContribution {
  return {
    token,
    owner,
    pages: bundle.pages ?? [],
    settingsCards: bundle.settingsCards ?? [],
    slots: bundle.slots ?? [],
  }
}

function assertOwner(owner: string): string {
  if (typeof owner !== 'string' || owner.trim() === '') {
    throw new FrontendError('FRONTEND_MANIFEST_INVALID', '贡献者必须声明非空的 owner（包名或 entry id）')
  }
  return owner.trim()
}

function normalizeEnabled(ids: Iterable<string>): ReadonlySet<string> {
  const set = new Set<string>([CORE_OWNER])
  for (const id of ids) {
    if (typeof id === 'string' && id.trim() !== '') set.add(id.trim())
  }
  return set
}

function validateRecords(records: readonly OwnedContribution[]): void {
  const pageIds = new Set<string>()
  const pagePaths = new Set<string>()
  const cardIds = new Set<string>()
  const namespaces = new Set<string>()
  const slotIds = new Set<string>()

  for (const record of records) {
    assertOwner(record.owner)
    for (const page of record.pages) {
      assertContributionId(page.id, '页面')
      if (pageIds.has(page.id)) invalid(`页面 id 重复：${page.id}`)
      pageIds.add(page.id)
      if (page.area !== 'console' && page.area !== 'admin') invalid(`页面 ${page.id} 的 area 非法`)
      if (!isPagePath(page.path, page.area)) {
        invalid(`页面 ${page.id} 的 path 必须落在 /${page.area} 下：${page.path}`)
      }
      if (pagePaths.has(page.path)) invalid(`页面 path 重复：${page.path}`)
      pagePaths.add(page.path)
      if (typeof page.title !== 'string' || page.title.trim() === '') invalid(`页面 ${page.id} 缺少 title`)
      if (typeof page.nav !== 'string' || page.nav.trim() === '') invalid(`页面 ${page.id} 缺少 nav`)
      if (page.icon !== undefined && (typeof page.icon !== 'string' || page.icon.trim() === '')) {
        invalid(`页面 ${page.id} 的 icon 必须是非空字符串`)
      }
      if (page.hidden !== undefined && typeof page.hidden !== 'boolean') {
        invalid(`页面 ${page.id} 的 hidden 必须是布尔值`)
      }
      assertOrder(page.order, `页面 ${page.id}`)
      assertView(page)
    }

    for (const card of record.settingsCards) {
      assertContributionId(card.id, '设置卡')
      if (cardIds.has(card.id)) invalid(`设置卡 id 重复：${card.id}`)
      cardIds.add(card.id)
      if (typeof card.namespace !== 'string' || card.namespace.trim() === '') {
        invalid(`设置卡 ${card.id} 缺少 namespace`)
      }
      if (namespaces.has(card.namespace)) invalid(`设置卡 namespace 重复：${card.namespace}`)
      namespaces.add(card.namespace)
      if (typeof card.title !== 'string' || card.title.trim() === '') invalid(`设置卡 ${card.id} 缺少 title`)
      assertOrder(card.order, `设置卡 ${card.id}`)
    }

    for (const slot of record.slots) {
      assertContributionId(slot.id, '插槽条目')
      if (slotIds.has(slot.id)) invalid(`插槽条目 id 重复：${slot.id}`)
      slotIds.add(slot.id)
      if (!/^[a-z][a-z0-9.-]*$/.test(slot.slot)) invalid(`插槽名非法：${slot.slot}`)
      if (typeof slot.title !== 'string' || slot.title.trim() === '') invalid(`插槽条目 ${slot.id} 缺少 title`)
      assertOrder(slot.order, `插槽条目 ${slot.id}`)
    }
  }
}

function assertView(page: { readonly id: string; readonly view: PageView }): void {
  const view = page.view
  if (typeof view !== 'object' || view === null || typeof view.kind !== 'string') {
    invalid(`页面 ${page.id} 缺少 view`)
  }
  switch (view.kind) {
    case 'overview':
      if (view.flavor !== 'console' && view.flavor !== 'admin') {
        invalid(`页面 ${page.id} 的 overview.flavor 非法`)
      }
      return
    case 'usage':
    case 'keys':
    case 'topup':
      return
    case 'redirect':
      if (typeof view.to !== 'string' || !view.to.startsWith('/')) {
        invalid(`页面 ${page.id} 的 redirect.to 必须是站内路径`)
      }
      return
    case 'accounts':
    case 'users':
    case 'profile':
    case 'catalog':
    case 'settings':
      return
    case 'placeholder':
      if (typeof view.note !== 'string' || view.note.trim() === '') {
        invalid(`页面 ${page.id} 的 placeholder.note 不能为空`)
      }
      return
    case 'remote':
      if (typeof view.module !== 'string' || view.module.trim() === '') {
        invalid(`页面 ${page.id} 的 remote.module 不能为空`)
      }
      return
    default:
      invalid(`页面 ${page.id} 的 view.kind 未知`)
  }
}

function isPagePath(path: string, area: FrontendArea): boolean {
  if (typeof path !== 'string' || !path.startsWith(`/${area}`)) return false
  if (path.includes('?') || path.includes('#') || path.includes('*') || path.includes('//')) return false
  if (path !== `/${area}` && path.endsWith('/')) return false
  return path === `/${area}` || path.startsWith(`/${area}/`)
}

function assertContributionId(id: string, label: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id)) {
    invalid(`${label} id 非法：${String(id)}`)
  }
}

function assertOrder(order: number, label: string): void {
  if (typeof order !== 'number' || !Number.isFinite(order)) invalid(`${label} 的 order 必须是有限数字`)
}

function compareByAreaOrderPath(a: FrontendPage, b: FrontendPage): number {
  return a.area.localeCompare(b.area) || a.order - b.order || a.path.localeCompare(b.path)
}

function compareByOrderId(a: { order: number; id: string }, b: { order: number; id: string }): number {
  return a.order - b.order || a.id.localeCompare(b.id)
}

function revisionOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

function invalid(message: string): never {
  throw new FrontendError('FRONTEND_MANIFEST_INVALID', message)
}

export function isFrontendManifestError(error: unknown): boolean {
  return isFrontendError(error) && error.code === 'FRONTEND_MANIFEST_INVALID'
}
