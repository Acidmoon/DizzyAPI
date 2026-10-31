/**
 * 管理台审计页的**纯逻辑**：动作码 / 目标类型的中文标签 + 时间窗换算。
 *
 * 为什么另建一份而不 import `packages/web/src/content/audit_actions.ts`：
 * 新前端是**独立的 npm 工程**（`packages/dashboard/app/package.json`），
 * 不依赖 `packages/web`；而且 `packages/web` 是**旧前端**，owner 已决定下线它。
 * 两边各留一份标签表不理想，但让新前端依赖一个正在下线的包更糟——
 * 这份表在这里独立维护，等旧前端下线后就是唯一的一份。
 *
 * 纪律（与旧表一致）：
 * - **只列真实接入过的 action**；没映射的动作原样显示动作码（绝不空白）。
 *   空白等于「这条记录看起来没事」，比显示 `account.import_credentials` 更危险。
 */
import { dateRangeMs, utcDayStartMs } from "./admin-logic"

/** 审计动作码 → 中文标签。key 必须与调用方 `audit.record({ action })` 完全一致。 */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  // 用户（api：/api/users）
  "user.balance.adjust": "调整用户余额",
  "user.role.set": "修改用户角色",
  "user.status.set": "修改用户状态",
  "user.balance_enabled.set": "切换余额展示",
  "user.concurrency.set": "设置用户并发上限",
  "user.rename": "修改用户名",
  "user.remove": "删除用户",

  // 上游账号（api：/api/accounts）
  "account.create": "新建上游账号",
  "account.update": "修改上游账号",
  "account.enable": "启用上游账号",
  "account.disable": "停用上游账号",
  "account.remove": "删除上游账号",
  "account.import": "批量导入上游账号",
  "account.import_credentials": "导入账号凭据",
  "account.scheduling": "修改调度参数",
  "account.health.set": "修改账号健康状态",
  "account.auto_disable": "自动停用账号",
  "account.auto_enable": "恢复自动停用的账号",
  "account.refresh": "刷新账号凭据",
  "account.bulk_update": "批量修改账号字段",
  "account.bulk_enable": "批量启用账号",
  "account.bulk_disable": "批量停用账号",

  // 兑换码（api：/api/admin/redeem-*）
  "redeem.batch.generate": "生成兑换码批次",
  "redeem.code.status": "启用 / 停用兑换码",
  "redeem.code.resolve": "人工核查兑换码",
  "redeem.code.delete": "删除兑换码",

  // 充值订单（api：/api/admin/topup-orders）
  "topup.order.confirm": "确认充值到账",
  "topup.order.cancel": "取消充值订单",

  // 价格与设置
  "pricing.write": "写入模型价格",
  "pricing.remove": "删除模型价格",
  "settings.write": "修改设置",
  "settings.reset": "重置设置",

  // 用量隔离区（api：/api/admin/usage/rejected）
  "usage.rejected.ignore": "忽略隔离的用量记录",
  "usage.rejected.replay": "重放隔离的用量记录",

  // 内容审核（api：/api/admin/content-audit）
  "content_audit.rule.create": "新增内容审核规则",
  "content_audit.rule.update": "修改内容审核规则",
  "content_audit.rule.delete": "删除内容审核规则",
}

/** 目标类型 → 中文标签。 */
export const AUDIT_TARGET_LABELS: Readonly<Record<string, string>> = {
  user: "用户",
  account: "上游账号",
  "redeem-batch": "兑换码批次",
  "redeem-code": "兑换码",
  "topup-order": "充值订单",
  pricing: "模型价格",
  settings: "设置",
  "usage-record": "用量记录",
  "content-audit-rule": "内容审核规则",
}

/** 动作码取中文标签；**没映射就原样显示动作码**（绝不空白）。 */
export function auditActionLabel(action: string): string {
  const label = AUDIT_ACTION_LABELS[action]
  return label === undefined ? action : label
}

/** 目标类型标签；没映射同样回退原始值。 */
export function auditTargetLabel(targetType: string): string {
  if (targetType === "") return "—"
  const label = AUDIT_TARGET_LABELS[targetType]
  return label === undefined ? targetType : label
}

/**
 * 元数据压成一行摘要：只用于展示，太长就截断。
 *
 * **原始 JSON 不进表格单元格的完整渲染**——审计元数据已经脱敏，但仍然可能很长，
 * 整段塞进表格会把版式撑爆。截断到 120 字符。
 */
export function metadataLine(metadata: Readonly<Record<string, unknown>> | null): string {
  if (metadata === null) return "—"
  try {
    const text = JSON.stringify(metadata)
    if (text === undefined || text === "{}") return "—"
    return text.length > 120 ? `${text.slice(0, 120)}…` : text
  } catch {
    return "—"
  }
}

export { dateRangeMs, utcDayStartMs }
