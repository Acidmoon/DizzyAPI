"use client";

/**
 * 角色权限（`/dashboard/roles`）：全站角色分布 + 按角色查看 / 改角色。
 *
 * 接口（都要管理员权限）：
 * - `GET /api/users?offset=&limit=` → `{ items: AdminUserView[] }`（**没有** role 筛选参数）
 * - `PATCH /api/users/:id` + body `{ role }` → 改角色（服务端记审计）
 *
 * 四条纪律：
 * - **本页的角色筛选是「对本页数据过滤」**，不是服务端筛选（API 没有 role 参数）。
 *   页面必须写清这一点，否则管理员会以为「筛选后看到的就是全站所有管理员」。
 * - 改角色只提交 `{ role }` 一个字段（服务端逐项 diff、逐项审计）。
 * - 把自己降权 = 立刻失去管理台权限，必须二次确认并明确说后果。
 * - 角色未知值原样显示（不冒充「普通用户」）。
 */
import { useCallback, useState } from "react";

import { RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, adminUsers, ApiError, type AdminUserView } from "@/lib/api";
import { formatDateTime, formatTokens } from "@/lib/format";

import { roleLabel } from "./admin-logic";
import { DataState } from "./data-state";
import { useResource } from "./use-resource";

const PAGE_SIZE = 50;

export function RolesBoard() {
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "user">("all");
  const [offset, setOffset] = useState(0);
  const [promoting, setPromoting] = useState<AdminUserView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () => adminUsers.listUsers(api, { offset, limit: PAGE_SIZE }),
    [offset],
  );
  const { data, error, loading, reload } = useResource(load);
  const all = data?.items ?? [];
  const visible = roleFilter === "all" ? all : all.filter((user) => user.role === roleFilter);
  const adminCount = all.filter((user) => user.role === "admin").length;
  const userCount = all.length - adminCount;

  async function changeRole(user: AdminUserView, role: "admin" | "user"): Promise<void> {
    setBusy(true);
    try {
      await adminUsers.updateUser(api, user.id, { role });
      toast.success(`已把「${user.name}」改为${roleLabel(role)}`);
      setPromoting(null);
      reload();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "改角色失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">角色权限</h1>
                  </div>
        <div className="flex gap-2">
          <Select
            value={roleFilter}
            onValueChange={(value) => setRoleFilter(value as typeof roleFilter)}
          >
            <SelectTrigger size="sm" className="w-36" aria-label="按角色筛选">
              <span className="text-muted-foreground">角色：</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="admin">管理员</SelectItem>
                <SelectItem value="user">普通用户</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw /> 刷新
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">本页用户</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">{formatTokens(all.length)}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">本页管理员</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">{formatTokens(adminCount)}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">本页普通用户</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">{formatTokens(userCount)}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">用户与角色</CardTitle>
          <CardDescription>
            注意：这里的角色筛选是**对本页 {all.length} 条数据过滤**，不是服务端筛选（`/api/users` 没有 role 参数）。
            要全站口径请翻页看完或直接用用户管理页。
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <DataState
            loading={loading}
            error={error}
            empty={visible.length === 0}
            onRetry={reload}
            emptyTitle="没有匹配的用户"
            emptyDescription="换个角色筛选试试，或者翻到下一页。"
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">用户</TableHead>
                    <TableHead>角色</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>注册</TableHead>
                    <TableHead className="pr-4 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="pl-4">
                        <div className="flex flex-col">
                          <span className="font-medium">{user.name}</span>
                          <span className="text-xs text-muted-foreground">#{user.id}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={user.role === "admin" ? "default" : "outline"}>
                          {user.role === "admin" ? <ShieldCheck /> : null}
                          {roleLabel(user.role)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {user.status === "enabled" ? "启用" : "封禁"}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatDateTime(user.createdAt)}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPromoting(user)}
                        >
                          {user.role === "admin" ? "降为普通用户" : "设为管理员"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between gap-2 px-4 pt-3">
              <span className="text-xs text-muted-foreground">
                第 {Math.floor(offset / PAGE_SIZE) + 1} 页
              </span>
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
                  disabled={all.length < PAGE_SIZE}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </DataState>
        </CardContent>
      </Card>

      {promoting === null ? null : (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-base">
                {promoting.role === "admin" ? "降为普通用户？" : "设为管理员？"}
              </CardTitle>
              <CardDescription>
                {promoting.role === "admin"
                  ? `「${promoting.name}」会立刻失去管理台的全部权限（包括这个页面）。如果这是你自己，你会当场被踢出管理员面。`
                  : `「${promoting.name}」会获得管理台的全部权限：用户、账号池、价格、兑换码、结算、审计、设置。`}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPromoting(null)} disabled={busy}>
                取消
              </Button>
              <Button
                variant={promoting.role === "admin" ? "destructive" : "default"}
                onClick={() => void changeRole(promoting, promoting.role === "admin" ? "user" : "admin")}
                disabled={busy}
              >
                {busy ? "提交中…" : "确认"}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
