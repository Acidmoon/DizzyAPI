/**
 * API keys：列表 + 创建 / 复制 / 停用 / 删除 / 编辑。
 *
 * owner 第 6 条的形态：**行上只留四个按钮**（复制 / 停用 / 删除 / 编辑），
 * 名称、过期时间、金额上限、并发上限、启停全部收进「编辑」弹窗。
 *
 * 三个上限是**真拦截**：它们由 Go 的 key-gate 在 pre 相位执行（401 过期 /
 * 402 金额上限 / 429 并发），不是只存着好看。金额一律整数微元，表单里是「元」，
 * 换算在字符串上做（`parseYuanToMicros`，不经过浮点）。
 *
 * 无 JS 降级：`<dialog>` 没脚本不显示，所以「编辑」在无脚本时是一个**普通链接**
 * （`/console/api-keys?edit=<id>`），点了走整页表单；有脚本时脚本把它拦下来开弹窗。
 */
import { pageHeader, renderConsoleShell, type PageContext, type PageModule } from '../layout.ts'
import {
  formatYuan,
  optionalString,
  parseYuanToMicros,
  requiredString,
  WebError,
} from '../forms.ts'
import type { ApiKeyView } from '../runtime.ts'

/** 并发上限的允许区间（与 api-key / Go 快照同一口径）。 */
const MIN_CONCURRENCY = 1
const MAX_CONCURRENCY = 100_000

/** 上限微元 → 元（去掉千分位与货币符号，回填输入框用）。 */
function microsToYuanInput(micros: string | null): string {
  if (micros === null) return ''
  const value = BigInt(micros)
  const whole = value / 1_000_000n
  const fraction = value % 1_000_000n
  if (fraction === 0n) return whole.toString()
  return `${whole.toString()}.${fraction.toString().padStart(6, '0').replace(/0+$/, '')}`
}

/**
 * 每个**配了金额上限**的 key 已消费多少（整数微元十进制字符串）。
 *
 * 为什么口径必须与闸门一模一样：Go 的 key-gate 判「超没超上限」用的是
 * `gate-feed` 推过去的 `usage.summary({apiKeyId})` —— 也就是**读取时按当前价格表算**。
 * 页面若换一个口径（例如 billing 已结算额）就会出现「页面显示 8 元、闸门按 10 元拦」，
 * 用户永远算不明白。所以这里调同一个方法。
 *
 * 成本：只查**有上限**的 key（没上限的 Go 侧根本不判金额），且按 api_key_id 走索引。
 * 读不到 / 抛错一律按 null（显示「—」），绝不因为一块附加信息把整页打挂。
 */
function spentOfKeys(
  usage: PageContext['services']['usage'],
  items: readonly ApiKeyView[],
): Map<string, string> {
  const result = new Map<string, string>()
  if (usage === undefined) return result
  for (const key of items) {
    if (key.spendingLimitMicros === null) continue
    try {
      const summary = usage.summary({ fromMs: 0, toMs: Number.MAX_SAFE_INTEGER, apiKeyId: key.id })
      const spent = summary.totals.costMicros
      if (typeof spent === 'string' && /^[0-9]+$/.test(spent)) result.set(key.id, spent)
    } catch {
      // 单条算不出来只少一个数，不影响页面。
    }
  }
  return result
}

/** `YYYY-MM-DD`（UTC 当天 00:00）或空。日期控件给的是日期，服务端要 ISO。 */
function dateToIso(value: string): string | null {
  if (value === '') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new WebError('WEB_BAD_DATE', '过期日期格式不对')
  return `${value}T00:00:00.000Z`
}

/** ISO → `YYYY-MM-DD`（回填日期控件）。 */
function isoToDate(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 10)
}

/** 编辑表单的字段集合：弹窗与无脚本整页共用同一份，避免两处漂移。 */
function renderEditForm(
  t: PageContext['t'],
  key: ApiKeyView,
  action: string,
): string {
  return `<form class="form" method="post" action="${action}">
<input type="hidden" name="id" value="${t.escapeAttr(key.id)}">
${t.renderField({ label: '名称', name: 'name', value: key.name, required: true })}
<div class="field">
<label for="f-expiresAt">过期时间（留空 = 永不过期）</label>
${t.renderDatePicker({ name: 'expiresAt', id: 'f-expiresAt', value: isoToDate(key.expiresAt), ariaLabel: '过期时间' })}
<span class="hint">到期后请求直接 401 API_KEY_EXPIRED，不转发上游。</span>
</div>
${t.renderField({
  label: '金额上限（元，留空 = 不限）',
  name: 'spendingLimitYuan',
  inputmode: 'decimal',
  value: microsToYuanInput(key.spendingLimitMicros),
  placeholder: '例如：100',
  hint: '累计消费达到上限后返回 402 API_KEY_SPENDING_LIMIT。',
})}
${t.renderField({
  label: `并发上限（${String(MIN_CONCURRENCY)}–${String(MAX_CONCURRENCY)}，留空 = 不限）`,
  name: 'concurrencyLimit',
  inputmode: 'numeric',
  value: key.concurrencyLimit === null ? '' : String(key.concurrencyLimit),
  placeholder: '例如：4',
  hint: '同时在飞的请求超过上限时返回 429 API_KEY_CONCURRENCY_LIMIT。',
})}
<div class="field">
<label class="hint"><input type="checkbox" name="enabled" value="1"${key.enabled ? ' checked' : ''}> 启用</label>
</div>
<div class="actions"><button class="btn" type="submit">保存</button></div>
</form>`
}

