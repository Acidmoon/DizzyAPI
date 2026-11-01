"use client";

/**
 * 删除上游账号的二次确认（单个与批量共用同一个弹窗）。
 *
 * 为什么必须二次确认：删除**不可撤销**，而且账号记录会被调度快照立刻带走 ——
 * 正在跑的请求可能当场失去候选（页面上看不出「刚才还好好的怎么 503 了」）。
 *
 * ## 为什么不走 `/api/accounts/bulk`
 *
 * 服务端没有 `bulkRemove`，而且删除是逐条独立审计的高危动作：一条审计盖掉 N 次删除，
 * 事后核查时看不清「删了哪几个」。所以这里逐条发 `DELETE /api/accounts/:id`，
 * **一条失败不影响其余条**，最终把逐条结果汇总成统一点径提示。
 */
import { useState } from "react";

import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, adminUsers, ApiError, type AccountViewLike } from "@/lib/api";

import {
  bulkFailureLines,
  bulkOutcomeText,
  deleteOutcomeOf,
  type AccountBulkFailure,
} from "./account-bulk-logic";

export function AccountDeleteDialog({
  accounts,
  onClose,
  onDeleted,
}: {
  accounts: readonly AccountViewLike[] | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (accounts === null || accounts.length === 0) return null;

  const single = accounts.length === 1 ? accounts[0] : undefined;

  async function confirm(): Promise<void> {
    setBusy(true);
    const failures: AccountBulkFailure[] = [];
    for (const account of accounts ?? []) {
      try {
        await adminUsers.deleteAccount(api, account.id);
      } catch (cause) {
        failures.push({
          id: account.label === "" ? account.id : account.label,
          code: cause instanceof ApiError ? cause.code : "ACCOUNT_DELETE_FAILED",
          message: cause instanceof Error ? cause.message : "删除失败",
        });
      }
    }
    setBusy(false);
    const outcome = deleteOutcomeOf(failures, accounts?.length ?? 0);
    if (outcome.failed === 0) {
      toast.success(bulkOutcomeText(outcome, "删除"));
    } else {
      const detail = bulkFailureLines(outcome).join("；");
      toast.error(`${bulkOutcomeText(outcome, "删除")}${detail === "" ? "" : `。${detail}`}`);
    }
    onDeleted();
    onClose();
  }

  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{single === undefined ? `删除 ${accounts.length} 个账号？` : "删除这个账号？"}</AlertDialogTitle>
          <AlertDialogDescription>
            {single === undefined
              ? `选中的 ${String(accounts.length)} 个账号会从账号池里移除，凭据引用一并清理，不可撤销。`
              : `「${single.label}」会从账号池里移除，凭据引用一并清理，删除后它不再参与调度。`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(event) => {
              // 默认行为是「关闭弹窗」。删除是异步的，关得太早会让失败提示在关掉的弹窗里丢掉。
              event.preventDefault();
              void confirm();
            }}
          >
            {busy ? "删除中…" : "确认删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
