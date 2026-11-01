/**
 * 上游账号**批量操作**的纯逻辑（不 import React / Next / UI，可单测）。
 *
 * ## 为什么批量删除不调 `/bulk`
 *
 * 服务端 `accountAdmin` 有 `bulkEnable` / `bulkDisable` / `bulkUpdate`，但**没有** `bulkRemove`；
 * 而且删除是逐条独立审计的高危动作，一条审计盖掉 N 次删除在事后核查时看不出「删了哪几个」。
 * 所以页面对删除逐条发 `DELETE /api/accounts/:id`（每条一条审计），这里只负责把
 * 逐条结果汇总成与 `/bulk` 一致的形状，让三种批量操作的提示文案统一。
 *
 * ## 上限
 *
 * 服务端 `accountAdmin.maxBatchSize` 默认 **100**（可配 1–1000）。页面一页 20 条，
 * 正常选不到上限；这里仍先挡一道，超了直接给可读提示，不发出注定被拒的请求。
 */

/** 一次批量操作的服务端上限（`accountAdmin` 默认 `maxBatchSize`）。 */
export const MAX_BULK = 100;

/** 批量操作里单项失败：稳定 code + 可读消息（不含秘密）。 */
export interface AccountBulkFailure {
  readonly id: string;
  readonly code: string;
  readonly message: string;
}

/** 批量操作结果（页面口径）。 */
export interface AccountBulkOutcome {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly failures: readonly AccountBulkFailure[];
}

/** 在选中集合里切换一项（保持顺序、去重）。 */
export function toggleSelected(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
}

/** 全选 / 取消全选**当前页**：只动本页的 id，不碰别的页（跨页选择对游标分页没有意义）。 */
export function toggleSelectAll(selected: readonly string[], pageIds: readonly string[]): string[] {
  const all = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
  if (all) return selected.filter((id) => !pageIds.includes(id));
  return [...selected, ...pageIds.filter((id) => !selected.includes(id))];
}

/** 当前页是否全选（空页不算选中）。 */
export function isPageAllSelected(selected: readonly string[], pageIds: readonly string[]): boolean {
  return pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
}

/** 当前页是否「选了一部分」（给全选框的 indetermine 态用）。 */
export function isPagePartiallySelected(
  selected: readonly string[],
  pageIds: readonly string[],
): boolean {
  if (pageIds.length === 0) return false;
  const hits = pageIds.filter((id) => selected.includes(id)).length;
  return hits > 0 && hits < pageIds.length;
}

/**
 * 批量启停 / 改字段的请求体；不可发返回 `"empty"` / `"too-large"`。
 *
 * `patch` 里**绝不带 `enabled`**：启停走 `action`，服务端也会拒（`bulkUpdate` 只认
 * `label / email / subject / baseUrl / protocol / models / modelMap / priority`）。
 */
export function bulkBodyOf(
  action: "enable" | "disable" | "update",
  ids: readonly string[],
  patch?: Record<string, unknown>,
):
  | { action: "enable" | "disable" | "update"; ids: string[]; patch?: Record<string, unknown> }
  | "empty"
  | "too-large" {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return "empty";
  if (unique.length > MAX_BULK) return "too-large";
  return patch === undefined ? { action, ids: unique } : { action, ids: unique, patch };
}

/**
 * 服务端 `/bulk` 响应 → 页面口径。
 *
 * 做了防御式归一：**不认识的结果按失败算**，不假装成功 ——
 * 「批量操作看起来成功但实际没生效」比报错更难查。
 */
export function bulkOutcomeOf(raw: unknown): AccountBulkOutcome {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const items = Array.isArray(record.items) ? record.items : [];
  const failures: AccountBulkFailure[] = [];
  let succeeded = 0;
  for (const item of items) {
    const entry = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const id = typeof entry.id === "string" ? entry.id : "—";
    if (entry.ok === true) {
      succeeded += 1;
      continue;
    }
    const error =
      typeof entry.error === "object" && entry.error !== null
        ? (entry.error as Record<string, unknown>)
        : {};
    failures.push({
      id,
      code: typeof error.code === "string" ? error.code : "ACCOUNT_BULK_FAILED",
      message: typeof error.message === "string" ? error.message : "操作失败",
    });
  }
  const total = typeof record.total === "number" ? record.total : items.length;
  return { total, succeeded, failed: failures.length, failures };
}

/** 逐条删除的结果（每条一个成功或一个失败）→ 与 `/bulk` 一致的页面口径。 */
export function deleteOutcomeOf(failures: readonly AccountBulkFailure[], total: number): AccountBulkOutcome {
  return { total, succeeded: total - failures.length, failed: failures.length, failures };
}

/** 成功与失败都要说清：只报成功会让「删了一半」看起来像全成功。 */
export function bulkOutcomeText(outcome: AccountBulkOutcome, verb: string): string {
  if (outcome.total === 0) return `没有可${verb}的账号`;
  if (outcome.failed === 0) return `已${verb} ${String(outcome.succeeded)} 个账号`;
  return `已${verb} ${String(outcome.succeeded)} 个，失败 ${String(outcome.failed)} 个`;
}

/** 失败明细的人话（一行一条，带上稳定 code 方便对照服务端日志）。 */
export function bulkFailureLines(outcome: AccountBulkOutcome): string[] {
  return outcome.failures.slice(0, 5).map((failure) => `${failure.id}：${failure.message}（${failure.code}）`);
}
