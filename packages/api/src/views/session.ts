/**
 * views/session.ts：从 http.ts 尾部搬出来的纯函数（行为逐字未改）。
 *
 * 拆出来的原因见 AGENTS.md §5.6（单文件上限）。搬动方式：整块文本原样移动，只补 import。
 */
import { centsOf } from '../views/common.ts'
import { badRequest } from '../errors.ts'
import type { AdminUserView, SessionInfoView, SessionRole, SessionUserView, SessionViewLike, UserLike } from '../types.ts'


export function roleOf(user: UserLike): SessionRole {
  return user.role === 'admin' ? 'admin' : 'user'
}


export function sessionUserOf(user: UserLike): SessionUserView {
  const role = roleOf(user)
  const balanceEnabled = user.balanceEnabled === true
  return {
    id: user.id,
    name: user.name,
    status: user.status,
    role,
    balanceEnabled,
    balanceCents: role === 'admin' || balanceEnabled ? centsOf(user.balance) : null,
    avatar: typeof user.avatar === 'string' && user.avatar !== '' ? user.avatar : null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}


export function adminUserOf(user: UserLike): AdminUserView {
  return {
    id: user.id,
    name: user.name,
    status: user.status,
    role: roleOf(user),
    balanceEnabled: user.balanceEnabled === true,
    balanceMinor: user.balance.toString(),
    // 缺省 / null = 不限：管理台用「不限」显示，不能把 undefined 当 0。
    concurrencyLimit:
      typeof user.concurrencyLimit === 'number' && user.concurrencyLimit > 0
        ? user.concurrencyLimit
        : null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}


export function sessionInfoOf(view: SessionViewLike): SessionInfoView {
  return {
    id: view.sessionId,
    createdAt: view.createdAt,
    expiresAt: view.expiresAt,
    lastSeenAt: view.lastSeenAt,
  }
}


export function parseUserId(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) throw badRequest('用户 ID 必须是正整数')
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('用户 ID 必须是正整数')
  return id
}
