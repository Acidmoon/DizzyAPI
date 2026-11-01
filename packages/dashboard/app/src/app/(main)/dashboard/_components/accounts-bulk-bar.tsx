"use client";

/**
 * 批量操作条：只在**真的选了账号**时出现（没选就不占版面）。
 *
 * 三个动作都走 `POST /api/accounts/bulk`（启用 / 停用），删除逐条走
 * `DELETE /api/accounts/:id`（见 `account-delete-dialog.tsx` 的说明）。
 * 逐项结果的汇总提示由 `account-bulk-logic.ts` 统一生成，三种动作文案一致。
 */
import { Button } from "@/components/ui/button";

export function AccountsBulkBar({
  count,
  busy,
  onEnable,
  onDisable,
  onDelete,
  onClear,
}: {
  count: number;
  busy: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2">
      <span className="text-sm">已选 {count} 个账号</span>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={onEnable}>
          批量启用
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={onDisable}>
          批量停用
        </Button>
        <Button variant="outline" size="sm" className="text-destructive" disabled={busy} onClick={onDelete}>
          批量删除
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClear}>
          取消选择
        </Button>
      </div>
    </div>
  );
}
