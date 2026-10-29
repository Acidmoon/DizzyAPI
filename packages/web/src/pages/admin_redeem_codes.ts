/**
 * 管理台 · 兑换码：批次、码列表（掩码）、生成、启停、批量删除、人工核查。
 *
 * 明文只在**生成后第一次渲染**出现：动作把整批明文交给 `ctx.stashSecret()`，
 * 303 到 `?new=<id>`，本页用 `takeSecret()` 取一次（TTL 5 分钟，取过即删）。
 * 列表、筛选、统计一律只有末 4 位掩码。
 */
import { pageHeader, renderAdminShell, type PageModule } from '../layout.ts'
import type { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { formatYuan, parseYuanToMicros, requiredString, WebError } from '../forms.ts'
import { WEB_ACTOR, type RedeemCodeView, type RedeemStatsView } from '../runtime.ts'
import { auditedAction } from '../audit.ts'

const PAGE_LIMIT = 50

const STATUS_LABEL: Readonly<Record<string, string>> = {
  enabled: '可用',
  redeeming: '兑换中（需核查）',
  used: '已用',
  disabled: '已停用',
  expired: '已过期',
}

const STATUS_FILTERS: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: '全部' },
  { value: 'enabled', label: '可用' },
  { value: 'redeeming', label: '兑换中' },
  { value: 'used', label: '已用' },
  { value: 'disabled', label: '已停用' },
  { value: 'expired', label: '已过期' },
]

/** 派生状态：enabled 且过了有效期 → 显示「已过期」。 */
function statusOf(code: RedeemCodeView, now: string): string {
  if (code.status === 'enabled' && code.expiresAt !== null && code.expiresAt <= now) return 'expired'
  return code.status
}

function statusBadge(t: PageTemplateService, status: string): string {
  const label = STATUS_LABEL[status] ?? status
  if (status === 'used') return t.renderBadge(label, 'ok')
  if (status === 'redeeming') return t.renderBadge(label, 'warn')
  if (status === 'expired') return t.renderBadge(label, 'warn')
  if (status === 'disabled') return t.renderBadge(label, 'err')
  return t.renderBadge(label)
}

/** 当前筛选条件 → 链接（保留其它条件）。 */
function linkOf(current: { batch: string; status: string; keyword: string }, patch: Record<string, string>): string {
  const next = { ...current, ...patch }
  const params = new URLSearchParams()
  if (next.batch !== '') params.set('batch', next.batch)
  if (next.status !== '') params.set('status', next.status)
  if (next.keyword !== '') params.set('keyword', next.keyword)
  const query = params.toString()
  return query === '' ? '/admin/redeem-codes' : `/admin/redeem-codes?${query}`
}

function formatTime(value: string | null): string {
  return value === null ? '—' : value.slice(0, 19).replace('T', ' ')
}

