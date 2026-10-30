/**
 * 管理台 · 上游账号：**筛选在上、列表在下**，操作收进「编辑」。
 *
 * owner 第 9 条要的是 sub2api 的信息架构：先条件、后结果。服务层早就支持
 * `search` / `labels` / `health` 过滤（`AccountListQuery`），但页面原来一律
 * `admin.list({}, {view:'lite'})`——筛选条件根本没被读过。这里把三个条件接上，
 * 条件放查询串（可分享、可刷新、可后退），与站内其它筛选页同一套交互。
 *
 * 「编辑」直接跳详情页（`/admin/accounts/detail`）：账号的字段多（baseUrl / models /
 * modelMap / 凭据 / 健康 / 调度），塞进弹窗会变成第二张详情页。行上只留
 * 「详情」这一个入口 + 批量勾选框，停用 / 删除 / 测试/ 批量都在详情页与批量区。
 *
 * 无 JS 降级：筛选是普通 GET 表单、编辑是普通链接，不依赖脚本。
 */
import { pageHeader, renderAdminShell, type PageModule } from '../layout.ts'
import { optionalString, WebError } from '../forms.ts'
import {
  WEB_ACTOR,
  type AccountBulkResult,
  type AccountListItem,
  type AccountListQuery,
  type WebRuntime,
} from '../runtime.ts'
import { auditedAction } from '../audit.ts'
import {
  errorText,
  formatNumber,
  formatTime,
  healthBadge,
  labelsText,
  parseIds,
  parseLabels,
  requireInteger,
  requirePositiveNumber,
  statusBadge,
} from '../accounts.ts'

/** 批量表单的 id：行内复选框用 `form=` 属性挂到它上面（表单不能嵌套）。 */
const BULK_FORM_ID = 'accounts-bulk'

/** 健康状态的可选值（与服务层同一套枚举）。 */
const HEALTH_OPTIONS = ['healthy', 'degraded', 'unhealthy', 'unknown'] as const

/** 从查询串读筛选条件；空串一律当「不筛」。只有非法的 health 会被忽略（不报错）。 */
function readQuery(query: URLSearchParams): AccountListQuery {
  const search = optionalString(query, 'search')
  const labelsText = optionalString(query, 'labels')
  const health = optionalString(query, 'health')
  const enabled = optionalString(query, 'enabled')
  return {
    ...(search === undefined ? {} : { search }),
    ...(labelsText === undefined ? {} : { labels: parseLabels(labelsText) }),
    ...(health !== undefined && (HEALTH_OPTIONS as readonly string[]).includes(health)
      ? { health }
      : {}),
    ...(enabled === '1' ? { enabled: true } : enabled === '0' ? { enabled: false } : {}),
  }
}

/** 筛选条：GET 表单（条件进查询串，可分享 / 可刷新 / 可后退）。 */
function renderFilters(
  t: import('@dizzyapi/plugin-page-template').PageTemplateService,
  query: URLSearchParams,
): string {
  const search = query.get('search') ?? ''
  const labels = query.get('labels') ?? ''
  const health = query.get('health') ?? ''
  const enabled = query.get('enabled') ?? ''
  const enabledOptions = [
    { value: '1', label: '仅启用', selected: enabled === '1' },
    { value: '0', label: '仅停用', selected: enabled === '0' },
  ]
  const healthSelect = [
    { value: 'all', label: '全部健康状态', selected: health === '' },
    ...HEALTH_OPTIONS.map((value) => ({ value, label: value, selected: health === value })),
  ]
  return `<form class="form form--wide form--spaced" method="get" action="/admin/accounts">
<div class="row">
${t.renderField({ label: '搜索（id / 名称 / 邮箱）', name: 'search', value: search, placeholder: '例如：alice 或 ops@example.com' })}
${t.renderField({ label: '标签（逗号分隔，AND）', name: 'labels', value: labels, placeholder: '例如：tier:pro, team:ops' })}
<div class="field">
<label for="f-health">健康状态</label>
${t.renderSelect({ name: 'health', id: 'f-health', allowEmpty: false, options: healthSelect })}
</div>
<div class="field">
<label for="f-enabled">启用状态</label>
${t.renderSelect({ name: 'enabled', id: 'f-enabled', options: enabledOptions })}
</div>
<div class="actions">
<button class="btn" type="submit">筛选</button>
<a class="btn btn--ghost" href="/admin/accounts">重置</a>
</div>
</div>
</form>`
}

