/**
 * 审计动作码的中文标签（静态事实）。
 *
 * 为什么单独一个文件：页面只是渲染器，映射表要能被测试逐条断言
 * （「接入的每个 action 都有标签」），所以内容是数据结构，不是拼在模板里的字符串。
 *
 * **纪律**：这里只能出现**真实接入过**的 action。新增一处 `audit.record(...)` 就要在这里
 * 加一条标签，否则 `/admin/audit` 会显式展示原始码（不空白，但不好读）。
 * `packages/web/test/pages-audit.test.ts` 会逐条守住这张表。
 */

/** 动作码 → 中文标签。key 必须与调用方 `audit.record({ action })` 完全一致。 */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  // 用户表单（api：/api/users，web：/admin/users）
  'user.balance.adjust': '调整用户余额',
  'user.role.set': '修改用户角色',
  'user.status.set': '修改用户状态',
  'user.balance_enabled.set': '切换余额展示',
  'user.rename': '修改用户名',
  'user.remove': '删除用户',

  // 上游账号（api：/api/accounts，web：/admin/accounts）
  'account.create': '新建上游账号',
  'account.update': '修改上游账号',
  'account.enable': '启用上游账号',
  'account.disable': '停用上游账号',
  'account.remove': '删除上游账号',
  'account.import': '批量导入上游账号',
  'account.import_credentials': '导入账号凭据',
  'account.scheduling': '修改调度参数',
  'account.health.set': '修改账号健康状态',
  'account.auto_disable': '自动停用账号',
  'account.auto_enable': '恢复自动停用的账号',
  'account.refresh': '刷新账号凭据',
  'account.bulk_update': '批量修改账号字段',
  'account.bulk_enable': '批量启用账号',
  'account.bulk_disable': '批量停用账号',

  // 兑换码（api：/api/admin/redeem-*，web：/admin/redeem-codes）
  'redeem.batch.generate': '生成兑换码批次',
  'redeem.code.status': '启用 / 停用兑换码',
  'redeem.code.resolve': '人工核查兑换码',
  'redeem.code.delete': '删除兑换码',

  // 充值订单（api：/api/admin/topup-orders，web：/admin/topup-orders）
  'topup.order.confirm': '确认充值到账',
  'topup.order.cancel': '取消充值订单',

  // 价格与设置
  'pricing.write': '写入模型价格',
  'pricing.remove': '删除模型价格',
  'settings.write': '修改设置',
  'settings.reset': '重置设置',

  // 用量隔离区（api：/api/admin/usage/rejected，web：/admin/usage）
  'usage.rejected.ignore': '忽略隔离的用量记录',
  'usage.rejected.replay': '重放隔离的用量记录',
} as const

/** 目标类型 → 中文标签。 */
export const AUDIT_TARGET_LABELS: Readonly<Record<string, string>> = {
  user: '用户',
  account: '上游账号',
  'redeem-batch': '兑换码批次',
  'redeem-code': '兑换码',
  'topup-order': '充值订单',
  pricing: '模型价格',
  settings: '设置',
  'usage-record': '用量记录',
} as const

/**
 * 给一个动作码取中文标签；**没映射就原样显示动作码**（绝不空白）。
 *
 * 空白等于「这条记录看起来没事」，比显示 `account.import_credentials` 更危险。
 */
export function auditActionLabel(action: string): string {
  const label = AUDIT_ACTION_LABELS[action]
  return label === undefined ? action : label
}

/** 目标类型标签；没映射同样回退原始值。 */
export function auditTargetLabel(targetType: string): string {
  if (targetType === '') return '—'
  const label = AUDIT_TARGET_LABELS[targetType]
  return label === undefined ? targetType : label
}
