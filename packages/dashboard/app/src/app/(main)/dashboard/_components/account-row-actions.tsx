"use client";

/**
 * 账号列表每一行的操作：编辑 / 测试 / 启用停用 / 删除。
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
 * ## 测试结果的显示口径
 *
 * 点了就进 pending（按钮文案 + 转圈），回来**成功和失败都要说清**：
 * 成功给「通过 + HTTP 状态 + 耗时」，失败给「失败 + 稳定 code + 耗时」。
 * 上游失败也是结果对象（服务端会把 `lastTest*` 落库），所以测完要重新取数。
 */
import { useState } from "react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api, adminUsers, ApiError, type AccountViewLike } from "@/lib/api";
import { formatDurationMs } from "@/lib/format";

export function AccountRowActions({
  account,
  onEdit,
  onCredential,
  onDelete,
  onChanged,
}: {
  account: AccountViewLike;
  onEdit: (account: AccountViewLike) => void;
  onCredential: (account: AccountViewLike) => void;
  onDelete: (account: AccountViewLike) => void;
  onChanged: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function runTest(): Promise<void> {
    setTesting(true);
    setResult(null);
    try {
      const outcome = await adminUsers.testAccount(api, account.id);
      if (outcome.ok) {
        setFailed(false);
        const status = outcome.status === null ? "" : `HTTP ${String(outcome.status)} · `;
        setResult(`通过 · ${status}${formatDurationMs(outcome.latencyMs)}`);
      } else {
        setFailed(true);
        const status = outcome.status === null ? "未拿到响应" : `HTTP ${String(outcome.status)}`;
        const detail = outcome.error === null ? "" : ` · ${outcome.error}`;
        setResult(`失败 · ${status}${detail} · ${formatDurationMs(outcome.latencyMs)}`);
      }
      onChanged();
    } catch (cause) {
      setFailed(true);
      setResult(
        cause instanceof ApiError ? `测试失败：${cause.message}（${cause.code}）` : "测试失败",
      );
    } finally {
      setTesting(false);
    }
  }

  async function toggleEnabled(): Promise<void> {
    setToggling(true);
    try {
      const next = !account.enabled;
      await adminUsers.updateAccount(api, account.id, { enabled: next });
      toast.success(next ? `已启用「${account.label}」` : `已停用「${account.label}」`);
      onChanged();
    } catch (cause) {
      toast.error(
        cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "启停失败",
      );
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={() => onEdit(account)}>
          编辑
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onCredential(account)}>
          凭据
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void runTest()} disabled={testing}>
          {testing ? "测试中…" : "测试"}
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
      {result === null ? null : (
        <span
          className={`max-w-56 text-right text-xs ${failed ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}`}
        >
          {result}
        </span>
      )}
    </div>
  );
}