/** 表单 → patch：空字符串表示「清空该上限」，不传就是不改。 */
function readPatch(form: URLSearchParams): {
  name: string
  enabled: boolean
  expiresAt: string | null
  spendingLimitMicros: string | null
  concurrencyLimit: number | null
} {
  const name = requiredString(form, 'name', '名称')
  const enabled = form.get('enabled') === '1'

  const expiresAt = dateToIso(form.get('expiresAt')?.trim() ?? '')

  const limitText = form.get('spendingLimitYuan')?.trim() ?? ''
  let spendingLimitMicros: string | null = null
  if (limitText !== '') {
    const micros = parseYuanToMicros(limitText)
    if (micros <= 0n) throw new WebError('WEB_BAD_LIMIT', '金额上限必须大于 0（不想限制就留空）')
    spendingLimitMicros = micros.toString()
  }

  const concurrencyText = form.get('concurrencyLimit')?.trim() ?? ''
  let concurrencyLimit: number | null = null
  if (concurrencyText !== '') {
    if (!/^\d+$/.test(concurrencyText)) throw new WebError('WEB_BAD_LIMIT', '并发上限必须是整数')
    const parsed = Number(concurrencyText)
    if (parsed < MIN_CONCURRENCY || parsed > MAX_CONCURRENCY) {
      throw new WebError('WEB_BAD_LIMIT', `并发上限必须在 ${String(MIN_CONCURRENCY)}–${String(MAX_CONCURRENCY)} 之间`)
    }
    concurrencyLimit = parsed
  }

  return { name, enabled, expiresAt, spendingLimitMicros, concurrencyLimit }
}

