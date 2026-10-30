/**
 * 管理台 · 内容审核：维护关键词规则，看推送健康度与命中统计。
 *
 * 定位：
 * - **规则**由 `contentAudit` 插件唯一持有（`data/content-audit.json`），本页面只是它的门面；
 *   规则心跳式推给 Go 的 pre 相位闸门，命中就在网关拒绝（`block`）或只记日志（`log`）。
 * - **只做大小写不敏感的子串匹配**，本批没有正则（ReDoS）；页面把这条写清楚，
 *   免得有人填 `.*` 以为会生效。
 *
 * 三条界面纪律：
 * 1. **Go 侧读不到就给 null 并明确说「读不到」**，不显示成「0 命中、快照新鲜」——
 *    那会让人误判闸门在工作。
 * 2. **关键词与备注一律转义**（`escapeText`），它们来自管理员手填，可能是任意文本。
 * 3. 写动作都是表单 POST + 303，并走 `auditedAction` 留痕；审计元数据**不放关键字本身**。
 */
import { pageHeader, renderAdminShell, type PageModule } from '../layout.ts'
import { boolField, optionalString, requiredString, WebError } from '../forms.ts'
import { WEB_ACTOR } from '../runtime.ts'
import { auditedAction } from '../audit.ts'

const ACTION_LABEL: Readonly<Record<string, string>> = {
  block: '命中即拒绝',
  log: '命中只记日志',
}

const ACTION_TONE: Readonly<Record<string, 'ok' | 'err' | 'warn'>> = {
  block: 'err',
  log: 'warn',
}

function shortTime(iso: string | null): string {
  return iso === null || iso.length < 19 ? '—' : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}

function msOrDash(value: number | null): string {
  return value === null ? '—' : `${String(value)} ms`
}

function actionOf(form: URLSearchParams): 'block' | 'log' {
  const value = form.get('action') ?? 'block'
  if (value !== 'block' && value !== 'log') throw new WebError('WEB_FIELD_REQUIRED', '动作只能是拒绝或只记日志')
  return value
}

function snippet(text: string, limit = 60): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