export const adminAccountsPage: PageModule = {
  path: '/admin/accounts',
  area: 'admin',
  title: '上游账号',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const admin = ctx.services.accountAdmin
    if (admin === undefined) {
      return renderAdminShell(ctx, pageHeader(ctx, '上游账号') + t.renderNotice({ kind: 'err', text: '账号服务未运行' }))
    }

    const query = readQuery(ctx.query)
    const allCount = safeCount(admin)

    let accounts: AccountListItem[]
    try {
      // 列表页只需精简字段；详情（baseUrl / models / 凭据时间线）在详情页。
      accounts = admin.list(query, { view: 'lite' })
    } catch (error) {
      return renderAdminShell(
        ctx,
        pageHeader(ctx, '上游账号') + t.renderNotice({ kind: 'err', text: errorText(error) }),
      )
    }

    const rows = accounts.map((account) => {
      const checkbox = `<input type="checkbox" form="${BULK_FORM_ID}" name="ids" value="${t.escapeAttr(account.id)}" aria-label="选择 ${t.escapeAttr(account.label)}">`
      const statusCell =
        `${account.enabled ? t.renderBadge('启用', 'ok') : t.renderBadge('停用')} ${statusBadge(t, account.status)}` +
        (account.status === 'auto_disabled' && account.autoDisabledReason !== null
          ? `<div class="hint">${t.escapeText(account.autoDisabledReason)}</div>`
          : '')
      const testState = account.lastTestOk === null
        ? '未测试'
        : account.lastTestOk
          ? `成功 ${String(account.lastTestLatencyMs ?? 0)}ms`
          : `失败：${account.lastTestError ?? '未知错误'}`
      return [
        checkbox,
        `<a href="/admin/accounts/detail?id=${encodeURIComponent(account.id)}">${t.escapeText(account.label)}</a>`,
        t.escapeText(labelsText(account.labels)),
        t.escapeText(`${account.provider} / ${account.kind}`),
        statusCell,
        healthBadge(t, account.health),
        formatNumber(account.weight),
        formatNumber(account.concurrency),
        String(account.priority),
        t.escapeText(formatTime(account.lastUsedAt)),
        t.escapeText(testState),
        `<div class="actions"><a class="btn small" href="/admin/accounts/detail?id=${encodeURIComponent(account.id)}">编辑</a></div>`,
      ]
    })

    const filtered = Object.keys(query).length > 0
    const note = filtered
      ? `筛选出 ${String(accounts.length)} 个账号（共 ${String(allCount)} 个）。`
      : `共 ${String(accounts.length)} 个上游账号。`

    return renderAdminShell(ctx, [
      pageHeader(
        ctx,
        '上游账号',
        '测试会向上游发一条最小真实请求，结果写回账号；自动停用由健康检查维护，一次成功即恢复。',
      ),
      renderFilters(t, ctx.query),
      `<p class="hint p--spaced">${t.escapeText(note)}</p>`,
      t.renderTable({
        columns: [
          { label: '选择' },
          { label: '名称' },
          { label: '标签' },
          { label: '类型' },
          { label: '状态' },
          { label: '健康' },
          { label: '权重', align: 'right' },
          { label: '并发', align: 'right' },
          { label: '优先级', align: 'right' },
          { label: '最近使用' },
          { label: '最近测试' },
          { label: '操作' },
        ],
        rows,
        empty: filtered ? '没有符合条件的账号' : '还没有上游账号',
      }),
      t.renderSectionTitle('批量操作'),
      renderBulkForm(t, accounts.length),
    ].join('\n'))
  },

  actions: {
    async bulk(ctx) {
      const admin = requireAdmin(ctx)
      const ids = parseIds(ctx.form)
      const op = ctx.form.get('op') ?? 'update'

      if (op === 'enable' || op === 'disable') {
        const result = await auditedAction<AccountBulkResult>(
          ctx,
          {
            action: op === 'enable' ? 'account.bulk_enable' : 'account.bulk_disable',
            targetType: 'account',
            summary: `批量${op === 'enable' ? '启用' : '停用'} ${String(ids.length)} 个上游账号`,
            metadata: { ids },
            metadataOf: (out) => ({ succeeded: out.succeeded, failed: out.failed }),
          },
          () => (op === 'enable' ? admin.bulkEnable(WEB_ACTOR, ids) : admin.bulkDisable(WEB_ACTOR, ids)),
        )
        return '/admin/accounts?' + bulkNotice(op === 'enable' ? '启用' : '停用', result)
      }
      if (op !== 'update') throw new WebError('WEB_ACCOUNT_BULK_OP', '不认识的批量操作')

      const patch = bulkPatch(ctx.form)
      const result = await auditedAction<AccountBulkResult>(
        ctx,
        {
          action: 'account.bulk_update',
          targetType: 'account',
          summary: `批量修改 ${String(ids.length)} 个上游账号的字段：${Object.keys(patch).join(' / ')}`,
          metadata: { ids, fields: Object.keys(patch) },
          metadataOf: (out) => ({ succeeded: out.succeeded, failed: out.failed }),
        },
        () => admin.bulkUpdate(WEB_ACTOR, ids, patch),
      )
      return '/admin/accounts?' + bulkNotice('改字段', result)
    },
  },
}

