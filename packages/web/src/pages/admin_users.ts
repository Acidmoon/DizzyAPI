/**
 * 管理台 · 用户：列表 + 「编辑」弹窗。
 *
 * owner 第 8 条：原来「封禁 / 设管理员 / 删除」是三个行内按钮、余额调整是一整块独立表单；
 * 现在行上只留「编辑」，改名 / 角色 / 状态 / 余额调整 / 并发上限全部收进弹窗。
 *
 * 余额只经 `user.adjustBalance`（整数微元，表单里是「元」，字符串换算不经浮点）；
 * 每次写操作都过 `auditedAction` 留痕，金额记十进制字符串（不落浮点）。
 *
 * 无 JS 降级：「编辑」在无脚本时是普通链接（`?edit=<id>`），点了渲染整页表单。
 */
import { pageHeader, renderAdminShell, type PageContext, type PageModule } from '../layout.ts'
import { formatYuan, requiredString, WebError } from '../forms.ts'
import { WEB_ACTOR } from '../runtime.ts'
import { auditedAction } from '../audit.ts'
import type { UserView } from '../runtime.ts'

const MIN_CONCURRENCY = 1
const MAX_CONCURRENCY = 100_000

/**
 * 编辑表单：改名 / 角色 / 状态 / 余额调整 / 并发上限。
 *
 * 三件事分三个 POST 动作（`edit` / `balance` / `remove`），因为它们的审计动作码不同、
 * 失败语义也不同（余额调整失败要能单独提示）；弹窗底部给一颗保存按钮提交 `edit`。
 */
function renderEditForm(
  t: PageContext['t'],
  user: UserView,
  action: string,
): string {
  return `<form class="form" method="post" action="${action}">
<input type="hidden" name="id" value="${String(user.id)}">
${t.renderField({ label: '名称', name: 'name', value: user.name, required: true })}
<div class="field">
<label for="f-role">角色</label>
${t.renderSelect({
  name: 'role',
  id: 'f-role',
  allowEmpty: false,
  options: [
    { value: 'user', label: '用户', selected: user.role === 'user' },
    { value: 'admin', label: '管理员', selected: user.role === 'admin' },
  ],
})}
</div>
<div class="field">
<label for="f-status">状态</label>
${t.renderSelect({
  name: 'status',
  id: 'f-status',
  allowEmpty: false,
  options: [
    { value: 'enabled', label: '正常', selected: user.status === 'enabled' },
    { value: 'banned', label: '已封禁', selected: user.status === 'banned' },
  ],
})}
</div>
${t.renderField({
  label: `并发上限（${String(MIN_CONCURRENCY)}–${String(MAX_CONCURRENCY)}，留空 = 不限）`,
  name: 'concurrencyLimit',
  inputmode: 'numeric',
  value: user.concurrencyLimit === null ? '' : String(user.concurrencyLimit),
  placeholder: '例如：8',
  hint: '该用户所有 key 的在飞请求合计超过上限时返回 429 USER_CONCURRENCY_LIMIT。',
})}
<div class="actions"><button class="btn" type="submit">保存</button></div>
</form>`
}

/** 余额调整表单：独立 POST（审计动作码与上面不同）。 */
function renderBalanceForm(t: PageContext['t'], user: UserView): string {
  return `<form class="form form--spaced" method="post" action="/admin/users?action=balance">
<input type="hidden" name="id" value="${String(user.id)}">
${t.renderField({
  label: `增减（元）— 当前 ${formatYuan(user.balance)}`,
  name: 'deltaYuan',
  inputmode: 'decimal',
  required: true,
  placeholder: '例如：10 或 -5.5',
  hint: '正数加、负数减；最多两位小数。余额允许为负 = 后付费。',
})}
${t.renderField({ label: '原因', name: 'reason', required: true, placeholder: '例如：充值 / 补偿' })}
<div class="actions"><button class="btn" type="submit">调整余额</button></div>
</form>`
}

/** 删除用户的独立表单（带确认）。 */
function renderRemoveForm(user: UserView): string {
  return `<form class="inline-form" method="post" action="/admin/users?action=remove" data-confirm="删除用户不可恢复，确定？">
<input type="hidden" name="id" value="${String(user.id)}">
<button class="btn small danger" type="submit">删除用户</button></form>`
}