export const keysPage: PageModule = {
  path: '/console/api-keys',
  area: 'console',
  title: 'API keys',
  auth: true,

  async render(ctx) {
    const t = ctx.t
    const keys = ctx.services.apiKey
    if (keys === undefined) {
      return renderConsoleShell(ctx, pageHeader(ctx, 'API keys') + t.renderNotice({ kind: 'err', text: 'API key 服务未运行' }))
    }
    const items = await keys.list(ctx.user.userId)
    const spentByKey = spentOfKeys(ctx.services.usage, items)
    const secret = ctx.query.get('new') === undefined ? undefined : ctx.takeSecret()
    // 无脚本降级：`?edit=<id>` 时把那张表单整页渲染在列表上方。
    const editing = ctx.query.get('edit')

    const secretBlock = secret === undefined
      ? ''
      : `${t.renderNotice({ kind: 'ok', text: '新的 API key 已生成，只显示这一次，请立即保存。' })}
<div class="panel panel--pad"><code class="mono">${t.escapeText(secret)}</code></div>`

    const rows = items.map((key) => {
      const toggle = `<form class="inline-form" method="post" action="/console/api-keys?action=toggle">
<input type="hidden" name="id" value="${t.escapeAttr(key.id)}">
<input type="hidden" name="enabled" value="${key.enabled ? '0' : '1'}">
<button class="btn small" type="submit">${key.enabled ? '停用' : '启用'}</button></form>`
      const remove = `<form class="inline-form" method="post" action="/console/api-keys?action=remove" data-confirm="删除后不可恢复，确定？">
<input type="hidden" name="id" value="${t.escapeAttr(key.id)}">
<button class="btn small danger" type="submit">删除</button></form>`
      const copy = key.secret === null
        ? ''
        : `<button class="btn small" type="button" data-copy="${t.escapeAttr(key.secret)}">复制</button>`
      // 编辑：有脚本时开弹窗，无脚本时退化成整页表单（同一个 action）。
      const edit = `<a class="btn small" href="/console/api-keys?edit=${encodeURIComponent(key.id)}"${t.dialogOpenAttr(`key-edit-${key.id}`)}>编辑</a>`
      const limitCell = key.spendingLimitMicros === null
        ? '—'
        : formatYuan(key.spendingLimitMicros)
      const spent = spentByKey.get(key.id)
      const spentCell = spent === undefined ? '—' : formatYuan(spent)
      const expiryCell = key.expiresAt === null ? '永不' : t.escapeText(key.expiresAt.slice(0, 10))
      return [
        t.escapeText(key.name),
        `<code class="mono">${t.escapeText(key.maskedKey)}</code>`,
        key.enabled ? t.renderBadge('启用', 'ok') : t.renderBadge('停用'),
        expiryCell,
        t.escapeText(spentCell),
        t.escapeText(limitCell),
        key.concurrencyLimit === null ? '—' : String(key.concurrencyLimit),
        t.escapeText(key.createdAt.slice(0, 10)),
        `<div class="actions">${copy}${toggle}${edit}${remove}</div>`,
      ]
    })

    // 无脚本入口：`?edit=<id>` 命中的那一行整页渲染表单。
    const editTarget = editing === null ? undefined : items.find((item) => item.id === editing)
    const inlineEdit = editTarget === undefined
      ? ''
      : `${t.renderSectionTitle(`编辑：${editTarget.name}`)}
${renderEditForm(t, editTarget, '/console/api-keys?action=edit')}`

    // 有脚本时的弹窗：每行一个，id 与 `dialogOpenAttr` 对应。
    const modals = items.map((key) =>
      t.renderModal({
        id: `key-edit-${key.id}`,
        title: `编辑：${key.name}`,
        size: 'wide',
        bodyHtml: renderEditForm(t, key, '/console/api-keys?action=edit'),
      }),
    )

    return renderConsoleShell(ctx, [
      pageHeader(ctx, 'API keys', '完整 key 只在创建 / 轮换时显示一次；列表里随时可复制。'),
      secretBlock,
      inlineEdit,
      `<form class="form form--wide form--spaced" method="post" action="/console/api-keys?action=create">
<div class="row row--stack-actions">
${t.renderField({ label: '名称', name: 'name', required: true, placeholder: '例如：本地开发' })}
<div class="actions"><button class="btn" type="submit">创建 API key</button></div>
</div>
</form>`,
      t.renderTable({
        columns: [
          { label: '名称' },
          { label: 'Key' },
          { label: '状态' },
          { label: '过期' },
          { label: '已消费', align: 'right' },
          { label: '金额上限', align: 'right' },
          { label: '并发', align: 'right' },
          { label: '创建' },
          { label: '操作' },
        ],
        rows,
        empty: '还没有 API key',
      }),
      ...modals,
    ].join('\n'))
  },

  actions: {
    create: async (ctx) => {
      const keys = ctx.services.apiKey
      if (keys === undefined) throw new WebError('WEB_NO_APIKEY', 'API key 服务未运行')
      const name = requiredString(ctx.form, 'name', '名称')
      const created = await keys.create(ctx.user.userId, { name })
      const id = ctx.stashSecret(created.secret)
      return `/console/api-keys?new=${encodeURIComponent(id)}`
    },

    /** 编辑弹窗 / 整页表单共用的动作：名称 + 三条上限 + 启停。 */
    edit: async (ctx) => {
      const keys = ctx.services.apiKey
      if (keys === undefined) throw new WebError('WEB_NO_APIKEY', 'API key 服务未运行')
      const id = requiredString(ctx.form, 'id', 'key')
      const patch = readPatch(ctx.form)
      await keys.update(ctx.user.userId, id, {
        name: patch.name,
        enabled: patch.enabled,
        expiresAt: patch.expiresAt,
        spendingLimitMicros: patch.spendingLimitMicros,
        concurrencyLimit: patch.concurrencyLimit,
      })
      return '/console/api-keys?ok=' + encodeURIComponent('已保存')
    },

    toggle: async (ctx) => {
      const keys = ctx.services.apiKey
      if (keys === undefined) throw new WebError('WEB_NO_APIKEY', 'API key 服务未运行')
      const id = requiredString(ctx.form, 'id', 'key')
      const enabled = ctx.form.get('enabled') === '1'
      await keys.update(ctx.user.userId, id, { enabled })
      return `/console/api-keys?ok=${encodeURIComponent(enabled ? '已启用' : '已停用')}`
    },

    rotate: async (ctx) => {
      const keys = ctx.services.apiKey
      if (keys === undefined) throw new WebError('WEB_NO_APIKEY', 'API key 服务未运行')
      const id = requiredString(ctx.form, 'id', 'key')
      const rotated = await keys.rotate(ctx.user.userId, id)
      const secretId = ctx.stashSecret(rotated.secret)
      return `/console/api-keys?new=${encodeURIComponent(secretId)}`
    },

    remove: async (ctx) => {
      const keys = ctx.services.apiKey
      if (keys === undefined) throw new WebError('WEB_NO_APIKEY', 'API key 服务未运行')
      const id = requiredString(ctx.form, 'id', 'key')
      await keys.remove(ctx.user.userId, id)
      return `/console/api-keys?ok=${encodeURIComponent('已删除')}`
    },
  },
}
