"use client";

/**
 * 用户管理（`/dashboard/users`）：全站用户列表 + 编辑（名称 / 角色 / 状态 / 余额开关 / 并发上限）+ 余额调整。
 *
 * 接口（**都要管理员权限**，路径不带 `admin` 前缀是历史原因）：
 * - `GET /api/users?status=&offset=&limit=` → `{ items: AdminUserView[] }`
 * - `PATCH /api/users/:id` → 只写变了的字段（服务端逐项 diff、逐项审计）
 * - `POST /api/users/:id/balance` → `delta` 是**整数微元的十进制字符串**（可负）
 * - `DELETE /api/users/:id`
 *
 * 三条纪律：
 * - 余额展示与输入都用**整数微元字符串**，不经过 `Number`（微元会超过 2^53）。
 * - 写操作成功后**重新取数**，不在前端本地推算余额（余额的唯一权威是服务端）。
 * - 删除是不可逆动作，必须二次确认。
 */
import { useCallback, useState } from "react";

import { Pencil, RefreshCw, Trash2, Wallet } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, adminUsers, ApiError, type AdminUserView } from "@/lib/api";
import { formatDateTime, formatMicrosAsYuan } from "@/lib/format";

import { roleLabel, statusLabel } from "./admin-logic";
import { DataState } from "./data-state";
import { BalanceDialog } from "./users-balance-dialog";
import { UserEditDialog } from "./users-edit-dialog";
import { useResource } from "./use-resource";

const PAGE_SIZE = 20;

export function UsersBoard() {
  const [status, setStatus] = useState<"all" | "enabled" | "banned">("all");
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<AdminUserView | null>(null);
  const [balancing, setBalancing] = useState<AdminUserView | null>(null);
  const [removing, setRemoving] = useState<AdminUserView | null>(null);

  const load = useCallback(
    () =>
      adminUsers.listUsers(api, {
        ...(status === "all" ? {} : { status }),
        offset,
        limit: PAGE_SIZE,
      }),
    [status, offset],
  );
  const { data, error, loading, reload } = useResource(load);
  const items = data?.items ?? [];

  async function removeUser(user: AdminUserView): Promise<void> {
    try {
      await adminUsers.deleteUser(api, user.id);
      toast.success(`已删除用户「${user.name}」`);
      setRemoving(null);
      reload();
    } catch (cause) {
      const failure = cause instanceof ApiError ? cause : null;
      toast.error(failure?.message ?? "删除失败");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">用户管理</h1>
          </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as "all" | "enabled" | "banned");
              setOffset(0);
            }}
          >
            <SelectTrigger size="sm" className="w-36" aria-label="按状态筛选">
              <span className="text-muted-foreground">状态：</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="enabled">启用</SelectItem>
                <SelectItem value="banned">封禁</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={reload} aria-label="刷新">
            <RefreshCw /> 刷新
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">用户列表</CardTitle>
          <CardDescription>
            共 {items.length} 条（本页）。余额是整数微元（1 元 = 1,000,000 微元），允许为负表示后付费欠款。
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <DataState
            loading={loading}
            error={error}
            empty={items.length === 0}
            onRetry={reload}
            emptyTitle="没有用户"
            emptyDescription={status === "all" ? "全站还没有用户。" : "这个筛选条件下没有用户。"}
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">用户</TableHead>
                    <TableHead>角色</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">余额（元）</TableHead>
                    <TableHead className="text-right">并发上限</TableHead>
                    <TableHead>注册时间</TableHead>
                    <TableHead className="pr-4 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="pl-4">
                        <div className="flex flex-col">
                          <span className="font-medium">{user.name}</span>
                          <span className="text-xs text-muted-foreground">#{user.id}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={user.role === "admin" ? "default" : "outline"}>
                          {roleLabel(user.role)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            user.status === "enabled"
                              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                              : "bg-destructive/15 text-destructive"
                          }
                        >
                          {statusLabel(user.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatMicrosAsYuan(user.balanceMinor)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {user.concurrencyLimit === null ? "不限" : user.concurrencyLimit}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">{formatDateTime(user.createdAt)}</TableCell>
                      <TableCell className="pr-4">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setEditing(user)}>
                            <Pencil /> 编辑
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setBalancing(user)}>
                            <Wallet /> 余额
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => setRemoving(user)}
                          >
                            <Trash2 /> 删除
                          </Button>
                        </div>
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
                  disabled={items.length < PAGE_SIZE}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <UserEditDialog
        user={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
      <BalanceDialog
        user={balancing}
        onClose={() => setBalancing(null)}
        onSaved={() => {
          setBalancing(null);
          reload();
        }}
      />

      {removing === null ? null : (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-base">删除用户「{removing.name}」？</CardTitle>
              <CardDescription>
                删除不可撤销：这个用户的 API 密钥与用量明细会失去归属。余额不会自动退回。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRemoving(null)}>
                取消
              </Button>
              <Button variant="destructive" onClick={() => void removeUser(removing)}>
                确认删除
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
