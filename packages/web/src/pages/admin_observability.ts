/**
 * 管理台 · 运维总览：把用量链路 / 结算 / 额度快照 / 账号运行时 / 审计 / 账号池健康聚到一屏。
 *
 * 三条纪律：
 *
 * 1. **只读**：这个页面没有任何写动作，数据来自 `observability` 插件的现算报告。
 * 2. **降级不白屏**：每块自带数据源健康度（正常 / 降级 / 不可用 + 原因）；
 *    某个源缺席只让那一块标不可用，其余块照常渲染（绝不整页 503）。
 * 3. **不泄漏**：报告里只有计数、时间、稳定码与摘要；账号 id / label / baseUrl / 用户隐私 /
 *    金额明细都不出现。金额一律整数微元字符串，用 `formatYuan` 渲染，不经浮点。
 */
import { pageHeader, renderAdminShell, type PageModule } from '../layout.ts'
import { formatYuan } from '../forms.ts'
import { auditActionLabel } from '../content/audit_actions.ts'
import type { SourceHealthView, SourceStateView } from '../runtime.ts'

/** 异常码 → 中文说明。没映射就原样显示码（不空白）。 */
const WARNING_LABELS: Readonly<Record<string, string>> = {
  USAGE_GAP: '用量序号有缺口（Go 缓冲覆盖了没被取走的记录）',
  USAGE_POLL_FAILING: '用量轮询连续失败（游标不前进）',
  USAGE_REJECTED_PENDING: '隔离区有待处理的坏记录（未结算、未扣费）',
  USAGE_RING_DROPPED: 'Go 环形缓冲丢过记录',
  BILLING_REVIEW: '结算有需要人工核查的记录',
  BILLING_FAILED: '结算有失败记录',
  BILLING_OVERDRAWN: '有透支扣费（余额被扣成负数）',
  QUOTA_SNAPSHOT_STALE: '余额快照过期或未就绪',
  ACCOUNTS_COOLING: '有账号处于冷却期',
  AUDIT_FAILED_ACTIONS: '审计里有失败的操作记录',
  ACCOUNTS_UNHEALTHY: '有账号健康检查不通过',
  ACCOUNTS_AUTO_DISABLED: '有账号被系统自动停用',
} as const

function warningLabel(code: string): string {
  return WARNING_LABELS[code] ?? code
}

const STATE_LABEL: Readonly<Record<SourceStateView, string>> = {
  ok: '正常',
  degraded: '降级',
  unavailable: '不可用',
}

const STATE_TONE: Readonly<Record<SourceStateView, 'ok' | 'warn' | 'err'>> = {
  ok: 'ok',
  degraded: 'warn',
  unavailable: 'err',
}

function shortTime(iso: string | null): string {
  return iso === null || iso.length < 19 ? '—' : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}

