/**
 * 模型广场（用户页）：我们卖什么、多少钱、现在能不能用。
 *
 * 数据来自 `modelhub` 服务的只读聚合（价格表 + 账号声明的模型与协议）。
 * 页面**不查库、不调 HTTP**：直接拿进程内服务。
 *
 * 金额口径：`modelhub` 给的是「元 / 百万 token」的**十进制字符串**；这里用
 * `parseYuanToMicros` 换成整数微元后再显示，全程不经浮点（AGENTS.md §2.4.3）。
 */
import { pageHeader, renderConsoleShell, type PageModule } from '../layout.ts'
import { formatYuan, parseYuanToMicros } from '../forms.ts'

const AVAILABILITY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'available', label: '可用' },
  { value: 'unavailable', label: '不可用' },
]

const PRICED_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'priced', label: '已定价' },
  { value: 'unpriced', label: '未定价' },
]

/** 元 / 百万 token 的十进制字符串 → `¥3.75` 这样的展示串（经整数微元，不经浮点）。 */
function priceText(value: string | null): string {
  if (value === null || value === '') return '—'
  try {
    return formatYuan(parseYuanToMicros(value))
  } catch {
    // 价格表里的值理论上一定合法（写入时已校验）；真坏了也不该让整页 500。
    return '—'
  }
}

function filterLinks(
  path: string,
  query: URLSearchParams,
  options: readonly { value: string; label: string }[],
  key: string,
  escape: (value: string) => string,
): string {
  const items = options.map((option) => {
    const next = new URLSearchParams(query)
    if (option.value === '') next.delete(key)
    else next.set(key, option.value)
    const href = next.toString() === '' ? path : `${path}?${next.toString()}`
    const active = (query.get(key) ?? '') === option.value
    return `<a class="btn small${active ? ' active' : ''}" href="${escape(href)}">${option.label}</a>`
  })
  return `<div class="filters">${items.join('')}</div>`
}

export const modelsPage: PageModule = {
  path: '/console/models',
  area: 'console',
  title: '模型广场',
  auth: true,

  async render(ctx) {
    const t = ctx.t
    const header = pageHeader(
      ctx,
      '模型广场',
      '这里列出当前可供调用的模型、单价与可用性。单价单位是「元 / 每百万 token」；' +
        '实际扣费按请求的真实 token 用量计算（后付费）。',
    )

    const modelhub = ctx.services.modelhub
    if (modelhub === undefined) {
      return renderConsoleShell(
        ctx,
        `${header}\n${t.renderNotice({ kind: 'err', text: '模型广场服务未运行，暂时看不到模型目录' })}`,
      )
    }

    const search = (ctx.query.get('search') ?? '').trim()
    const availability = ctx.query.get('availability') ?? ''
    const priced = ctx.query.get('priced') ?? ''
    const catalog = modelhub.catalog({
      ...(search === '' ? {} : { search }),
      ...(availability === '' ? {} : { availability: availability as 'available' | 'unavailable' }),
      ...(priced === '' ? {} : { priced: priced as 'priced' | 'unpriced' }),
    })

    const rows = catalog.available.map((entry) => [
      `<code class="mono">${t.escapeText(entry.model)}</code>`,
      t.escapeText(priceText(entry.price?.inputPerMillion ?? null)),
      t.escapeText(priceText(entry.price?.outputPerMillion ?? null)),
      t.escapeText(priceText(entry.price?.cacheReadPerMillion ?? null)),
      t.escapeText(priceText(entry.price?.cacheWritePerMillion ?? null)),
      entry.priced ? t.renderBadge('已定价', 'ok') : t.renderBadge('未定价', 'warn'),
      t.renderBadge('可用', 'ok'),
      t.escapeText(`${entry.healthyAccountCount}/${entry.accountCount}`),
      t.escapeText(entry.protocols.length === 0 ? '未声明' : entry.protocols.join(' / ')),
      t.escapeText(entry.mapped ? entry.upstreamModels.join(' / ') : '—'),
    ])

    const unavailableRows = catalog.unavailable.map((entry) => [
      `<code class="mono">${t.escapeText(entry.model)}</code>`,
      t.escapeText(priceText(entry.price?.inputPerMillion ?? null)),
      t.escapeText(priceText(entry.price?.outputPerMillion ?? null)),
      entry.priced ? t.renderBadge('已定价', 'ok') : t.renderBadge('未定价', 'warn'),
      t.renderBadge('不可用', 'err'),
      t.escapeText(entry.detail),
    ])

    return renderConsoleShell(
      ctx,
      [
        header,
        t.renderStatCards(
          [
            { label: '可用模型', value: t.formatThousands(catalog.summary.availableCount) },
            { label: '不可用', value: t.formatThousands(catalog.summary.unavailableCount) },
            { label: '已定价', value: t.formatThousands(catalog.summary.pricedCount) },
            { label: '参与统计的账号', value: t.formatThousands(catalog.summary.accountCount) },
          ],
          'metrics',
        ),
        `<form class="form" method="get" action="/console/models" style="max-width:none;margin-bottom:16px">
<div class="row">
${t.renderField({ label: '搜索模型', name: 'search', required: false, value: search, placeholder: '例如 deepseek' })}
<div class="actions"><button class="btn" type="submit">筛选</button></div>
</div>
</form>`,
        filterLinks('/console/models', ctx.query, AVAILABILITY_OPTIONS, 'availability', (value) =>
          t.escapeAttr(value),
        ),
        filterLinks('/console/models', ctx.query, PRICED_OPTIONS, 'priced', (value) => t.escapeAttr(value)),
        t.renderSectionTitle('可用模型'),
        t.renderTable({
          columns: [
            { label: '模型' },
            { label: '输入 / 百万', align: 'right' },
            { label: '输出 / 百万', align: 'right' },
            { label: '缓存读 / 百万', align: 'right' },
            { label: '缓存写 / 百万', align: 'right' },
            { label: '定价' },
            { label: '可用性' },
            { label: '健康 / 总账号' },
            { label: '协议' },
            { label: '上游模型名' },
          ],
          rows,
          empty: '没有符合条件的可用模型',
        }),
        unavailableRows.length === 0
          ? ''
          : [
              t.renderSectionTitle('暂不可用'),
              t.renderTable({
                columns: [
                  { label: '模型' },
                  { label: '输入 / 百万', align: 'right' },
                  { label: '输出 / 百万', align: 'right' },
                  { label: '定价' },
                  { label: '可用性' },
                  { label: '原因' },
                ],
                rows: unavailableRows,
                empty: '没有不可用的模型',
              }),
            ].join('\n'),
        t.renderNotice({
          kind: 'info',
          text:
            '「可用」= 至少一个账号当前能提供这个模型（启用、凭据已配、未过期、健康状态不是不健康）；' +
            '「未定价」的模型仍可调用，但费用按 0 计算，直到在管理台配上价格。',
        }),
      ].join('\n'),
    )
  },
}
