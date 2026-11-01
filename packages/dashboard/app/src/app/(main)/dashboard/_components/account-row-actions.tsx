"use client";

/**
 * 账号列表每一行的操作：编辑 / 凭据 / 测试 / 启用停用 / 删除。
 *
 * ## 启停语义（服务端两条通道，页面也必须分开表达）
 *
 * - **人手停用**是 `enabled=false`（这个按钮干的）；
 * - **系统自动停用**是 `status='auto_disabled'`（健康检查连续失败后由 `account-health` 写），
 *   它**不动 `enabled`**。
 *
 * 所以按钮文案只看 `enabled`：`enabled=true` 时给「停用」，否则给「启用」；
 * 系统自动停用的徽标由列表的状态列表达，这里不重复。
 *
 * ## 测试结果去哪了
 *
 * 「测试」不再在这里发请求、也不再弹 toast —— 它只负责打开
 * `account-test-dialog.tsx`。原因：owner 要看请求提示词与上游返回原文，
 * 那是一个多区块的详情，塞不进一行小字。
 */
import { useState } from "react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api, adminUsers, ApiError, type AccountViewLike } from "@/lib/api";

export function AccountRowActions({
  account,
  onEdit,
  onCredential,
  onTest,
  onDelete,
  onChanged,
}: {
  account: AccountViewLike;
  onEdit: (account: AccountViewLike) => void;
  onCredential: (account: AccountViewLike) => void;
  onTest: (account: AccountViewLike) => void;
  onDelete: (account: AccountViewLike) => void;
  onChanged: () => void;
}) {
  const [toggling, setToggling] = useState(false);

  async function toggleEnabled(): Promise<void> {
    setToggling(true);
    try {
      const next = !account.enabled;
      await adminUsers.updateAccount(api, account.id, { enabled: next });
      toast.success(next ? `已启用「${account.label}」` : `已停用「${account.label}」`);
      onChanged();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "启停失败");
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="flex flex-wrap justify-end gap-1">
      <Button variant="ghost" size="sm" onClick={() => onEdit(account)}>
        编辑
      </Button>
      <Button variant="ghost" size="sm" onClick={() => onCredential(account)}>
        凭据
      </Button>
      <Button variant="ghost" size="sm" onClick={() => onTest(account)}>
        测试
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void toggleEnabled()} disabled={toggling}>
        {account.enabled ? "停用" : "启用"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={() => onDelete(account)}
      >
        删除
      </Button>
    </div>
  );
}
