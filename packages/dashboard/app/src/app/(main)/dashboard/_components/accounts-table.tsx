"use client";

/**
 * 上游账号列表（从 `accounts-board.tsx` 拆出，职责只有「把一页数据画成表」）。
 *
 * 拆的理由：board 负责取数与弹窗编排，表格负责选择与行操作 —— 混在一个文件里会
 * 越过 §5.6 的 400 行软上限，也会让「行操作」这种容易出错的东西埋在 300 行 JSX 里。
 *
 * 两件事在这里表达清楚：
 * - **状态徽标**：人手停用（`enabled=false`）与系统自动停用（`status=auto_disabled`）
 *   必须分开显示，前者是灰、后者是红 —— 混成一句「已停用」就看不出该去找谁。
 * - **健康度 `unknown` 是一等状态**，不能当「健康」显示。
 */
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AccountViewLike } from "@/lib/api";
import { formatDateTime, formatDurationMs } from "@/lib/format";

import { AccountRowActions } from "./account-row-actions";
import { isPageAllSelected, isPagePartiallySelected } from "./account-bulk-logic";
import { accountStateLabel } from "./admin-logic";

/** 账号状态徽标：自动停用必须是红，不能与「人为停用」混。人话文案走共享的 `accountStateLabel`。 */
function StatusBadge({ enabled, status }: { enabled: boolean; status: string }) {
  if (!enabled) {
    return (
      <Badge variant="outline" className="bg-muted text-muted-foreground">
        {accountStateLabel(enabled, status)}
      </Badge>
    );
  }
  if (status === "auto_disabled") {
    return (
      <Badge variant="outline" className="bg-destructive/15 text-destructive">
        {accountStateLabel(enabled, status)}
      </Badge>
    );
  }
  if (status === "needs_reauth") {
    return (
      <Badge variant="outline" className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
        {accountStateLabel(enabled, status)}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
      {accountStateLabel(enabled, status)}
    </Badge>
  );
}

export function AccountsTable({
  items,
  selected,
  onToggleSelect,
  onToggleSelectAll,
  onEdit,
  onCredential,
  onDelete,
  onChanged,
}: {
  items: readonly AccountViewLike[];
  selected: readonly string[];
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onEdit: (account: AccountViewLike) => void;
  onCredential: (account: AccountViewLike) => void;
  onDelete: (account: AccountViewLike) => void;
  onChanged: () => void;
}) {
  const pageIds = items.map((account) => account.id);
  const allSelected = isPageAllSelected(selected, pageIds);
  const partiallySelected = isPagePartiallySelected(selected, pageIds);

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10 pl-4">
              <Checkbox
                aria-label="全选本页账号"
                checked={allSelected ? true : partiallySelected ? "indeterminate" : false}
                onCheckedChange={onToggleSelectAll}
              />
            </TableHead>
            <TableHead>账号</TableHead>
            <TableHead>提供商 / 协议</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">权重</TableHead>
            <TableHead className="text-right">模型数</TableHead>
            <TableHead>最近测试</TableHead>
            <TableHead>更新于</TableHead>
            <TableHead className="pr-4 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((account) => (
            <TableRow key={account.id} data-state={selected.includes(account.id) ? "selected" : undefined}>
              <TableCell className="pl-4">
                <Checkbox
                  aria-label={`选择 ${account.label}`}
                  checked={selected.includes(account.id)}
                  onCheckedChange={() => onToggleSelect(account.id)}
                />
              </TableCell>
              <TableCell>
                <div className="flex flex-col">
                  <span className="font-medium">{account.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {account.email ?? account.subject ?? `#${account.id}`}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col text-sm">
                  <span>{account.provider}</span>
                  <span className="text-xs text-muted-foreground">{account.protocol ?? "同协议"}</span>
                </div>
              </TableCell>
              <TableCell>
                <StatusBadge enabled={account.enabled} status={account.status} />
                {account.failureCount > 0 ? (
                  <span className="ml-2 text-xs text-muted-foreground">连续失败 {account.failureCount}</span>
                ) : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">{account.priority}</TableCell>
              <TableCell className="text-right tabular-nums">{account.models?.length ?? 0}</TableCell>
              <TableCell className="text-xs">
                {account.lastTestAt === null ? (
                  <span className="text-muted-foreground">未测试</span>
                ) : (
                  <div className="flex flex-col">
                    <span className={account.lastTestOk === true ? "text-emerald-600" : "text-destructive"}>
                      {account.lastTestOk === true ? "通过" : "失败"}
                    </span>
                    <span className="text-muted-foreground">
                      {formatDurationMs(account.lastTestLatencyMs)} · {formatDateTime(account.lastTestAt)}
                    </span>
                  </div>
                )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{formatDateTime(account.updatedAt)}</TableCell>
              <TableCell className="pr-4">
                <AccountRowActions
                  account={account}
                  onEdit={onEdit}
                  onCredential={onCredential}
                  onDelete={onDelete}
                  onChanged={onChanged}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