/** 总数：`list()` 不带条件时拿一次，用于「筛选出 3 / 共 12」的说明。 */
function safeCount(admin: NonNullable<WebRuntime['accountAdmin']>): number {
  try {
    return admin.list({}, { view: 'lite' }).length
  } catch {
    return 0
  }
}

function requireAdmin(ctx: { services: WebRuntime }) {
  const admin = ctx.services.accountAdmin
  if (admin === undefined) throw new WebError('WEB_NO_ACCOUNT', '账号服务未运行')
  return admin
}

/** 批量结果 → PRG 提示：全成功给 ok，有失败给 err 并说明条数。 */
function bulkNotice(action: string, result: { readonly total: number; readonly succeeded: number; readonly failed: number }): string {
  const text =
    result.failed === 0
      ? `已${action} ${String(result.succeeded)} 个账号`
      : `${action}：成功 ${String(result.succeeded)} 个，失败 ${String(result.failed)} 个（共 ${String(result.total)} 个）`
  return `${result.failed === 0 ? 'ok' : 'err'}=${encodeURIComponent(text)}`
}

/**
 * 批量表单。
 *
 * 每个可改字段一个「启用开关 + 值」：只有勾了开关的字段才会出现在 patch 里；
 * 关闭类取值用显式空值（标签空文本、权重空文本 = 清空为未声明），而不是省略键。
 */
function renderBulkForm(t: import('@dizzyapi/plugin-page-template').PageTemplateService, total: number): string {
  return `<form class="form form--wide" id="${BULK_FORM_ID}" method="post" action="/admin/accounts?action=bulk">
<p class="hint">先在上表勾选账号（当前列表 ${String(total)} 个），再选择动作。勾选「启用 / 停用」时下面的字段不生效。</p>
<div class="row">
<div class="field"><label for="f-op">动作</label>${t.renderSelect({
  name: 'op',
  id: 'f-op',
  allowEmpty: false,
  options: [
    { value: 'update', label: '改字段（勾选下面的字段）', selected: true },
    { value: 'enable', label: '启用' },
    { value: 'disable', label: '停用' },
  ],
})}</div>
</div>
<div class="row">
<label class="hint"><input type="checkbox" name="useLabels" value="1"> 标签</label>
${t.renderField({ label: '标签（逗号分隔；留空 = 清空）', name: 'labels', placeholder: '例如：tier:pro, team:ops' })}
</div>
<div class="row">
<label class="hint"><input type="checkbox" name="useWeight" value="1"> 权重</label>
${t.renderField({ label: '权重（> 0；留空 = 未声明）', name: 'weight', inputmode: 'decimal', placeholder: '例如：2.5' })}
</div>
<div class="row">
<label class="hint"><input type="checkbox" name="useConcurrency" value="1"> 并发上限</label>
${t.renderField({ label: '并发上限（1–10000；留空 = 未声明）', name: 'concurrency', inputmode: 'numeric', placeholder: '例如：4' })}
</div>
<div class="row">
<label class="hint"><input type="checkbox" name="usePriority" value="1"> 优先级</label>
${t.renderField({ label: '优先级（0–1000）', name: 'priority', inputmode: 'numeric', placeholder: '例如：0' })}
</div>
<div class="actions"><button class="btn" type="submit">对勾选账号执行</button></div>
</form>`
}

/** 表单 → patch：只收勾了开关的字段；空值表示清空。 */
function bulkPatch(form: URLSearchParams): import('../runtime.ts').AccountUpdatePatch {
  const patch: Record<string, unknown> = {}
  if (form.get('useLabels') === '1') {
    const text = form.get('labels')?.trim() ?? ''
    patch.labels = text === '' ? null : parseLabels(text)
  }
  if (form.get('useWeight') === '1') {
    const text = form.get('weight')?.trim() ?? ''
    patch.weight = text === '' ? null : requirePositiveNumber(text, '权重')
  }
  if (form.get('useConcurrency') === '1') {
    const text = form.get('concurrency')?.trim() ?? ''
    patch.concurrency = text === '' ? null : requireInteger(text, '并发上限', 1, 10_000)
  }
  if (form.get('usePriority') === '1') {
    const text = form.get('priority')?.trim() ?? ''
    if (text === '') throw new WebError('WEB_ACCOUNT_BULK_EMPTY', '优先级不能为空（它不是可清空的字段）')
    patch.priority = requireInteger(text, '优先级', 0, 1_000)
  }
  if (Object.keys(patch).length === 0) {
    throw new WebError('WEB_ACCOUNT_BULK_EMPTY', '先勾选至少一个要修改的字段')
  }
  return patch as import('../runtime.ts').AccountUpdatePatch
}
