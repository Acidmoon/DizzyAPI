/**
 * 管理台 · 上游账号详情（`/admin/accounts/detail?id=xxx`）。
 *
 * web 的路由是精确路径匹配、没有路径参数，所以详情固定用 query 传 id。
 * 页面按「基本信息 / 调度参数 / 健康与自动停用 / 凭据与令牌 / 危险操作」分组折叠，
 * 默认只展开基本信息——控件多起来之后平铺一页不可用。
 */
import { pageHeader, renderAdminShell, type ActionContext, type PageContext, type PageModule } from '../layout.ts'
import { renderSelectShell } from '@dizzyapi/plugin-page-template'
import { requiredString, WebError } from '../forms.ts'
import { WEB_ACTOR, type AccountUpdatePatch, type AccountView } from '../runtime.ts'
import { auditedAction } from '../audit.ts'
import {
  errorText,
  formatNumber,
  formatTime,
  healthBadge,
  healthText,
  parseLabels,
  statusBadge,
} from '../accounts.ts'

const PATH = '/admin/accounts/detail'

export const adminAccountDetailPage: PageModule = {
  path: PATH,
  area: 'admin',
  title: '账号详情',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const admin = ctx.services.accountAdmin
    if (admin === undefined) {
      return renderAdminShell(ctx, pageHeader(ctx, '账号详情') + t.renderNotice({ kind: 'err', text: '账号服务未运行' }))
    }
    const id = ctx.query.get('id')?.trim() ?? ''
    if (id === '') {
      return renderAdminShell(
        ctx,
        pageHeader(ctx, '账号详情') +
          t.renderNotice({ kind: 'err', text: '缺少账号 id：请从上游账号列表点进来' }) +
          '<p><a class="btn" href="/admin/accounts">返回列表</a></p>',
      )
    }

    let account: AccountView
    try {
      account = admin.get(id)
    } catch (error) {
      return renderAdminShell(
        ctx,
        pageHeader(ctx, '账号详情') +
          t.renderNotice({ kind: 'err', text: errorText(error) }) +
          '<p><a class="btn" href="/admin/accounts">返回列表</a></p>',
      )
    }

    const back = `/admin/accounts/detail?id=${encodeURIComponent(account.id)}`
    const modelsText = account.models === null ? '' : account.models.join(', ')
    const modelMapText =
      account.modelMap === null
        ? ''
        : Object.entries(account.modelMap)
            .map(([key, value]) => `${key}=${value}`)
            .join('\n')

    return renderAdminShell(ctx, [
      pageHeader(
        ctx,
        account.label,
        `${account.provider} / ${account.kind} · ${account.id} · 最近使用 ${formatTime(account.lastUsedAt)}`,
      ),
      `<p>${account.enabled ? t.renderBadge('启用', 'ok') : t.renderBadge('停用')} ${statusBadge(t, account.status)} ${healthBadge(t, account.health)} ${account.credentialConfigured ? t.renderBadge('凭据已配置', 'ok') : t.renderBadge('缺凭据', 'warn')}</p>`,
      account.status === 'auto_disabled'
        ? t.renderNotice({
            kind: 'info',
            text: `系统自动停用于 ${formatTime(account.autoDisabledAt)}：${account.autoDisabledReason ?? '（没有原因）'}`,
          })
        : '',
      account.status === 'needs_reauth'
        ? t.renderNotice({ kind: 'err', text: '刷新令牌已失效：需要重新导入凭据（自动恢复不会碰这个状态）。' })
        : '',

      group('基本信息', true, `
<form class="form" method="post" action="${PATH}?action=update&id=${encodeURIComponent(account.id)}">
<div class="row">
${t.renderField({ label: '名称', name: 'label', required: true, value: account.label })}
${t.renderField({ label: '邮箱', name: 'email', value: account.email ?? '' })}
${t.renderField({ label: '上游主体', name: 'subject', value: account.subject ?? '' })}
</div>
<div class="row">
${t.renderField({ label: 'Base URL', name: 'baseUrl', value: account.baseUrl ?? '', placeholder: 'https://upstream.example.com/v1' })}
${selectField('上游协议', 'protocol', [
  { value: '', label: '未声明（走旧行为）' },
  { value: 'openai-chat', label: 'openai-chat' },
  { value: 'openai-responses', label: 'openai-responses' },
  { value: 'anthropic', label: 'anthropic' },
  { value: 'gemini', label: 'gemini' },
], account.protocol ?? '')}
</div>
<div class="row">
${textareaField('对外模型名（逗号分隔，留空 = 不参与模型路由）', 'models', modelsText)}
${textareaField('模型映射（每行 对外名=上游名，留空 = 不改写）', 'modelMap', modelMapText)}
</div>
<div class="actions"><button class="btn" type="submit">保存基本信息</button></div>
</form>`),

      group('调度参数', false, `
<form class="form" method="post" action="${PATH}?action=scheduling&id=${encodeURIComponent(account.id)}">
<div class="row">
${t.renderField({ label: '标签（逗号分隔；留空 = 清空）', name: 'labels', value: account.labels.join(', '), placeholder: 'tier:pro, team:ops' })}
${t.renderField({ label: '权重（> 0；留空 = 未声明）', name: 'weight', value: formatValue(account.weight), placeholder: '2.5' })}
${t.renderField({ label: '并发上限（1–10000；留空 = 未声明）', name: 'concurrency', value: formatValue(account.concurrency), placeholder: '4' })}
${t.renderField({ label: '优先级（0–1000）', name: 'priority', value: String(account.priority) })}
</div>
<p class="hint">标签会转成 Go 侧的 tags（「key:value」精确匹配；不带冒号的标签记为「标签名 加空值」）。权重与并发上限进账号快照，参与打分与容量过滤。</p>
<div class="actions"><button class="btn" type="submit">保存调度参数</button></div>
</form>`),

      group('健康与自动停用', false, `
<p>当前健康状态：${healthBadge(t, account.health)}（${t.escapeText(healthText(account.health))}）</p>
<form class="form" method="post" action="${PATH}?action=health&id=${encodeURIComponent(account.id)}">
<div class="row">
${selectField('健康状态', 'health', [
  { value: 'unknown', label: '未知（unknown）' },
  { value: 'healthy', label: '健康（healthy）' },
  { value: 'degraded', label: '降级（degraded）' },
  { value: 'unhealthy', label: '不健康（unhealthy）' },
], account.health)}
<div class="actions"><button class="btn" type="submit">保存健康状态</button></div>
</div>
</form>
<form class="form" method="post" action="${PATH}?action=${account.status === 'auto_disabled' ? 'recover' : 'autoDisable'}&id=${encodeURIComponent(account.id)}">
${account.status === 'auto_disabled'
  ? `<p class="hint">自动停用时间 ${formatTime(account.autoDisabledAt)}；原因：${t.escapeText(account.autoDisabledReason ?? '—')}</p>
<div class="actions"><button class="btn" type="submit">解除自动停用（恢复 active）</button></div>`
  : `<div class="row">${t.renderField({ label: '模拟自动停用的原因', name: 'reason', placeholder: '连续失败 3 次：HTTP 502' })}</div>
<p class="hint">这是人工复核用的入口：只把 status 改成 auto_disabled，不动「启用 / 停用」开关。</p>
<div class="actions"><button class="btn small danger" type="submit">标记为自动停用</button></div>`}
</form>`),

      group('凭据与令牌', false, `
${renderKeyValueTable(t, [
  ['凭据引用', account.credentialRef],
  ['凭据状态', account.credentialConfigured ? '已配置' : '未配置'],
  ['访问令牌过期', formatTime(account.accessExpiresAt)],
  ['下次刷新', formatTime(account.refreshDueAt)],
  ['最近刷新', formatTime(account.lastRefreshAt)],
  ['最近错误', account.lastError ?? '—'],
  ['刷新失败次数', String(account.failureCount)],
  ['退避截止', formatTime(account.backoffUntil)],
])}
<form class="inline-form" method="post" action="${PATH}?action=refresh&id=${encodeURIComponent(account.id)}">
<button class="btn small" type="submit">立即刷新令牌</button></form>
<form class="inline-form" method="post" action="${PATH}?action=test&id=${encodeURIComponent(account.id)}">
<button class="btn small" type="submit">测试连接</button></form>
<p class="hint">最近测试：${account.lastTestOk === null
  ? '未测试'
  : account.lastTestOk
    ? `成功 ${account.lastTestLatencyMs ?? 0}ms（${formatTime(account.lastTestAt)}）`
    : `失败：${t.escapeText(account.lastTestError ?? '未知错误')}（${formatTime(account.lastTestAt)}）`}</p>`),

      group('危险操作', false, `
<p class="hint">删除会同时清掉这个账号的凭据，不可恢复。</p>
<form class="inline-form" method="post" action="${PATH}?action=remove&id=${encodeURIComponent(account.id)}" data-confirm="删除账号不可恢复，确定？">
<button class="btn small danger" type="submit">删除账号</button></form>`),

      `<p><a class="btn" href="/admin/accounts">返回列表</a> <a class="btn" href="${back}">刷新本页</a></p>`,
    ]
      .filter((block) => block !== '')
      .join('\n'))
  },

  actions: {
    async update(ctx) {
      const admin = requireAdmin(ctx)
      const id = requireAccountId(ctx)
      const patch: Record<string, unknown> = {
        label: requiredString(ctx.form, 'label', '名称'),
        email: ctx.form.get('email')?.trim() ?? '',
        subject: ctx.form.get('subject')?.trim() ?? '',
        baseUrl: ctx.form.get('baseUrl')?.trim() ?? '',
        protocol: ctx.form.get('protocol')?.trim() ?? '',
      }
      const models = parseCsv(ctx.form.get('models') ?? '')
      const modelMap = parseModelMap(ctx.form.get('modelMap') ?? '')
      patch.models = models.length === 0 ? null : models
      patch.modelMap = Object.keys(modelMap).length === 0 ? null : modelMap
      await auditedAction(
        ctx,
        {
          action: 'account.update',
          targetType: 'account',
          targetId: id,
          summary: `修改上游账号 ${id} 的基本信息`,
          metadata: { fields: Object.keys(patch) },
        },
        () => admin.update(WEB_ACTOR, id, patch as AccountUpdatePatch),
      )
      return `${PATH}?id=${encodeURIComponent(id)}&ok=${encodeURIComponent('基本信息已保存')}`
    },

    async scheduling(ctx) {
      const admin = requireAdmin(ctx)
      const id = requireAccountId(ctx)
      const weightText = ctx.form.get('weight')?.trim() ?? ''
      const concurrencyText = ctx.form.get('concurrency')?.trim() ?? ''
      const priorityText = ctx.form.get('priority')?.trim() ?? ''
      const patch: AccountUpdatePatch = {
        labels: parseLabels(ctx.form.get('labels') ?? ''),
        weight: weightText === '' ? null : parseNumber(weightText, '权重', (value) => value > 0),
        concurrency:
          concurrencyText === ''
            ? null
            : parseNumber(concurrencyText, '并发上限', (value) => Number.isInteger(value) && value >= 1),
        priority: parseNumber(priorityText === '' ? '0' : priorityText, '优先级', (value) =>
          Number.isInteger(value) && value >= 0 && value <= 1_000,
        ),
      }
      await auditedAction(
        ctx,
        {
          action: 'account.scheduling',
          targetType: 'account',
          targetId: id,
          summary: `修改上游账号 ${id} 的调度参数（标签 / 权重 / 并发 / 优先级）`,
          metadata: {
            labels: patch.labels ?? [],
            priority: patch.priority ?? 0,
          },
        },
        () => admin.update(WEB_ACTOR, id, patch),
      )
      return `${PATH}?id=${encodeURIComponent(id)}&ok=${encodeURIComponent('调度参数已保存')}`
    },

    async health(ctx) {
      const admin = requireAdmin(ctx)
      const id = requireAccountId(ctx)
      const health = requiredString(ctx.form, 'health', '健康状态')
      await auditedAction(
        ctx,
        {
          action: 'account.health.set',
          targetType: 'account',
          targetId: id,
          summary: `把上游账号 ${id} 的健康状态改为 ${health}`,
          metadata: { health },
        },
        () => admin.setHealth(WEB_ACTOR, id, health),
      )
      return `${PATH}?id=${encodeURIComponent(id)}&ok=${encodeURIComponent('健康状态已保存')}`
    },

    async autoDisable(ctx) {
      const admin = requireAdmin(ctx)
      const id = requireAccountId(ctx)
      const reason = requiredString(ctx.form, 'reason', '原因')
      await auditedAction(
        ctx,
        {
          action: 'account.auto_disable',
          targetType: 'account',
          targetId: id,
          summary: `把上游账号 ${id} 标记为自动停用：${reason}`,
          metadata: { reason },
        },
        () => admin.autoDisable(WEB_ACTOR, id, reason),
      )
      return `${PATH}?id=${encodeURIComponent(id)}&ok=${encodeURIComponent('已标记为自动停用')}`
    },

    async recover(ctx) {
      const admin = requireAdmin(ctx)
      const id = requireAccountId(ctx)
      await auditedAction(
        ctx,
        {
          action: 'account.auto_enable',
          targetType: 'account',
          targetId: id,
          summary: `解除上游账号 ${id} 的自动停用`,
        },
        () => admin.autoEnable(WEB_ACTOR, id),
      )
      return `${PATH}?id=${encodeURIComponent(id)}&ok=${encodeURIComponent('已解除自动停用')}`
    },

    async refresh(ctx) {
      const admin = requireAdmin(ctx)
      const id = requireAccountId(ctx)
      await auditedAction(
        ctx,
        {
          action: 'account.refresh',
          targetType: 'account',
          targetId: id,
          summary: `刷新上游账号 ${id} 的令牌`,
        },
        () => admin.refresh(WEB_ACTOR, id),
      )
      return `${PATH}?id=${encodeURIComponent(id)}&ok=${encodeURIComponent('令牌已刷新')}`
    },

    async test(ctx) {
      const admin = requireAdmin(ctx)
      const id = requireAccountId(ctx)
      // 连通性测试不改状态，不记审计。
      const result = await admin.testConnection(id)
      const message = result.ok ? `连接成功（${result.latencyMs}ms）` : `连接失败：${result.error ?? '未知错误'}`
      return `${PATH}?id=${encodeURIComponent(id)}&${result.ok ? 'ok' : 'err'}=${encodeURIComponent(message)}`
    },

    async remove(ctx) {
      const admin = requireAdmin(ctx)
      const id = requireAccountId(ctx)
      await auditedAction(
        ctx,
        {
          action: 'account.remove',
          targetType: 'account',
          targetId: id,
          summary: `删除上游账号 ${id}`,
        },
        () => admin.remove(WEB_ACTOR, id),
      )
      return '/admin/accounts?ok=' + encodeURIComponent('账号已删除')
    },
  },
}

