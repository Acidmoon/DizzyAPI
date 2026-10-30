/**
 * 管理台 · 操作审计：谁、经哪个插件、对谁、做了什么、结果如何。
 *
 * 只读页面：审计记录由写操作在**成功 / 失败之后**写入（`audit` 插件是唯一写者），
 * 这里只做查询与展示，不提供任何「删除 / 修改审计」的入口——审计能被改就等于没有。
 *
 * 动作码给中文标签；**没映射的动作原样显示码**（不空白）：空白会让人以为「这条没事」。
 */
import { pageHeader, renderAdminShell, type PageModule } from '../layout.ts'
import { AUDIT_ACTION_LABELS, auditActionLabel, auditTargetLabel } from '../content/audit_actions.ts'
import { WEB_ACTOR } from '../runtime.ts'

const PAGE_SIZE = 50
const DAY_MS = 86_400_000

function shortTime(iso: string | null): string {
  return iso === null || iso.length < 19 ? '—' : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}

function intParam(value: string | null): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

/** `YYYY-MM-DD`（UTC）→ 当天 00:00 的毫秒；不合法返回 undefined。 */
function dayStartMs(value: string | null): number | undefined {
  if (value === null || value === '') return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 元数据压成一行摘要：只用于展示，太长就截断（原始 JSON 不进页面）。 */
function metadataLine(metadata: Readonly<Record<string, unknown>> | null): string {
  if (metadata === null) return '—'
  try {
    const text = JSON.stringify(metadata)
    if (text === undefined || text === '{}') return '—'
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  } catch {
    return '—'
  }
}

export const adminAuditPage: PageModule = {
  path: '/admin/audit',
  area: 'admin',
  title: '操作审计',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const audit = ctx.services.audit
    if (audit === undefined) {
      return renderAdminShell(
        ctx,
        pageHeader(ctx, '操作审计') +
          t.renderNotice({ kind: 'err', text: '审计服务未运行：暂时看不到操作记录（业务写操作不受影响）' }),
      )
    }

    const actor = ctx.query.get('actor') ?? ''
    const action = ctx.query.get('action') ?? ''
    const targetType = ctx.query.get('targetType') ?? ''
    const fromDate = ctx.query.get('from') ?? ''
    const toDate = ctx.query.get('to') ?? ''
    const offset = intParam(ctx.query.get('offset'))

    const fromMs = dayStartMs(fromDate)
    const toStart = dayStartMs(toDate)
    const toMs = toStart === undefined ? undefined : toStart + DAY_MS

    let page: ReturnType<typeof audit.list>
    let stats: ReturnType<typeof audit.stats>
    try {
      page = audit.list(WEB_ACTOR, {
        offset,
        limit: PAGE_SIZE,
        ...(actor === '' ? {} : { actor }),
        ...(action === '' ? {} : { action }),
        ...(targetType === '' ? {} : { targetType }),
        ...(fromMs === undefined ? {} : { fromMs }),
        ...(toMs === undefined ? {} : { toMs }),
      })
      stats = audit.stats(WEB_ACTOR)
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取审计记录失败'
      return renderAdminShell(ctx, pageHeader(ctx, '操作审计') + t.renderNotice({ kind: 'err', text: message }))
    }

    /** 翻页时保留现有筛选条件。 */
    const pageHref = (nextOffset: number): string => {
      const params = new URLSearchParams()
      if (actor !== '') params.set('actor', actor)
      if (action !== '') params.set('action', action)
      if (targetType !== '') params.set('targetType', targetType)
      if (fromDate !== '') params.set('from', fromDate)
      if (toDate !== '') params.set('to', toDate)
      if (nextOffset > 0) params.set('offset', String(nextOffset))
      const query = params.toString()
      return query === '' ? '/admin/audit' : `/admin/audit?${query}`
    }

    const actionOptions = Object.entries(AUDIT_ACTION_LABELS)
      .map(
        ([code, label]) =>
          `<option value="${t.escapeAttr(code)}"${code === action ? ' selected' : ''}>${t.escapeText(label)}（${t.escapeText(code)}）</option>`,
      )
      .join('')
    const targetOptions = ['user', 'account', 'redeem-batch', 'redeem-code', 'topup-order', 'pricing', 'settings', 'usage-record']
      .map(
        (value) =>
          `<option value="${t.escapeAttr(value)}"${value === targetType ? ' selected' : ''}>${t.escapeText(auditTargetLabel(value))}</option>`,
      )
      .join('')

    // 第 11 条：筛选区的原生下拉与原生日期输入全部换成自研控件。
    // 原生控件的浮层由浏览器绘制、CSS 碰不到，所以下拉与日历必须换成
    // Tom Select / flatpickr（渲染成带 data-* 钩子的原生元素，无 JS 时仍可用）。
    const filterHtml = `<form class="form form--inline" method="get" action="/admin/audit">
<input class="input" type="text" name="actor" placeholder="操作者（user:1:admin）" value="${t.escapeAttr(actor)}" aria-label="操作者">
${t.renderSelectShell({ name: 'action', optionsHtml: `<option value="">全部动作</option>${actionOptions}`, ariaLabel: '动作' })}
${t.renderSelectShell({ name: 'targetType', optionsHtml: `<option value="">全部目标</option>${targetOptions}`, ariaLabel: '目标类型' })}
${t.renderDatePicker({ name: 'from', value: fromDate, ariaLabel: '起始日期' })}
${t.renderDatePicker({ name: 'to', value: toDate, ariaLabel: '结束日期' })}
<button class="btn small" type="submit">筛选</button>
<a class="btn small" href="/admin/audit">清空</a>
</form>`

    const rows = page.items.map((entry) => {
      const mapped = AUDIT_ACTION_LABELS[entry.action] !== undefined
      const actionCell = mapped
        ? `${t.escapeText(auditActionLabel(entry.action))}<br><code class="mono">${t.escapeText(entry.action)}</code>`
        : `<code class="mono">${t.escapeText(entry.action)}</code>`
      const resultCell =
        entry.result === 'failed'
          ? t.renderBadge(`失败 ${entry.errorCode ?? ''}`.trim(), 'err')
          : t.renderBadge('成功', 'ok')
      return [
        t.escapeText(shortTime(entry.at)),
        `<code class="mono">${t.escapeText(entry.actor)}</code>`,
        t.escapeText(entry.actorPlugin),
        actionCell,
        `${t.escapeText(auditTargetLabel(entry.targetType))}${
          entry.targetId === '' ? '' : ` <code class="mono">${t.escapeText(entry.targetId)}</code>`
        }`,
        resultCell,
        t.escapeText(entry.summary),
        `<code class="mono">${t.escapeText(metadataLine(entry.metadata))}</code>`,
      ]
    })

    const pager: string[] = []
    if (offset > 0) {
      pager.push(`<a class="btn small" href="${t.escapeAttr(pageHref(Math.max(offset - PAGE_SIZE, 0)))}">上一页</a>`)
    }
    if (offset + PAGE_SIZE < page.total) {
      pager.push(`<a class="btn small" href="${t.escapeAttr(pageHref(offset + PAGE_SIZE))}">下一页</a>`)
    }

    return renderAdminShell(
      ctx,
      [
        pageHeader(
          ctx,
          '操作审计',
          '记录管理员高危写操作（改余额 / 改角色 / 账号增删改 / 生成兑换码 / 确认到账 / 改价格与设置）。' +
            '审计是旁路：它挂掉不影响业务写操作；记录已脱敏，不含密码、密钥与凭据明文。',
        ),
        // 改前 4 张等权卡片平铺。现在「记录量」与「异常」分组，失败操作单独拎出来。
        t.renderMetricGroups([
          {
            title: '记录量',
            cards: [
              { label: '记录总数', value: t.formatThousands(stats.total), emphasis: 'primary' },
              { label: '今日', value: t.formatThousands(stats.today) },
              { label: '最近 24 小时', value: t.formatThousands(stats.last24h) },
            ],
          },
          {
            title: '异常',
            cards: [{ label: '失败操作', value: t.formatThousands(stats.failed) }],
          },
        ]),
        `<p class="muted">最近一条：${t.escapeText(shortTime(stats.lastAt))}（UTC）；保留期由 audit 插件配置，过期自动清理。</p>`,
        filterHtml,
        t.renderTable({
          columns: [
            { label: '时间（UTC）' },
            { label: '操作者' },
            { label: '发起插件' },
            { label: '动作' },
            { label: '目标' },
            { label: '结果' },
            { label: '摘要' },
            { label: '元数据（已脱敏）' },
          ],
          rows,
          empty: '没有符合条件的审计记录',
        }),
        pager.length === 0 ? '' : `<div class="filters filters--tight">${pager.join('')}</div>`,
      ].join('\n'),
    )
  },
}
