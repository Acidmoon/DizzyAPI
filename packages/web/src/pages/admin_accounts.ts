/** 管理台 · 上游账号：列表、启停、删除、连通性测试、批量操作。 */
import { pageHeader, renderAdminShell, type PageModule } from '../layout.ts'
import { requiredString, WebError } from '../forms.ts'
import { WEB_ACTOR, type AccountListItem, type AccountUpdatePatch, type WebRuntime } from '../runtime.ts'
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

    let accounts: AccountListItem[]
    try {
      // 列表页只需精简字段；详情（baseUrl / models / 凭据时间线）在详情页。
      accounts = admin.list({}, { view: 'lite' })
    } catch (error) {
      return renderAdminShell(
        ctx,
        pageHeader(ctx, '上游账号') + t.renderNotice({ kind: 'err', text: errorText(error) }),
      )
    }

    const rows = accounts.map((account) => {
      const checkbox = `<input type="checkbox" form="${BULK_FORM_ID}" name="ids" value="${t.escapeAttr(account.id)}" aria-label="选择 ${t.escapeAttr(account.label)}">`
      const toggle = `<form class="inline-form" method="post" action="/admin/accounts?action=${account.enabled ? 'disable' : 'enable'}">
<input type="hidden" name="id" value="${t.escapeAttr(account.id)}">
<button class="btn small" type="submit">${account.enabled ? '停用' : '启用'}</button></form>`
      const test = `<form class="inline-form" method="post" action="/admin/accounts?action=test">
<input type="hidden" name="id" value="${t.escapeAttr(account.id)}">
<button class="btn small" type="submit">测试连接</button></form>`
      const testState = account.lastTestOk === null
        ? '未测试'
        : account.lastTestOk
          ? `成功 ${account.lastTestLatencyMs ?? 0}ms`
          : `失败：${account.lastTestError ?? '未知错误'}`
      const statusCell =
        `${account.enabled ? t.renderBadge('启用', 'ok') : t.renderBadge('停用')} ${statusBadge(t, account.status)}` +
        (account.status === 'auto_disabled' && account.autoDisabledReason !== null
          ? `<div class="hint">${t.escapeText(account.autoDisabledReason)}</div>`
          : '')
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
        `<div class="actions"><a class="btn small" href="/admin/accounts/detail?id=${encodeURIComponent(account.id)}">详情</a>${toggle}${test}</div>`,
      ]
    })

    return renderAdminShell(ctx, [
      pageHeader(
        ctx,
        '上游账号',
        '测试会向上游发一条最小真实请求，结果写回账号；自动停用由健康检查维护，一次成功即恢复。',
      ),
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
        empty: '还没有上游账号',
      }),
      t.renderSectionTitle('批量操作'),
      renderBulkForm(t, accounts.length),
    ].join('\n'))
  },

  actions: {
    async enable(ctx) {
      const admin = requireAdmin(ctx)
      const id = requiredString(ctx.form, 'id', '账号')
      await admin.enable(WEB_ACTOR, id)
      return '/admin/accounts?ok=' + encodeURIComponent('账号已启用')
    },

    async disable(ctx) {
      const admin = requireAdmin(ctx)
      const id = requiredString(ctx.form, 'id', '账号')
      await admin.disable(WEB_ACTOR, id)
      return '/admin/accounts?ok=' + encodeURIComponent('账号已停用')
    },

    async remove(ctx) {
      const admin = requireAdmin(ctx)
      const id = requiredString(ctx.form, 'id', '账号')
      await admin.remove(WEB_ACTOR, id)
      return '/admin/accounts?ok=' + encodeURIComponent('账号已删除')
    },

    async test(ctx) {
      const admin = requireAdmin(ctx)
      const id = requiredString(ctx.form, 'id', '账号')
      const result = await admin.testConnection(id)
      const message = result.ok ? `连接成功（${result.latencyMs}ms）` : `连接失败：${result.error ?? '未知错误'}`
      return `/admin/accounts?${result.ok ? 'ok' : 'err'}=${encodeURIComponent(message)}`
    },

    async bulk(ctx) {
      const admin = requireAdmin(ctx)
      const ids = parseIds(ctx.form)
      const op = ctx.form.get('op') ?? 'update'

      if (op === 'enable' || op === 'disable') {
        const result = op === 'enable' ? await admin.bulkEnable(WEB_ACTOR, ids) : await admin.bulkDisable(WEB_ACTOR, ids)
        return '/admin/accounts?' + bulkNotice(op === 'enable' ? '启用' : '停用', result)
      }
      if (op !== 'update') throw new WebError('WEB_ACCOUNT_BULK_OP', '不认识的批量操作')

      const patch = bulkPatch(ctx.form)
      const result = await admin.bulkUpdate(WEB_ACTOR, ids, patch)
      return '/admin/accounts?' + bulkNotice('改字段', result)
    },
  },
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
      ? `已${action} ${result.succeeded} 个账号`
      : `${action}：成功 ${result.succeeded} 个，失败 ${result.failed} 个（共 ${result.total} 个）`
  return `${result.failed === 0 ? 'ok' : 'err'}=${encodeURIComponent(text)}`
}

/**
 * 批量表单。
 *
 * 每个可改字段一个「启用开关 + 值」：只有勾了开关的字段才会出现在 patch 里；
 * 关闭类取值用显式空值（标签空文本、权重空文本 = 清空为未声明），而不是省略键。
 */
function renderBulkForm(t: import('@dizzyapi/plugin-page-template').PageTemplateService, total: number): string {
  return `<form class="form" id="${BULK_FORM_ID}" method="post" action="/admin/accounts?action=bulk">
<p class="hint">先在上表勾选账号（共 ${total} 个），再选择动作。勾选「启用 / 停用」时下面的字段不生效。</p>
<div class="row">
<div class="field"><label for="f-op">动作</label><select class="input" id="f-op" name="op">
<option value="update">改字段（勾选下面的字段）</option>
<option value="enable">启用</option>
<option value="disable">停用</option>
</select></div>
</div>
<div class="row">
<label class="hint"><input type="checkbox" name="useLabels" value="1"> 标签</label>
${t.renderField({ label: '标签（逗号分隔；留空 = 清空）', name: 'labels', placeholder: 'tier:pro, team:ops' })}
</div>
<div class="row">
<label class="hint"><input type="checkbox" name="useWeight" value="1"> 权重</label>
${t.renderField({ label: '权重（> 0；留空 = 未声明）', name: 'weight', placeholder: '2.5' })}
</div>
<div class="row">
<label class="hint"><input type="checkbox" name="useConcurrency" value="1"> 并发上限</label>
${t.renderField({ label: '并发上限（1–10000；留空 = 未声明）', name: 'concurrency', placeholder: '4' })}
</div>
<div class="row">
<label class="hint"><input type="checkbox" name="usePriority" value="1"> 优先级</label>
${t.renderField({ label: '优先级（0–1000）', name: 'priority', placeholder: '0' })}
</div>
<div class="actions"><button class="btn" type="submit">对勾选账号执行</button></div>
</form>`
}

/** 表单 → patch：只收勾了开关的字段；空值表示清空。 */
function bulkPatch(form: URLSearchParams): AccountUpdatePatch {
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
  return patch as AccountUpdatePatch
}