export const adminContentAuditPage: PageModule = {
  path: '/admin/content-audit',
  area: 'admin',
  title: '内容审核',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const contentAudit = ctx.services.contentAudit
    if (contentAudit === undefined) {
      return renderAdminShell(
        ctx,
        pageHeader(ctx, '内容审核') +
          t.renderNotice({
            kind: 'err',
            text: '内容审核插件未运行：暂时不能维护审核规则（LLM 请求照常放行，不做内容拦截）',
          }),
      )
    }

    let rules: ReturnType<typeof contentAudit.list>
    let status: Awaited<ReturnType<typeof contentAudit.status>>
    try {
      rules = contentAudit.list(WEB_ACTOR)
      status = await contentAudit.status()
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取内容审核规则失败'
      return renderAdminShell(ctx, pageHeader(ctx, '内容审核') + t.renderNotice({ kind: 'err', text: message }))
    }

    const hits = status.hits
    const enabledRules = rules.filter((rule) => rule.enabled).length

    // ── 健康度提示：Go 侧读不到 / 快照过期 / 推送跟不上 / 闸门整体关闭
    const notices: string[] = []
    if (!status.enabled) {
      notices.push(
        t.renderNotice({
          kind: 'err',
          text: '审核总开关是关闭的（配置 enabled=false）：规则照常保存，但推给网关的是「禁用 + 空规则」，等于全放行。',
        }),
      )
    }
    if (hits === null) {
      notices.push(
        t.renderNotice({
          kind: 'err',
          text: '读不到 Go 侧状态（桥断或网关二进制过旧）：命中统计与快照新鲜度都是「未知」，不是 0。',
        }),
      )
    } else {
      if (status.stale === true) {
        notices.push(
          t.renderNotice({
            kind: 'err',
            text: '网关侧的规则快照已过期：默认策略是放行 + 告警，此刻不拦人。检查推送是否还在跑。',
          }),
        )
      }
      if (status.heartbeatTooSlow) {
        notices.push(
          t.renderNotice({
            kind: 'info',
            text: `推送间隔 ${String(status.pushIntervalMs)}ms 相对网关 TTL ${msOrDash(status.goTtlMs)} 太快撑不住：TTL 必须 ≥ 3 × 间隔，否则会周期性判过期。`,
          }),
        )
      }
      if (status.failureStreak > 0) {
        notices.push(
          t.renderNotice({
            kind: 'info',
            text: `连续 ${String(status.failureStreak)} 次推送失败，最近错误：${status.lastError ?? '—'}`,
          }),
        )
      }
    }

    const rows = rules.map((rule) => {
      const toggleLabel = rule.enabled ? '停用' : '启用'
      const actions = [
        `<form class="inline-form" method="post" action="/admin/content-audit?action=toggle">
<input type="hidden" name="ruleId" value="${t.escapeAttr(rule.id)}">
<input type="hidden" name="enabled" value="${rule.enabled ? '0' : '1'}">
<button class="btn small" type="submit">${t.escapeText(toggleLabel)}</button>
</form>`,
        `<form class="inline-form" method="post" action="/admin/content-audit?action=delete" data-confirm="删除后这条关键词立刻不再生效（会推一份新快照给网关），确定？">
<input type="hidden" name="ruleId" value="${t.escapeAttr(rule.id)}">
<button class="btn small" type="submit">删除</button>
</form>`,
      ].join(' ')

      const editForm = `<details class="muted"><summary>编辑</summary>
<form class="form form--wide" method="post" action="/admin/content-audit?action=edit">
<input type="hidden" name="ruleId" value="${t.escapeAttr(rule.id)}">
<input type="text" name="pattern" value="${t.escapeAttr(rule.pattern)}" maxlength="200" required>
${t.renderSelect({
  name: 'action',
  ariaLabel: '命中处理',
  allowEmpty: false,
  options: [
    { value: 'block', label: '命中即拒绝', selected: rule.action === 'block' },
    { value: 'log', label: '命中只记日志', selected: rule.action === 'log' },
  ],
})}
<input type="text" name="category" value="${t.escapeAttr(rule.category ?? '')}" placeholder="分类（可选）" maxlength="64">
<input type="text" name="note" value="${t.escapeAttr(rule.note ?? '')}" placeholder="备注（可选）" maxlength="200">
<button class="btn small" type="submit">保存</button>
</form>
</details>`

      return [
        `<code class="mono">${t.escapeText(snippet(rule.pattern))}</code>`,
        t.renderBadge(ACTION_LABEL[rule.action] ?? rule.action, ACTION_TONE[rule.action] ?? 'warn'),
        t.escapeText(rule.category ?? '—'),
        t.renderBadge(rule.enabled ? '启用中' : '已停用', rule.enabled ? 'ok' : 'warn'),
        t.escapeText(rule.note ?? '—'),
        t.escapeText(shortTime(rule.updatedAt)),
        `${actions} ${editForm}`,
      ]
    })

    const createForm = `<form class="form form--wide" method="post" action="/admin/content-audit?action=create">
<input type="text" name="pattern" placeholder="关键词（大小写不敏感的子串匹配）" maxlength="200" required>
${t.renderSelect({
  name: 'action',
  ariaLabel: '命中处理',
  allowEmpty: false,
  options: [
    { value: 'block', label: '命中即拒绝（403）', selected: true },
    { value: 'log', label: '命中只记日志（放行）' },
  ],
})}
<input type="text" name="category" placeholder="分类（可选）" maxlength="64">
<input type="text" name="note" placeholder="备注（可选）" maxlength="200">
<button class="btn" type="submit">新增规则</button>
</form>`

    const pushForm = `<form class="inline-form" method="post" action="/admin/content-audit?action=push">
<button class="btn small" type="submit">立刻推送一次</button>
</form>`

    const hitsLine =
      hits === null
        ? '—'
        : [
            `拦截 ${t.formatThousands(hits.blocked)}`,
            `只记日志 ${t.formatThousands(hits.logged)}`,
            `快照过期放行 ${t.formatThousands(hits.allowedStale)}`,
            `严格模式拒绝 ${t.formatThousands(hits.strictFailed)}`,
            `解析失败放行 ${t.formatThousands(hits.parseFailed)}`,
            `无可审文本 ${t.formatThousands(hits.noText)}`,
            `截断 ${t.formatThousands(hits.truncated)}`,
          ].join(' · ')

    const byRule = hits === null ? [] : Object.entries(hits.byRule)
    const byRuleHtml =
      byRule.length === 0
        ? ''
        : t.renderTable({
            columns: [{ label: '规则' }, { label: '命中次数', align: 'right' }],
            rows: byRule.map(([id, count]) => [
              `<code class="mono">${t.escapeText(id)}</code>`,
              t.escapeText(t.formatThousands(count)),
            ]),
            empty: '还没有规则命中',
          })

    return renderAdminShell(
      ctx,
      [
        pageHeader(
          ctx,
          '内容审核',
          '在请求链路 pre 相位检查用户输入文本：命中 block 规则返回 403 CONTENT_BLOCKED（不转发上游），' +
            '命中 log 规则只记日志与计数。只做大小写不敏感的子串匹配，本批不支持正则。' +
            '规则每个推送周期心跳式发给网关（内容不变也推），禁用的规则不推。',
        ),
        ...notices,
        // 改前 6 张等权卡片平铺。现在分「规则 / 命中 / 推送」三组。
        t.renderMetricGroups([
          {
            title: '规则',
            cards: [
              { label: '规则总数', value: t.formatThousands(rules.length), emphasis: 'primary' },
              { label: '启用中', value: t.formatThousands(enabledRules) },
            ],
          },
          {
            title: '命中',
            cards: [
              { label: '拦截次数', value: hits === null ? '—' : t.formatThousands(hits.blocked) },
              { label: '只记日志', value: hits === null ? '—' : t.formatThousands(hits.logged) },
            ],
          },
          {
            title: '推送',
            cards: [
              { label: '快照年龄', value: msOrDash(status.ageMs) },
              { label: '网关 TTL', value: msOrDash(status.ttlMs) },
            ],
          },
        ]),
        `<p class="muted">命中明细：${t.escapeText(hitsLine)}</p>`,
        `<p class="muted">最近推送：${t.escapeText(shortTime(status.lastPushAt))}（UTC）· ` +
          `累计 ${t.escapeText(t.formatThousands(status.pushes))} 次、其中心跳 ${t.escapeText(t.formatThousands(status.heartbeats))} 次 · ` +
          `revision <code class="mono">${t.escapeText(status.revision ?? '—')}</code> · ` +
          `审核${status.enabled ? '开启' : '关闭'} · 推送间隔 ${t.escapeText(String(status.pushIntervalMs))} ms</p>`,
        `<div class="filters">${pushForm}</div>`,
        // 用 renderSectionTitle（不是裸 <h2>）：区块节奏与其它页面一致。
        `${t.renderSectionTitle('新增规则')}\n${createForm}`,
        `${t.renderSectionTitle('规则列表')}\n` +
          t.renderTable({
            columns: [
              { label: '关键词' },
              { label: '动作' },
              { label: '分类' },
              { label: '状态' },
              { label: '备注' },
              { label: '更新（UTC）' },
              { label: '操作' },
            ],
            rows,
            empty: '还没有审核规则：添加后每个推送周期会心跳式发给网关',
          }),
        byRuleHtml === '' ? '' : `\n<h2>按规则命中</h2>\n${byRuleHtml}`,
      ].join('\n'),
    )
  },

  actions: {
    create: async (ctx) => {
      const contentAudit = ctx.services.contentAudit
      if (contentAudit === undefined) throw new WebError('WEB_NO_CONTENT_AUDIT', '内容审核插件未运行')
      const input = {
        pattern: requiredString(ctx.form, 'pattern', '关键词'),
        action: actionOf(ctx.form),
        ...(optionalString(ctx.form, 'category') === undefined
          ? {}
          : { category: optionalString(ctx.form, 'category') as string }),
        ...(optionalString(ctx.form, 'note') === undefined
          ? {}
          : { note: optionalString(ctx.form, 'note') as string }),
      }
      await auditedAction(
        ctx,
        {
          action: 'content_audit.rule.create',
          targetType: 'content-audit-rule',
          summary: `新增内容审核规则（${input.action}）`,
          // 元数据里**不放关键字本身**：审计表不必复制一份审核数据。
          metadataOf: (rule) => ({ ruleId: rule.id, action: rule.action, enabled: rule.enabled }),
        },
        () => contentAudit.create(WEB_ACTOR, input),
      )
      return `/admin/content-audit?ok=${encodeURIComponent('已新增审核规则，并已推送到网关')}`
    },

    edit: async (ctx) => {
      const contentAudit = ctx.services.contentAudit
      if (contentAudit === undefined) throw new WebError('WEB_NO_CONTENT_AUDIT', '内容审核插件未运行')
      const ruleId = requiredString(ctx.form, 'ruleId', '规则 id')
      const patch = {
        pattern: requiredString(ctx.form, 'pattern', '关键词'),
        action: actionOf(ctx.form),
        // 表单里的空串表示「清空」，服务层用 null 表达清空。
        category: optionalString(ctx.form, 'category') ?? null,
        note: optionalString(ctx.form, 'note') ?? null,
      }
      await auditedAction(
        ctx,
        {
          action: 'content_audit.rule.update',
          targetType: 'content-audit-rule',
          targetId: ruleId,
          summary: '修改内容审核规则',
          metadata: { fields: Object.keys(patch) },
          metadataOf: (rule) => ({ action: rule.action, enabled: rule.enabled }),
        },
        () => contentAudit.update(WEB_ACTOR, ruleId, patch),
      )
      return `/admin/content-audit?ok=${encodeURIComponent('规则已更新，并已推送到网关')}`
    },

    toggle: async (ctx) => {
      const contentAudit = ctx.services.contentAudit
      if (contentAudit === undefined) throw new WebError('WEB_NO_CONTENT_AUDIT', '内容审核插件未运行')
      const ruleId = requiredString(ctx.form, 'ruleId', '规则 id')
      const enabled = boolField(ctx.form, 'enabled')
      await auditedAction(
        ctx,
        {
          action: 'content_audit.rule.update',
          targetType: 'content-audit-rule',
          targetId: ruleId,
          summary: enabled ? '启用内容审核规则' : '停用内容审核规则',
          metadata: { fields: ['enabled'] },
          metadataOf: (rule) => ({ enabled: rule.enabled }),
        },
        () => contentAudit.update(WEB_ACTOR, ruleId, { enabled }),
      )
      const text = enabled ? '规则已启用，并已推送到网关' : '规则已停用，不再出现在推给网关的快照里'
      return `/admin/content-audit?ok=${encodeURIComponent(text)}`
    },

    delete: async (ctx) => {
      const contentAudit = ctx.services.contentAudit
      if (contentAudit === undefined) throw new WebError('WEB_NO_CONTENT_AUDIT', '内容审核插件未运行')
      const ruleId = requiredString(ctx.form, 'ruleId', '规则 id')
      const removed = await auditedAction(
        ctx,
        {
          action: 'content_audit.rule.delete',
          targetType: 'content-audit-rule',
          targetId: ruleId,
          summary: '删除内容审核规则',
        },
        () => contentAudit.remove(WEB_ACTOR, ruleId),
      )
      const text = removed ? '规则已删除，并已推送到网关' : '这条规则此前已被删除'
      return `/admin/content-audit?ok=${encodeURIComponent(text)}`
    },

    push: async (ctx) => {
      const contentAudit = ctx.services.contentAudit
      if (contentAudit === undefined) throw new WebError('WEB_NO_CONTENT_AUDIT', '内容审核插件未运行')
      const revision = await contentAudit.pushNow()
      const text =
        revision === null ? '推送失败：网关没有确认收到（玄错见日志与「最近错误」）' : `已推送：revision ${revision}`
      return `/admin/content-audit?ok=${encodeURIComponent(text)}`
    },
  },
}
