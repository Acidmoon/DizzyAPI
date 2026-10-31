"use client";

/**
 * 兑换码（`/dashboard/redeem`）：批次与码的管理 + 生成（明文只出现一次）。
 *
 * 接口（都要管理员权限）：
 * - `GET /api/admin/redeem-codes?batch=&status=&keyword=&limit=&offset=` → 只有**掩码**
 * - `POST /api/admin/redeem-codes` → 生成批次，响应里带**明文码**，只有这一次
 * - `DELETE /api/admin/redeem-codes` + body `{ ids }`（不是 `DELETE /:id`；已用的会被拒）
 * - `POST /api/admin/redeem-codes/status` + body `{ id, status }`
 * - `POST /api/admin/redeem-codes/resolve` + body `{ id, outcome: 'used' | 'enabled' }`（人工核查）
 *
 * 三条纪律：
 * - **明文码只在生成后的那一次响应里**：关掉弹窗就没；不进 URL、不进 localStorage、不进 console。
 * - 列表永远只有掩码（服务端只存 sha256 + 末 4 位）。
 * - 删除是批量 + 不可逆，要二次确认，并逐条显示服务端拒绝的原因。
 */
import { useCallback, useState } from "react";

import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, adminCommerce, ApiError, type RedeemCodeView } from "@/lib/api";
import { formatDateTime, formatMicrosAsYuan, formatTokens } from "@/lib/format";

import { DataState } from "./data-state";
import { RedeemCreateDialog } from "./redeem-create-dialog";
import { useResource } from "./use-resource";

const PAGE_SIZE = 20;

const CODE_STATUS: Record<string, string> = {
  enabled: "可用",
  disabled: "已停用",
  redeeming: "兑换中（需人工核查）",
  used: "已使用",
  expired: "已过期",
};

/** 状态徽标：`redeeming` 是 CAS 中间态，必须跟「已用」区分开。 */
function CodeStatusBadge({ status }: { status: string }) {
  const label = CODE_STATUS[status] ?? status;
  const tone =
    status === "enabled"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : status === "redeeming"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : status === "used"
          ? "bg-muted text-muted-foreground"
          : "bg-destructive/15 text-destructive";
  return (
    <Badge variant="outline" className={tone}>
      {label}
    </Badge>
  );
}

export function RedeemBoard() {
  const [status, setStatus] = useState<"all" | "enabled" | "disabled" | "used" | "redeeming">("all");
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<RedeemCodeView | null>(null);

  const load = useCallback(
    () =>
      adminCommerce.fetchRedeemCodes(api, {
        ...(status === "all" ? {} : { status }),
        limit: PAGE_SIZE,
        offset,
      }),
    [status, offset],
  );
  const { data, error, loading, reload } = useResource(load);
  const codes = data?.items ?? [];

  async function setCodeStatus(code: RedeemCodeView, next: "enabled" | "disabled"): Promise<void> {
    try {
      await adminCommerce.setRedeemCodeStatus(api, { id: code.id, status: next });
      toast.success(next === "enabled" ? "已启用" : "已停用");
      reload();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "操作失败");
    }
  }

  async function removeCode(code: RedeemCodeView): Promise<void> {
    try {
      const result = await adminCommerce.deleteRedeemCodes(api, [code.id]);
      if (result.rejected.length > 0) {
        toast.error(result.rejected[0]?.reason ?? "服务端拒绝了删除");
      } else {
        toast.success("已删除");
      }
      setRemoving(null);
      reload();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "删除失败");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">兑换码</h1>
                  </div>
        <div className="flex gap-2">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as typeof status);
              setOffset(0);
            }}
          >
            <SelectTrigger size="sm" className="w-40" aria-label="按状态筛选">
              <span className="text-muted-foreground">状态：</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="enabled">可用</SelectItem>
                <SelectItem value="disabled">已停用</SelectItem>
                <SelectItem value="used">已使用</SelectItem>
                <SelectItem value="redeeming">兑换中</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw /> 刷新
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> 生成批次
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">兑换码</CardTitle>
          <CardDescription>
            本页 {codes.length} 条 / 共 {formatTokens(data?.total ?? 0)} 条。
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <DataState
            loading={loading}
            error={error}
            empty={codes.length === 0}
            onRetry={reload}
            emptyTitle="没有兑换码"
            emptyDescription={status === "all" ? "还没有生成过兑换码。" : "这个状态下没有兑换码。"}
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">掩码</TableHead>
                    <TableHead>批次</TableHead>
                    <TableHead className="text-right">面额（元）</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>创建</TableHead>
                    <TableHead>过期</TableHead>
                    <TableHead className="pr-4 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {codes.map((code) => (
                    <TableRow key={code.id}>
                      <TableCell className="pl-4 font-mono text-xs">{code.codeMask}</TableCell>
                      <TableCell className="text-sm">{code.batchName ?? "—"}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatMicrosAsYuan(code.amountMinor)}
                      </TableCell>
                      <TableCell>
                        <CodeStatusBadge status={code.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatDateTime(code.createdAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {code.expiresAt === null ? "不过期" : formatDateTime(code.expiresAt)}
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex justify-end gap-1">
                          {code.status === "enabled" ? (
                            <Button variant="ghost" size="sm" onClick={() => void setCodeStatus(code, "disabled")}>
                              停用
                            </Button>
                          ) : null}
                          {code.status === "disabled" ? (
                            <Button variant="ghost" size="sm" onClick={() => void setCodeStatus(code, "enabled")}>
                              启用
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => setRemoving(code)}
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
                  disabled={offset + PAGE_SIZE >= (data?.total ?? 0)}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <RedeemCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          reload();
        }}
      />

      {removing === null ? null : (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-base">删除兑换码 {removing.codeMask}？</CardTitle>
              <CardDescription>
                删除不可逆。已使用的码会被服务端拒绝删除（它已经是别人的钱），逐条原因会显示出来。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRemoving(null)}>
                取消
              </Button>
              <Button variant="destructive" onClick={() => void removeCode(removing)}>
                确认删除
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
