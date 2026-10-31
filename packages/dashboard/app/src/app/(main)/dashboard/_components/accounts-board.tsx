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
 *   `status=auto_disabled`，两者互不覆盖，页面上分开表达。
 * - 健康四态里 **`unknown` 是一等状态**，不能当「健康」显示。
 */
import { useCallback, useState } from "react";

import { Plus, RefreshCw, Search, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, adminUsers } from "@/lib/api";
import { formatDateTime, formatDurationMs } from "@/lib/format";

import { AccountCreateDialog } from "./account-create-dialog";
import { AccountImportDialog } from "./account-import-dialog";
import { accountStateLabel } from "./admin-logic";
import { DataState } from "./data-state";
import { useResource } from "./use-resource";

const PAGE_SIZE = 20;

/** 账号状态徽标：自动停用必须是红，不能与「人为停用」混。人话文案走共享的 `accountStateLabel`。 */
function StatusBadge({ enabled, status }: { enabled: boolean; status: string }) {
  if (!enabled) {
    return <Badge variant="outline" className="bg-muted text-muted-foreground">{accountStateLabel(enabled, status)}</Badge>;
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

export function AccountsBoard() {
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "needs_reauth" | "auto_disabled">("all");
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

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
        <CardContent className="px-0">
          <DataState
            loading={loading}
            error={error}
            empty={items.length === 0}
            onRetry={reload}
            emptyTitle="没有匹配的上游账号"
            emptyDescription="换个筛选条件试试，或者先去新建 / 导入账号。"
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">账号</TableHead>
                    <TableHead>提供商 / 协议</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">权重</TableHead>
                    <TableHead className="text-right">模型数</TableHead>
                    <TableHead>最近测试</TableHead>
                    <TableHead className="pr-4">更新于</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((account) => (
                    <TableRow key={account.id}>
                      <TableCell className="pl-4">
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
                      <TableCell className="text-muted-foreground pr-4 text-xs">
                        {formatDateTime(account.updatedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between gap-2 px-4 pt-3">
              <span className="text-xs text-muted-foreground">第 {Math.floor(offset / PAGE_SIZE) + 1} 页</span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={data?.nextCursor === null || data?.nextCursor === undefined}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
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
    </div>
  );
}
