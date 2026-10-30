/**
 * 上游账号的「启用 / 停用」单账号动作与按钮组（详情页用）。
 *
 * 为什么单独一个文件：`admin_account_detail.ts` 已经 440 行（§5.6 的 400～500 次级面），
 * 这两个动作与「编辑字段」无关，搬出来让详情页净增行数最小。
 *
 * 纪律：**停用必须走 `admin.disable`，不能走 `update({ enabled: false })`**。
 * 2026-10 的线上故障就是「停用」走了整份 update 补丁，把别的字段一起覆盖掉了；
 * `test/admin-accounts.test.ts` 里两条回归用例钉着这条。
 */
import type { PageTemplateService } from '@dizzyapi/plugin-page-template'
import type { ActionContext } from '../layout.ts'
import { requiredString, WebError } from '../forms.ts'
import { WEB_ACTOR } from '../runtime.ts'
import { auditedAction } from '../audit.ts'

const PATH = '/admin/accounts/detail'

/** 启用：只动「启用 / 停用」开关，不碰 status。 */
export async function enableAccountAction(ctx: ActionContext): Promise<string> {
  const { admin, id } = resolve(ctx)
  await auditedAction(
    ctx,
    {
      action: 'account.enable',
      targetType: 'account',
      targetId: id,
      summary: `启用上游账号 ${id}`,
    },
    () => admin.enable(WEB_ACTOR, id),
  )
  return `${PATH}?id=${encodeURIComponent(id)}&ok=${encodeURIComponent('账号已启用')}`
}

/** 停用：同上，但走 disable。 */
export async function disableAccountAction(ctx: ActionContext): Promise<string> {
  const { admin, id } = resolve(ctx)
  await auditedAction(
    ctx,
    {
      action: 'account.disable',
      targetType: 'account',
      targetId: id,
      summary: `停用上游账号 ${id}`,
    },
    () => admin.disable(WEB_ACTOR, id),
  )
  return `${PATH}?id=${encodeURIComponent(id)}&ok=${encodeURIComponent('账号已停用')}`
}

/**
 * 详情页的开关按钮组：当前是启用就只给「停用」，反之只给「启用」。
 *
 * 两个都摆出来会让人手滑（停用可逆，但仍要多点一次才能恢复）。
 */
export function renderAccountStateForm(
  t: PageTemplateService,
  account: { readonly id: string; readonly enabled: boolean },
): string {
  const next = account.enabled ? 'disable' : 'enable'
  const label = account.enabled ? '停用账号' : '启用账号'
  const hint = account.enabled
    ? '停用后不进候选。系统自动停用是另一条状态（status=auto_disabled），恢复入口在同一分组的下方。'
    : '启用后重新进候选；如果它是被系统自动停用的，请用同一分组下方的复核入口恢复。'
  return `<form class="inline-form" method="post" action="${PATH}?action=${next}&id=${encodeURIComponent(account.id)}">
<button class="btn small${account.enabled ? ' danger' : ''}" type="submit">${t.escapeText(label)}</button></form>
<p class="hint">${t.escapeText(hint)}</p>`
}

function resolve(ctx: ActionContext): {
  readonly admin: NonNullable<ActionContext['services']['accountAdmin']>
  readonly id: string
} {
  const admin = ctx.services.accountAdmin
  if (admin === undefined) throw new WebError('WEB_NO_ACCOUNT', '账号服务未运行')
  return { admin, id: requiredString(ctx.form, 'id', '账号') }
}