export const adminRedeemCodesPage: PageModule = {
  path: '/admin/redeem-codes',
  area: 'admin',
  title: '兑换码',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const header = pageHeader(
      ctx,
      '兑换码',
      '明文码只在生成后显示一次；列表只有末 4 位掩码。兑换中（需人工核查）的码要显式给出结论。',
    )
    const redeem = ctx.services.redeem
    if (redeem === undefined) {
      return renderAdminShell(
        ctx,
        `${header}\n${t.renderNotice({ kind: 'err', text: '兑换码服务未运行，暂时无法管理兑换码' })}`,
      )
    }

    const current = {
      batch: ctx.query.get('batch') ?? '',
      status: ctx.query.get('status') ?? '',
      keyword: ctx.query.get('keyword') ?? '',
    }
    // 非法的筛选值直接当「全部」处理：筛选是只读操作，不该让整页变成错误页。
    if (!STATUS_FILTERS.some((item) => item.value === current.status)) current.status = ''
    const offsetText = ctx.query.get('offset') ?? '0'
    const offset = /^\d+$/.test(offsetText) ? Number(offsetText) : 0
    const now = new Date().toISOString()

    let stats: RedeemStatsView
    let page: Awaited<ReturnType<typeof redeem.listCodes>>
    let batches: Awaited<ReturnType<typeof redeem.listBatches>>
    try {
      ;[stats, page, batches] = await Promise.all([
        redeem.stats(WEB_ACTOR),
        redeem.listCodes(WEB_ACTOR, {
          ...(current.batch === '' ? {} : { batchId: current.batch }),
          ...(current.status === '' ? {} : { status: current.status }),
          ...(current.keyword === '' ? {} : { keyword: current.keyword }),
          limit: PAGE_LIMIT,
          offset,
        }),
        redeem.listBatches(WEB_ACTOR, { limit: 100 }),
      ])
    } catch {
      return renderAdminShell(
        ctx,
        `${header}\n${t.renderNotice({ kind: 'err', text: '兑换码服务暂时不可用，请稍后再试' })}`,
      )
    }

    // 一次性明文：生成动作 stash 的整批码。
    const secretId = ctx.query.get('new')
    const secret = secretId === null ? undefined : ctx.takeSecret()
    const secretLines = secret === undefined ? [] : secret.split('\n').filter((line) => line !== '')
    const secretBlock = secretLines.length === 0
      ? ''
      : [
          t.renderNotice({
            kind: 'ok',
            text: `已生成 ${secretLines.length} 个兑换码，只显示这一次，请立即保存。`,
          }),
          `<div class="panel" style="padding:16px;margin-bottom:24px">
<pre class="mono">${t.escapeText(secretLines.join('\n'))}</pre>
<div class="actions">${secretLines
            .map(
              (line) =>
                `<button class="btn small" type="button" data-copy="${t.escapeAttr(line)}">复制尾号 ${t.escapeText(line.slice(-4))}</button>`,
            )
            .join('')}</div>
</div>`,
        ].join('\n')

    const statCards = t.renderStatCards(
      [
        { label: '批次', value: String(stats.batches) },
        { label: '兑换码', value: String(stats.codes) },
        { label: '可用', value: String(stats.enabled) },
        { label: '已用', value: String(stats.used) },
        { label: '兑换中（需核查）', value: String(stats.redeeming) },
        { label: '已兑金额', value: formatYuan(stats.redeemedAmountMicro), unit: 'CNY' },
      ],
      'metrics',
    )

    const selectedStatusLabel =
      STATUS_FILTERS.find((item) => item.value === current.status)?.label ?? '全部'
    const selectedBatch = batches.find((batch) => batch.id === current.batch)
    const filterPills = [
      {
        label: '状态',
        value: selectedStatusLabel,
        items: STATUS_FILTERS.map((item) => ({
          label: item.label,
          href: linkOf(current, { status: item.value }),
          selected: item.value === current.status,
        })),
      },
      {
        label: '批次',
        value: selectedBatch === undefined ? '全部' : selectedBatch.name,
        items: [
          { label: '全部', href: linkOf(current, { batch: '' }), selected: current.batch === '' },
          ...batches.map((batch) => ({
            label: batch.name,
            href: linkOf(current, { batch: batch.id }),
            selected: batch.id === current.batch,
          })),
        ],
      },
    ]
    const searchForm = `<form class="form inline-form" method="get" action="/admin/redeem-codes" style="max-width:none">
${
      current.batch === '' ? '' : `<input type="hidden" name="batch" value="${t.escapeAttr(current.batch)}">`
    }${
      current.status === '' ? '' : `<input type="hidden" name="status" value="${t.escapeAttr(current.status)}">`
    }
${t.renderField({ label: '掩码尾号', name: 'keyword', value: current.keyword, placeholder: 'A3F7' })}
<div class="actions"><button class="btn small" type="submit">筛选</button></div>
</form>`

    const rows = page.items.map((code) => {
      const status = statusOf(code, now)
      const toggleTo = code.status === 'enabled' ? 'disabled' : 'enabled'
      const toggleLabel = code.status === 'enabled' ? '停用' : '启用'
      const toggle = code.status === 'enabled' || code.status === 'disabled'
        ? `<form class="inline-form" method="post" action="/admin/redeem-codes?action=status">
<input type="hidden" name="id" value="${t.escapeAttr(code.id)}">
<input type="hidden" name="status" value="${toggleTo}">
<button class="btn small" type="submit">${toggleLabel}</button></form>`
        : ''
      const resolve = code.status === 'redeeming'
        ? `<form class="inline-form" method="post" action="/admin/redeem-codes?action=resolve" data-confirm="确认额度已经到账？确认后这个码标记为已用。">
<input type="hidden" name="id" value="${t.escapeAttr(code.id)}">
<input type="hidden" name="outcome" value="used">
<button class="btn small" type="submit">标记为已用</button></form>
<form class="inline-form" method="post" action="/admin/redeem-codes?action=resolve" data-confirm="确认额度没有到账？退回后这个码可以再次兑换。">
<input type="hidden" name="id" value="${t.escapeAttr(code.id)}">
<input type="hidden" name="outcome" value="enabled">
<button class="btn small" type="submit">退回可用</button></form>`
        : ''
      const remove = code.status === 'used' || code.status === 'redeeming'
        ? ''
        : `<form class="inline-form" method="post" action="/admin/redeem-codes?action=delete" data-confirm="删除后不可恢复，确定？">
<input type="hidden" name="ids" value="${t.escapeAttr(code.id)}">
<button class="btn small danger" type="submit">删除</button></form>`
      return [
        `<code class="mono">${t.escapeText(code.codeMask)}</code>`,
        t.escapeText(code.batchName ?? '—'),
        t.escapeText(formatYuan(code.amountMicro)),
        statusBadge(t, status),
        t.escapeText(formatTime(code.createdAt)),
        t.escapeText(code.expiresAt === null ? '永久' : formatTime(code.expiresAt)),
        t.escapeText(code.redeemedBy === null ? '—' : `#${code.redeemedBy}`),
        `<div class="actions">${resolve}${toggle}${remove}</div>`,
      ]
    })

    const totalPages = Math.max(1, Math.ceil(page.total / PAGE_LIMIT))
    const currentPage = Math.floor(offset / PAGE_LIMIT) + 1
    const pager: string[] = []
    if (page.total > PAGE_LIMIT) {
      const withOffset = (value: number): string => {
        const params = new URLSearchParams()
        if (current.batch !== '') params.set('batch', current.batch)
        if (current.status !== '') params.set('status', current.status)
        if (current.keyword !== '') params.set('keyword', current.keyword)
        params.set('offset', String(value))
        return `/admin/redeem-codes?${params.toString()}`
      }
      pager.push(
        `<p class="page-note"><span>第 ${currentPage} / ${totalPages} 页，共 ${page.total} 条</span>`,
        offset > 0 ? `<a class="btn small" href="${withOffset(Math.max(0, offset - PAGE_LIMIT))}">上一页</a>` : '',
        offset + PAGE_LIMIT < page.total
          ? `<a class="btn small" href="${withOffset(offset + PAGE_LIMIT)}">下一页</a>`
          : '',
        '</p>',
      )
    }

    const batchRows = batches.map((batch) => [
      `<code class="mono">${t.escapeText(batch.name)}</code>`,
      t.escapeText(formatYuan(batch.amountMicro)),
      String(batch.total),
      String(batch.codeCount),
      String(batch.usedCount),
      t.escapeText(formatTime(batch.createdAt)),
      t.escapeText(batch.expiresAt === null ? '永久' : formatTime(batch.expiresAt)),
      `<div class="actions"><a class="btn small" href="${t.escapeAttr(linkOf(current, { batch: batch.id, status: '' }))}">只看本批</a></div>`,
    ])

    return renderAdminShell(
      ctx,
      [
        header,
        statCards,
        secretBlock,
        `<form class="form" method="post" action="/admin/redeem-codes?action=create" style="max-width:none;margin-bottom:16px">
<div class="row">
${t.renderField({ label: '批次名称', name: 'name', required: true, placeholder: '双十一', hint: '1..20 个字符' })}
${t.renderField({ label: '单码额度（元）', name: 'amount', required: true, placeholder: '5.00', hint: '最多 6 位小数，按整数微元入账' })}
${t.renderField({ label: '生成数量', name: 'count', required: true, type: 'number', placeholder: '10', hint: '1..100' })}
${t.renderField({ label: '有效期（可选）', name: 'expiresAt', type: 'datetime-local', hint: '留空 = 永不过期' })}
${t.renderField({ label: '备注（可选）', name: 'notes', placeholder: '活动说明' })}
<div class="actions"><button class="btn" type="submit">生成兑换码</button></div>
</div>
</form>`,
        t.renderFilterBar(filterPills, searchForm),
        t.renderTable({
          columns: [
            { label: '兑换码' },
            { label: '批次' },
            { label: '额度', align: 'right' },
            { label: '状态' },
            { label: '创建' },
            { label: '有效期' },
            { label: '兑换人' },
            { label: '操作' },
          ],
          rows,
          empty: '没有符合条件的兑换码',
        }),
        ...pager,
        t.renderSectionTitle('批次'),
        t.renderTable({
          columns: [
            { label: '批次' },
            { label: '单码额度', align: 'right' },
            { label: '计划数量' },
            { label: '实际生成' },
            { label: '已用' },
            { label: '创建' },
            { label: '有效期' },
            { label: '操作' },
          ],
          rows: batchRows,
          empty: '还没有生成过批次',
        }),
      ].join('\n'),
    )
  },

  actions: {
    create: async (ctx) => {
      const redeem = ctx.services.redeem
      if (redeem === undefined) throw new WebError('WEB_NO_REDEEM', '兑换码服务未运行')
      const name = requiredString(ctx.form, 'name', '批次名称')
      const amountMicro = parseYuanToMicros(requiredString(ctx.form, 'amount', '单码额度'))
      if (amountMicro <= 0n) throw new WebError('WEB_AMOUNT_INVALID', '单码额度必须大于 0')

      const countText = requiredString(ctx.form, 'count', '生成数量')
      if (!/^\d+$/.test(countText)) throw new WebError('WEB_COUNT_INVALID', '生成数量必须是整数')
      const count = Number(countText)

      const expiresRaw = ctx.form.get('expiresAt')?.trim() ?? ''
      let expiresAt: string | undefined
      if (expiresRaw !== '') {
        const parsed = Date.parse(expiresRaw)
        if (!Number.isFinite(parsed)) {
          throw new WebError('WEB_EXPIRES_INVALID', '有效期格式不正确')
        }
        expiresAt = new Date(parsed).toISOString()
      }
      const notes = ctx.form.get('notes')?.trim() ?? ''

      const created = await auditedAction(
        ctx,
        {
          action: 'redeem.batch.generate',
          targetType: 'redeem-batch',
          summary: `生成兑换码批次「${name}」（${count} 张）`,
          // 明文码只进一次性 stash，**绝不进审计**。
          metadata: { count, amountMicros: amountMicro.toString(), expiresAt: expiresAt ?? null },
          metadataOf: (out) => ({ batchId: out.batch.id }),
        },
        () =>
          redeem.createBatch(WEB_ACTOR, {
            name,
            amountMicro,
            count,
            ...(expiresAt === undefined ? {} : { expiresAt }),
            ...(notes === '' ? {} : { notes }),
          }),
      )
      const secretId = ctx.stashSecret(created.codes.join('\n'))
      return `/admin/redeem-codes?new=${encodeURIComponent(secretId)}&batch=${encodeURIComponent(created.batch.id)}`
    },

    status: async (ctx) => {
      const redeem = ctx.services.redeem
      if (redeem === undefined) throw new WebError('WEB_NO_REDEEM', '兑换码服务未运行')
      const id = requiredString(ctx.form, 'id', '兑换码')
      const status = ctx.form.get('status') === 'enabled' ? 'enabled' : 'disabled'
      await auditedAction(
        ctx,
        {
          action: 'redeem.code.status',
          targetType: 'redeem-code',
          targetId: id,
          summary: `把兑换码 ${id} 改为 ${status}`,
          metadata: { status },
        },
        () => redeem.setCodeStatus(WEB_ACTOR, id, status),
      )
      return `/admin/redeem-codes?ok=${encodeURIComponent(status === 'enabled' ? '已启用' : '已停用')}`
    },

    resolve: async (ctx) => {
      const redeem = ctx.services.redeem
      if (redeem === undefined) throw new WebError('WEB_NO_REDEEM', '兑换码服务未运行')
      const id = requiredString(ctx.form, 'id', '兑换码')
      const raw = ctx.form.get('outcome')
      if (raw !== 'used' && raw !== 'enabled') {
        throw new WebError('WEB_INVALID_OUTCOME', 'outcome 只能是 used / enabled')
      }
      await auditedAction(
        ctx,
        {
          action: 'redeem.code.resolve',
          targetType: 'redeem-code',
          targetId: id,
          summary: `人工核查兑换码 ${id}：${raw === 'used' ? '标记为已用' : '退回可用'}`,
          metadata: { outcome: raw },
        },
        () => redeem.resolveRedeeming(WEB_ACTOR, id, raw),
      )
      return `/admin/redeem-codes?ok=${encodeURIComponent(raw === 'used' ? '已标记为已用' : '已退回可用')}`
    },

    delete: async (ctx) => {
      const redeem = ctx.services.redeem
      if (redeem === undefined) throw new WebError('WEB_NO_REDEEM', '兑换码服务未运行')
      const ids = ctx.form
        .getAll('ids')
        .map((value) => value.trim())
        .filter((value) => value !== '')
      if (ids.length === 0) throw new WebError('WEB_NO_SELECTION', '没有选择要删除的兑换码')
      const result = await auditedAction(
        ctx,
        {
          action: 'redeem.code.delete',
          targetType: 'redeem-code',
          summary: `批量删除 ${ids.length} 张兑换码`,
          metadata: { ids },
          metadataOf: (out) => ({ deleted: out.deleted, rejected: out.rejected.length }),
        },
        () => redeem.deleteCodes(WEB_ACTOR, ids),
      )
      if (result.deleted === 0) {
        const text = `没有删除任何兑换码：${result.rejected.length} 个已用或兑换中，不能删除`
        return `/admin/redeem-codes?err=${encodeURIComponent(text)}`
      }
      const extra = result.rejected.length === 0 ? '' : `；${result.rejected.length} 个不能删除`
      return `/admin/redeem-codes?ok=${encodeURIComponent(`已删除 ${result.deleted} 个${extra}`)}`
    },
  },
}
