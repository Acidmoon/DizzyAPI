"use client";

/**
 * 上游账号池（`/dashboard/accounts`）：**筛选在上、列表在下**（owner 明确要的信息架构）。
 *
 * 接口：`GET /api/accounts?provider=&status=&cursor=&limit=`（要管理员权限，路径不带 `admin`）。
 *
 * 三条纪律：
 * - **凭据永远不进前端**：服务端响应里没有 `credentialRef` / 令牌，页面也不显示；
 *   导入凭据是「只写不读」的动作，失败只报 `code`。
 * - **`status` 与 `enabled` 是两件事**：人手停用是 `enabled=false`，系统自动停用是
 *   `status=auto_disabled`，两者互不覆盖，页面上分开表达（见 `accounts-table.tsx`）。
 * - 健康四态里 **`unknown` 是一等状态**，不能当「健康」显示。
 *
 * ## 本文件的职责边界
 *
 * 只做「取数 + 编排」：表格在 `accounts-table.tsx`、行操作在 `account-row-actions.tsx`、
 * 弹窗在 `account-*-dialog.tsx`、批量逻辑在 `account-bulk-logic.ts`。
 * 曾经这里只有列表没有操作入口，结果 owner 上线后发现「账号连删都删不掉」——
 * 记住：**服务端有能力 ≠ 页面上有入口**。
 */
import { useCallback, useState } from "react";

import { Plus, RefreshCw, Search, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, adminUsers, ApiError, type AccountViewLike } from "@/lib/api";

import { AccountCreateDialog } from "./account-create-dialog";
import { AccountCredentialDialog } from "./account-credential-dialog";
import { AccountDeleteDialog } from "./account-delete-dialog";
import { AccountEditDialog } from "./account-edit-dialog";
import { AccountImportDialog } from "./account-import-dialog";
import {
  MAX_BULK,
  bulkBodyOf,
  bulkFailureLines,
  bulkOutcomeOf,
  bulkOutcomeText,
  toggleSelectAll,
  toggleSelected,
} from "./account-bulk-logic";
import { AccountsBulkBar } from "./accounts-bulk-bar";
import { AccountsTable } from "./accounts-table";
import { DataState } from "./data-state";
import { useResource } from "./use-resource";

const PAGE_SIZE = 20;

export function AccountsBoard() {
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "needs_reauth" | "auto_disabled">("all");
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<AccountViewLike | null>(null);
  const [deleting, setDeleting] = useState<readonly AccountViewLike[] | null>(null);
  const [credentialFor, setCredentialFor] = useState<AccountViewLike | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(
    () =>
      adminUsers.listAccounts(api, {
        ...(provider.trim() === "" ? {} : { provider: provider.trim() }),
        ...(status === "all" ? {} : { status }),
        cursor: offset,
        limit: PAGE_SIZE,
      }),
    [provider, status, offset],
  );
  const { data, error, loading, reload } = useResource(load);
  const items = data?.items ?? [];
  const pageIds = items.map((account) => account.id);

  /** 换筛选 / 换页：选择只对当前页有意义（游标分页跨页选择会与「全选」语义打架）。 */
  function resetSelection(): void {
    setSelected([]);
  }

  async function runBulk(action: "enable" | "disable"): Promise<void> {
    const body = bulkBodyOf(action, selected);
    if (body === "empty") {
      toast.info("先勾选要操作的账号");
      return;
    }
    if (body === "too-large") {
      toast.error(`一次最多操作 ${String(MAX_BULK)} 个账号`);
      return;
    }
    setBulkBusy(true);
    try {
      const outcome = bulkOutcomeOf(await adminUsers.bulkAccounts(api, body));
      const verb = action === "enable" ? "启用" : "停用";
      if (outcome.failed === 0) {
        toast.success(bulkOutcomeText(outcome, verb));
      } else {
        toast.error(`${bulkOutcomeText(outcome, verb)}。${bulkFailureLines(outcome).join("；")}`);
      }
      setSelected([]);
      reload();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "批量操作失败");
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">上游账号池</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setImporting(true)}>
            <Upload /> 批量导入
          </Button>
          <Button onClick={() => setCreating(true)}>
            <Plus /> 新建账号
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">筛选条件</CardTitle>
          <CardDescription>条件变化立即重新取数；分页游标会重置回第一页。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="account-provider">提供商</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="account-provider"
                  className="w-48 pl-8"
                  value={provider}
                  onChange={(event) => {
                    setProvider(event.target.value);
                    setOffset(0);
                    resetSelection();
                  }}
                  placeholder="例如 anthropic…"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account-status">状态</Label>
              <Select
                value={status}
                onValueChange={(value) => {
                  setStatus(value as typeof status);
                  setOffset(0);
                  resetSelection();
                }}
              >
                <SelectTrigger id="account-status" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">全部</SelectItem>
                    <SelectItem value="active">可用</SelectItem>
                    <SelectItem value="needs_reauth">待重新授权</SelectItem>
                    <SelectItem value="auto_disabled">系统自动停用</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={reload}>
              <RefreshCw /> 刷新
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">账号列表</CardTitle>
          <CardDescription>本页 {items.length} 条。健康度 `unknown` 表示还没检查过，不是「健康」。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-0">
          <div className="px-4">
            <AccountsBulkBar
              count={selected.length}
              busy={bulkBusy}
              onEnable={() => void runBulk("enable")}
              onDisable={() => void runBulk("disable")}
              onDelete={() => setDeleting(items.filter((account) => selected.includes(account.id)))}
              onClear={resetSelection}
            />
          </div>

          <DataState
            loading={loading}
            error={error}
            empty={items.length === 0}
            onRetry={reload}
            emptyTitle="没有匹配的上游账号"
            emptyDescription="换个筛选条件试试，或者先去新建 / 导入账号。"
          >
            <AccountsTable
              items={items}
              selected={selected}
              onToggleSelect={(id) => setSelected(toggleSelected(selected, id))}
              onToggleSelectAll={() => setSelected(toggleSelectAll(selected, pageIds))}
              onEdit={(account) => setEditing(account)}
              onCredential={(account) => setCredentialFor(account)}
              onDelete={(account) => setDeleting([account])}
              onChanged={reload}
            />

            <div className="flex items-center justify-between gap-2 px-4 pt-3">
              <span className="text-xs text-muted-foreground">第 {Math.floor(offset / PAGE_SIZE) + 1} 页</span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => {
                    setOffset(Math.max(0, offset - PAGE_SIZE));
                    resetSelection();
                  }}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={data?.nextCursor === null || data?.nextCursor === undefined}
                  onClick={() => {
                    setOffset(offset + PAGE_SIZE);
                    resetSelection();
                  }}
                >
                  下一页
                </Button>
              </div>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <AccountCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          reload();
        }}
      />

      <AccountImportDialog
        open={importing}
        onClose={() => setImporting(false)}
        onImported={() => {
          reload();
        }}
      />

      {editing === null ? null : (
        <AccountEditDialog
          key={editing.id}
          account={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}

      {credentialFor === null ? null : (
        <AccountCredentialDialog
          key={credentialFor.id}
          account={credentialFor}
          onClose={() => setCredentialFor(null)}
          onImported={() => {
            setCredentialFor(null);
            reload();
          }}
        />
      )}

      <AccountDeleteDialog
        accounts={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setSelected([]);
          reload();
        }}
      />
    </div>
  );
}
