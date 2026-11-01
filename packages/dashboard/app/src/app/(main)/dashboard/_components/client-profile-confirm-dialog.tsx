"use client";

/**
 * 客户端档案的二次确认（删除 / 恢复出厂共用）。
 *
 * 两件事都必须确认，因为都**不可撤销**：
 * - **删除**自定义档案：已经挂着它的账号会退化成「不伪装」（服务端 `resolve()` 返回
 *   `undefined`，不是报错）—— 那几条账号可能当场变回裸请求，上游开始 400。
 * - **恢复出厂**内置预置：会把这档档案上所有人手改过的头**全部冲掉**。
 *
 * 用自研 `AlertDialog`，不碰浏览器原生 `confirm`（全站控件纪律）。
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
import { api, adminClients, ApiError } from "@/lib/api";

import type { ClientProfileView } from "@/lib/api";

export type ClientProfileAction = "delete" | "reset";

export function ClientProfileConfirmDialog({
  action,
  profile,
  onClose,
  onDone,
}: {
  action: ClientProfileAction;
  profile: ClientProfileView;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function confirm(): Promise<void> {
    setBusy(true);
    try {
      if (action === "delete") {
        await adminClients.deleteClientMask(api, profile.id);
        toast.success(`已删除档案「${profile.label}」`);
      } else {
        await adminClients.resetClientMask(api, profile.id);
        toast.success(`已恢复「${profile.label}」的出厂值`);
      }
      onDone();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "操作失败");
    } finally {
      setBusy(false);
    }
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
          <AlertDialogTitle>
            {action === "delete" ? `删除档案「${profile.label}」？` : `把「${profile.label}」恢复出厂？`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {action === "delete"
              ? "删除后不可撤销。挂着这个档案的账号会变回「不伪装」，可能被上游拒（400 / 403）。"
              : "会冲掉这个档案上所有手改过的请求头与 User-Agent，恢复成内置预置。"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant={action === "delete" ? "destructive" : "default"}
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            {busy ? "处理中…" : action === "delete" ? "确认删除" : "确认恢复"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