/** `10` / `-5.5` → 微元；拒绝超过两位小数（余额只精确到分，与页面展示一致）。 */
function parseYuanToMicros(text: string): bigint {
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) throw new WebError('WEB_BAD_AMOUNT', '金额最多两位小数')
  const negative = text.startsWith('-')
  const [yuan, fraction = ''] = (negative ? text.slice(1) : text).split('.')
  const micros = BigInt(yuan) * 1_000_000n + BigInt(fraction.padEnd(2, '0')) * 10_000n
  return negative ? -micros : micros
}

export const adminUsersPage: PageModule = {
  path: '/admin/users',
  area: 'admin',
  title: '用户',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const users = ctx.services.user
    if (users === undefined) {
      return renderAdminShell(ctx, pageHeader(ctx, '用户') + t.renderNotice({ kind: 'err', text: '用户服务未运行' }))
    }
    const list = await users.list({ limit: 100 })
    const rows = list.map((user) => {
      const edit = `<a class="btn small" href="/admin/users?edit=${String(user.id)}"${t.dialogOpenAttr(`user-edit-${String(user.id)}`)}>编辑</a>`
      return [
        String(user.id),
        t.escapeText(user.name),
        user.role === 'admin' ? t.renderBadge('管理员', 'ok') : t.renderBadge('用户'),
        user.status === 'enabled' ? t.renderBadge('正常', 'ok') : t.renderBadge('已封禁', 'err'),
        t.escapeText(formatYuan(user.balance)),
        user.concurrencyLimit === null ? '—' : String(user.concurrencyLimit),
        `<div class="actions">${edit}</div>`,
      ]
    })

    // 无脚本降级：`?edit=<id>` 命中的那一行整页渲染。
    const editing = ctx.query.get('edit')
    const editTarget = editing === null ? undefined : list.find((user) => String(user.id) === editing)
    const inlineEdit = editTarget === undefined
      ? ''
      : `${t.renderSectionTitle(`编辑：${editTarget.name}`)}
${renderEditForm(t, editTarget, '/admin/users?action=edit')}`

    // 有脚本：每行一个弹窗（正文 = 编辑表单 + 余额调整 + 删除）。
    const modals = list.map((user) =>
      t.renderModal({
        id: `user-edit-${String(user.id)}`,
        title: `编辑用户：${user.name}`,
        size: 'wide',
        bodyHtml: [
          renderEditForm(t, user, '/admin/users?action=edit'),
          `<p class="hint p--spaced">余额调整单独提交（审计动作码不同）。</p>`,
          renderBalanceForm(t, user),
          `<div class="actions">${renderRemoveForm(user)}</div>`,
        ].join('\n'),
      }),
    )

    return renderAdminShell(ctx, [
      pageHeader(ctx, '用户', `共 ${String(list.length)} 个用户；余额以整数微元存储。`),
      inlineEdit,
      t.renderTable({
        columns: [
          { label: 'ID' },
          { label: '名称' },
          { label: '角色' },
          { label: '状态' },
          { label: '余额', align: 'right' },
          { label: '并发', align: 'right' },
          { label: '操作' },
        ],
        rows,
        empty: '还没有用户',
      }),
      ...modals,
    ].join('\n'))
  },

  actions: {
    /** 弹窗保存：名称 / 角色 / 状态 / 并发，逐项 diff 后各自走审计动作码。 */
    edit: async (ctx) => {
      const users = ctx.services.user
      if (users === undefined) throw new WebError('WEB_NO_USER', '用户服务未运行')
      const id = Number(requiredString(ctx.form, 'id', '用户 ID'))
      const name = requiredString(ctx.form, 'name', '名称')
      const role = ctx.form.get('role') === 'admin' ? 'admin' : 'user'
      const status = ctx.form.get('status') === 'banned' ? 'banned' : 'enabled'
      const concurrencyText = ctx.form.get('concurrencyLimit')?.trim() ?? ''
      let concurrencyLimit: number | null = null
      if (concurrencyText !== '') {
        if (!/^\d+$/.test(concurrencyText)) throw new WebError('WEB_BAD_LIMIT', '并发上限必须是整数')
        const parsed = Number(concurrencyText)
        if (parsed < MIN_CONCURRENCY || parsed > MAX_CONCURRENCY) {
          throw new WebError('WEB_BAD_LIMIT', `并发上限必须在 ${String(MIN_CONCURRENCY)}–${String(MAX_CONCURRENCY)} 之间`)
        }
        concurrencyLimit = parsed
      }

      // 逐项 diff：没变的不写（每次写都会留一条审计，不能因为点一次保存就刷四条）。
      const before = await users.get(id)
      if (before === undefined) throw new WebError('WEB_NO_USER_ID', '用户不存在')
      if (before.name !== name) {
        await auditedAction(
          ctx,
          {
            action: 'user.rename',
            targetType: 'user',
            targetId: String(id),
            summary: `把用户 #${String(id)} 改名为 ${name}`,
            metadata: { name },
          },
          () => users.rename(WEB_ACTOR, id, name),
        )
      }
      if (before.role !== role) {
        await auditedAction(
          ctx,
          {
            action: 'user.role.set',
            targetType: 'user',
            targetId: String(id),
            summary: `把用户 #${String(id)} 的角色改为 ${role}`,
            metadata: { role },
          },
          () => users.setRole(WEB_ACTOR, id, role),
        )
      }
      if (before.status !== status) {
        await auditedAction(
          ctx,
          {
            action: 'user.status.set',
            targetType: 'user',
            targetId: String(id),
            summary: `把用户 #${String(id)} 的状态改为 ${status}`,
            metadata: { status },
          },
          () => users.setStatus(WEB_ACTOR, id, status),
        )
      }
      if (before.concurrencyLimit !== concurrencyLimit) {
        await auditedAction(
          ctx,
          {
            action: 'user.concurrency.set',
            targetType: 'user',
            targetId: String(id),
            summary: `把用户 #${String(id)} 的并发上限改为 ${concurrencyLimit === null ? '不限' : String(concurrencyLimit)}`,
            metadata: { concurrencyLimit: concurrencyLimit === null ? null : String(concurrencyLimit) },
          },
          () => users.setConcurrencyLimit(WEB_ACTOR, id, concurrencyLimit),
        )
      }
      return '/admin/users?ok=' + encodeURIComponent('已保存')
    },

    balance: async (ctx) => {
      const users = ctx.services.user
      if (users === undefined) throw new WebError('WEB_NO_USER', '用户服务未运行')
      const id = Number(requiredString(ctx.form, 'id', '用户 ID'))
      const deltaYuan = requiredString(ctx.form, 'deltaYuan', '增减金额')
      const reason = requiredString(ctx.form, 'reason', '原因')
      const delta = parseYuanToMicros(deltaYuan)
      await auditedAction(
        ctx,
        {
          action: 'user.balance.adjust',
          targetType: 'user',
          targetId: String(id),
          summary: `调整用户 #${String(id)} 的余额（${deltaYuan} 元）：${reason}`,
          // 金额一律整数最小单位：变化量与变动后余额都记十进制字符串。
          metadata: { deltaMicros: delta.toString(), reason },
          metadataOf: (after) => ({ balanceAfterMicros: (after as bigint).toString() }),
        },
        () => users.adjustBalance(WEB_ACTOR, id, delta, reason),
      )
      return '/admin/users?ok=' + encodeURIComponent('余额已调整')
    },

    remove: async (ctx) => {
      const users = ctx.services.user
      if (users === undefined) throw new WebError('WEB_NO_USER', '用户服务未运行')
      const id = Number(requiredString(ctx.form, 'id', '用户 ID'))
      await auditedAction(
        ctx,
        {
          action: 'user.remove',
          targetType: 'user',
          targetId: String(id),
          summary: `删除用户 #${String(id)}`,
        },
        () => users.remove(WEB_ACTOR, id),
      )
      return '/admin/users?ok=' + encodeURIComponent('用户已删除')
    },
  },
}