export const adminObservabilityPage: PageModule = {
  path: '/admin/observability',
  area: 'admin',
  title: '运维总览',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const observability = ctx.services.observability
    if (observability === undefined) {
      return renderAdminShell(
        ctx,
        pageHeader(ctx, '运维总览') +
          t.renderNotice({
            kind: 'err',
            text: '运维总览服务未运行：暂时看不到聚合状态（其它管理页不受影响）',
          }),
      )
    }

    let report: Awaited<ReturnType<typeof observability.observe>>
    try {
      report = await observability.observe()
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取运维总览失败'
      return renderAdminShell(ctx, pageHeader(ctx, '运维总览') + t.renderNotice({ kind: 'err', text: message }))
    }

    /** 每块的标题行：标题 + 健康度徽标；不 ok 时补一句原因。 */
    const block = (title: string, health: SourceHealthView): string => {
      const badge = t.renderBadge(STATE_LABEL[health.state], STATE_TONE[health.state])
      // renderSectionTitle 会把文本转义，所以这里自己拼：标题转义、徽标是已渲染的 HTML。
      const heading = `<h2 class="section-title">${t.escapeText(title)} ${badge}</h2>`
      const detail =
        health.state === 'ok' ? '' : `<p class="muted">${t.escapeText(health.detail)}</p>`
      return `${heading}${detail}`
    }

    /** 一个「项目 / 值」两列表格；值可以是已经渲染好的 HTML。 */
    const facts = (rows: readonly (readonly [string, string])[], empty = '暂时没有数据'): string =>
      t.renderTable({
        columns: [{ label: '项目' }, { label: '值' }],
        rows: rows.map(([label, value]) => [t.escapeText(label), value]),
        empty,
      })

    const count = (value: number | null | undefined): string =>
      value === null || value === undefined ? '—' : t.formatThousands(value)

    /** 异常值高亮：大于 0 就给红/黄徽标，否则普通文本。 */
    const alertCount = (value: number | null | undefined, tone: 'warn' | 'err' = 'warn'): string => {
      if (value === null || value === undefined) return '—'
      return value > 0 ? t.renderBadge(t.formatThousands(value), tone) : t.formatThousands(value)
    }

    const yesNo = (value: boolean | null | undefined): string => {
      if (value === null || value === undefined) return '—'
      return value ? '是' : '否'
    }

    // ── 顶部：生成时间 + 整体状态 + 异常摘要
    const warningHtml =
      report.warnings.length === 0
        ? ''
        : `<div class="filters" style="flex-wrap:wrap">${report.warnings
            .map((code) => t.renderBadge(warningLabel(code), 'warn'))
            .join(' ')}</div>`

    // ── 用量链路
    const usage = report.usage
    const usageFacts: (readonly [string, string])[] = []
    if (usage.service !== null) {
      usageFacts.push(
        ['明细条数', t.escapeText(t.formatThousands(usage.service.records))],
        ['轮询中', t.escapeText(yesNo(usage.service.polling))],
        ['连续失败轮数', alertCount(usage.service.consecutiveFailures, 'err')],
        ['最近错误', t.escapeText(usage.service.lastError ?? '—')],
        ['累计缺口条数', alertCount(usage.service.gapRecords, 'err')],
        ['隔离区（总数 / 待处理）', `${count(usage.service.rejectedCount)} / ${alertCount(usage.service.rejectedPending)}`],
        ['价格表可用', t.escapeText(yesNo(usage.service.pricingAvailable))],
        [
          '轮询游标',
          t.escapeText(`${usage.service.epoch ?? '（空）'} · seq ${usage.service.lastSeq}`),
        ],
      )
    }
    const gatewayFacts: (readonly [string, string])[] =
      usage.gateway === null
        ? []
        : [
            ['容量 / 当前条数', t.escapeText(`${t.formatThousands(usage.gateway.capacity)} / ${t.formatThousands(usage.gateway.size)}`)],
            ['累计丢弃', alertCount(usage.gateway.dropped, 'err')],
            ['其中真丢（缺口）', alertCount(usage.gateway.gap, 'err')],
            ['序号区间', t.escapeText(`${usage.gateway.firstSeq} – ${usage.gateway.lastSeq}`)],
            ['epoch', t.escapeText(usage.gateway.epoch)],
          ]

    // ── 结算
    const billing = report.billing
    const billingRows: (readonly [string, string])[] =
      billing.totals === null
        ? []
        : [
            ['记录总数', t.escapeText(t.formatThousands(billing.totals.records))],
            ['已结算', t.escapeText(t.formatThousands(billing.totals.settled))],
            ['待结算（推算）', t.escapeText(t.formatThousands(billing.totals.pending))],
            ['结算中', t.escapeText(t.formatThousands(billing.totals.settling))],
            ['无价格 / 无用户', t.escapeText(`${t.formatThousands(billing.totals.noPrice)} / ${t.formatThousands(billing.totals.noUser)}`)],
            ['失败', alertCount(billing.totals.failed, 'err')],
            ['待人工核查', alertCount(billing.totals.review, 'err')],
            ['透支笔数', alertCount(billing.totals.overdrawn, 'err')],
            ['累计扣费', t.escapeText(billing.chargedMicros === null ? '—' : `${formatYuan(billing.chargedMicros)}`)],
            [
              '今日（UTC，按请求发生日）',
              t.escapeText(
                billing.today === null
                  ? '—'
                  : `${billing.today.date} · ${t.formatThousands(billing.today.settled)} 笔 · ${formatYuan(billing.today.chargedMicros)}`,
              ),
            ],
          ]

    // ── 额度快照
    const quota = report.quota
    const quotaRows: (readonly [string, string])[] =
      quota.ready === null && quota.ageMs === null
        ? []
        : [
            [
              '已就绪',
              quota.ready === null ? '—' : quota.ready ? t.escapeText('是') : t.renderBadge('否', 'warn'),
            ],
            ['是否过期', quota.stale === null ? '—' : quota.stale ? t.renderBadge('已过期', 'err') : t.escapeText('否')],
            ['条目数', t.escapeText(count(quota.size))],
            ['年龄 / TTL', t.escapeText(`${count(quota.ageMs)}ms / ${count(quota.ttlMs)}ms`)],
            ['revision / generation', t.escapeText(`${quota.revision ?? '—'} / ${quota.generation ?? '—'}`)],
          ]

    // ── 账号运行时
    const runtime = report.runtime
    const runtimeRows: (readonly [string, string])[] =
      runtime.active === null && runtime.cooling === null
        ? []
        : [
            ['进行中的请求数', t.escapeText(count(runtime.active))],
            ['冷却中的账号数', alertCount(runtime.cooling, 'warn')],
          ]

    // ── 审计
    const audit = report.audit
    const actionRows = audit.recentActions.map((item) => [
      t.escapeText(auditActionLabel(item.action)),
      `<code class="mono">${t.escapeText(item.action)}</code>`,
      t.escapeText(t.formatThousands(item.count)),
    ])
    const auditRows = audit.latest.map((item) => [
      t.escapeText(shortTime(item.at)),
      t.escapeText(item.actor),
      t.escapeText(auditActionLabel(item.action)),
      t.escapeText(`${item.targetType}${item.targetId === '' ? '' : ` ${item.targetId}`}`),
      item.result === 'failed'
        ? t.renderBadge(`失败 ${item.errorCode ?? ''}`.trim(), 'err')
        : t.renderBadge('成功', 'ok'),
      t.escapeText(item.summary),
    ])

    // ── 账号池健康
    const accounts = report.accounts
    const accountsRows: (readonly [string, string])[] =
      accounts.total === 0 && accounts.lastPass === null
        ? []
        : [
            ['账号总数', t.escapeText(t.formatThousands(accounts.total))],
            ['启用中', t.escapeText(t.formatThousands(accounts.enabled))],
            ['健康 healthy / 降级 degraded', t.escapeText(`${t.formatThousands(accounts.healthy)} / ${t.formatThousands(accounts.degraded)}`)],
            ['不健康 unhealthy', alertCount(accounts.unhealthy, 'err')],
            ['未知 unknown', t.escapeText(t.formatThousands(accounts.unknown))],
            ['自动停用', alertCount(accounts.autoDisabled, 'warn')],
            ['检查在跑', t.escapeText(yesNo(accounts.running))],
            ['最近一轮（检查 / 通过 / 失败）', t.escapeText(
              accounts.lastPass === null
                ? '—'
                : `${accounts.lastPass.checked} / ${accounts.lastPass.healthy} / ${accounts.lastPass.failed}`,
            )],
            ['最近一轮时间', t.escapeText(shortTime(accounts.lastPassAt))],
          ]

    return renderAdminShell(
      ctx,
      [
        pageHeader(
          ctx,
          '运维总览',
          '全部只读、不落盘：用量链路、结算、额度快照、账号运行时、审计与账号池健康聚到一屏。' +
            '每个数据源单独标健康度，缺一个只降级那一块，不影响其它块。',
        ),
        t.renderStatCards(
          [
            { label: '生成时间（UTC）', value: shortTime(report.generatedAt) },
            { label: '异常项', value: t.formatThousands(report.warnings.length) },
            { label: '整体', value: report.degraded ? '有降级' : '正常' },
            { label: '用量缺口', value: t.formatThousands(usage.service?.gapRecords ?? 0) },
            { label: '待核查结算', value: t.formatThousands(billing.totals?.review ?? 0) },
            { label: '冷却账号', value: runtime.cooling === null ? '—' : t.formatThousands(runtime.cooling) },
            { label: '自动停用账号', value: t.formatThousands(accounts.autoDisabled) },
          ],
          'metrics',
        ),
        report.degraded
          ? t.renderNotice({
              kind: 'err',
              text: '有数据源降级或不可用：下面的卡片各自标注了原因，未标注的块数据是完整的。',
            })
          : '',
        warningHtml,

        block('用量链路（TS 轮询）', usage.health),
        usageFacts.length === 0 ? t.renderEmpty('用量服务不可用：看不到轮询状态') : facts(usageFacts),
        block('用量链路（Go 环形缓冲）', usage.gatewayHealth),
        gatewayFacts.length === 0 ? t.renderEmpty('读不到 Go 缓冲健康度') : facts(gatewayFacts),

        block('结算', billing.health),
        billingRows.length === 0 ? t.renderEmpty('结算服务不可用：看不到状态计数与扣费额') : facts(billingRows),

        block('额度快照（Go 侧余额只读快照）', quota.health),
        quotaRows.length === 0 ? t.renderEmpty('读不到额度快照状态') : facts(quotaRows),

        block('账号运行时（Go 侧全站聚合）', runtime.health),
        runtimeRows.length === 0 ? t.renderEmpty('读不到账号运行时计数') : facts(runtimeRows),

        block('审计（最近 24 小时）', audit.health),
        facts([
          ['记录总数', t.escapeText(t.formatThousands(audit.total))],
          ['失败操作', alertCount(audit.failed, 'err')],
          ['最近一条', t.escapeText(shortTime(audit.lastAt))],
          [
            '窗口',
            t.escapeText(
              `最多扫 ${t.formatThousands(audit.windowLimit)} 条${audit.windowTruncated ? '（已到上限，分组计数可能偏小）' : ''}`,
            ),
          ],
        ]),
        t.renderSectionTitle('24 小时内的动作分组'),
        t.renderTable({
          columns: [{ label: '动作' }, { label: '动作码' }, { label: '次数', align: 'right' }],
          rows: actionRows,
          empty: '最近 24 小时没有审计动作',
        }),
        t.renderSectionTitle('最近 5 条'),
        t.renderTable({
          columns: [
            { label: '时间（UTC）' },
            { label: '操作者' },
            { label: '动作' },
            { label: '目标' },
            { label: '结果' },
            { label: '摘要' },
          ],
          rows: auditRows,
          empty: '还没有审计记录',
        }),

        block('账号池健康', accounts.health),
        accountsRows.length === 0 ? t.renderEmpty('读不到账号池状态') : facts(accountsRows),
      ].join('\n'),
    )
  },
}