function requireAdmin(ctx: PageContext | ActionContext) {
  const admin = ctx.services.accountAdmin
  if (admin === undefined) throw new WebError('WEB_NO_ACCOUNT', '账号服务未运行')
  return admin
}

function requireAccountId(ctx: ActionContext): string {
  return requiredString(ctx.form, 'id', '账号')
}

function group(title: string, open: boolean, content: string): string {
  return `<details class="card"${open ? ' open' : ''}>
<summary>${escapeSummary(title)}</summary>
${content}
</details>`
}

/** `<summary>` 里只有固定标题，不需要转义外部数据；保留这个薄封装是为了统一写法。 */
function escapeSummary(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function formatValue(value: number | null): string {
  return value === null ? '' : String(value)
}

function selectField(
  label: string,
  name: string,
  options: readonly { readonly value: string; readonly label: string }[],
  current: string,
): string {
  const body = options
    .map(
      (option) =>
        `<option value="${escapeAttr(option.value)}"${option.value === current ? ' selected' : ''}>${escapeText(option.label)}</option>`,
    )
    .join('')
  return `<div class="field">
<label for="f-${escapeAttr(name)}">${escapeText(label)}</label>
${renderSelectShell({ name, id: `f-${name}`, optionsHtml: body })}
</div>`
}

function textareaField(label: string, name: string, value: string): string {
  return `<div class="field">
<label for="f-${escapeAttr(name)}">${escapeText(label)}</label>
<textarea class="input" id="f-${escapeAttr(name)}" name="${escapeAttr(name)}" rows="3">${escapeText(value)}</textarea>
</div>`
}

function renderKeyValueTable(
  t: import('@dizzyapi/plugin-page-template').PageTemplateService,
  rows: readonly (readonly [string, string])[],
): string {
  return t.renderTable({
    columns: [{ label: '项目' }, { label: '值' }],
    rows: rows.map(([key, value]) => [t.escapeText(key), t.escapeText(value)]),
  })
}

function parseCsv(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

function parseModelMap(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) {
      throw new WebError('WEB_ACCOUNT_MODEL_MAP', `模型映射的每一行都要写成「对外名=上游名」：${trimmed}`)
    }
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if (key === '' || value === '') {
      throw new WebError('WEB_ACCOUNT_MODEL_MAP', '模型映射的键与值都不能为空')
    }
    result[key] = value
  }
  return result
}

function parseNumber(text: string, field: string, accept: (value: number) => boolean): number {
  const value = Number(text)
  if (!Number.isFinite(value) || !accept(value)) {
    throw new WebError('WEB_ACCOUNT_NUMBER_INVALID', `${field}不合法：${text}`)
  }
  return value
}

function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttr(value: string): string {
  return escapeText(value)
}
