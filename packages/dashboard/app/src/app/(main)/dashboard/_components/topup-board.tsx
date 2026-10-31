"use client";

/**
 * 充值订单（`/dashboard/topup`）：订单列表 + 统计 + 确认到账 / 取消。
 *
 * 接口（都要管理员权限）：
 * - `GET /api/admin/topup-orders?status=&userId=&limit=&offset=`
 * - `GET /api/admin/topup-orders/stats`
 * - `POST /api/admin/topup-orders/:orderNo/confirm` → **会真的加余额**，且幂等
 * - `POST /api/admin/topup-orders/:orderNo/cancel`
 *
 * 三条纪律：
 * - **本批没有在线支付**：订单是 `pending`，靠人工确认到账（`provider = manual`），页面必须写清。
 * - 确认是**不可撤销的加钱动作**：必须二次确认，并把金额与订单号显示在确认框里。
 * - `credited: false` 表示「这次没加钱」（重复确认），要如实告诉操作者，不能显示成「已到账」。
 */
import { useCallback, useState } from "react";

import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, adminCommerce, ApiError, type TopupOrderView } from "@/lib/api";
import { formatDateTime, formatMicrosAsYuan, formatTokens } from "@/lib/format";

import { DataState } from "./data-state";
import { useResource } from "./use-resource";

const PAGE_SIZE = 20;

const ORDER_STATUS: Record<string, string> = {
  pending: "待付款",
  paid: "已到账",
  canceled: "已取消",
  expired: "已过期",
};

function OrderStatusBadge({ status }: { status: string }) {
  const label = ORDER_STATUS[status] ?? status;
  const tone =
    status === "paid"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : status === "pending"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : "bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={tone}>
      {label}
    </Badge>
  );
}

export function TopupBoard() {
  const [status, setStatus] = useState<"all" | "pending" | "paid" | "canceled" | "expired">("pending");
  const [offset, setOffset] = useState(0);
  const [confirming, setConfirming] = useState<TopupOrderView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async () => {
      // 两个接口并行：统计不可用不该让列表也没了，所以统计失败时给 null。
      const [list, stats] = await Promise.all([
        adminCommerce.fetchTopupOrders(api, {
          ...(status === "all" ? {} : { status }),
          limit: PAGE_SIZE,
          offset,
        }),
        adminCommerce.fetchTopupStats(api).catch(() => null),
      ]);
      return { list, stats };
    },
    [status, offset],
  );
  const { data, error, loading, reload } = useResource(load);
  const orders = data?.list.items ?? [];
  const stats = data?.stats ?? null;

  async function confirmOrder(order: TopupOrderView): Promise<void> {
    setBusy(true);
    try {
      const result = await adminCommerce.confirmTopupOrder(api, order.orderNo);
      // `credited` 为假 = 幂等命中，这次没加钱。如实说明，别报「已到账」。
      if (result.credited) {
        toast.success(`已到账 ${formatMicrosAsYuan(result.order.amountMicro)} 元`);
      } else {
        toast.info("这单之前已经确认过，本次没有重复加钱");
      }
      setConfirming(null);
      reload();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "确认失败");
    } finally {
      setBusy(false);
    }
  }

  async function cancelOrder(order: TopupOrderView): Promise<void> {
    try {
      await adminCommerce.cancelTopupOrder(api, order.orderNo);
      toast.success("已取消订单");
      reload();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "取消失败");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">充值订单</h1>
        <div className="flex gap-2">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as typeof status);
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
                <SelectItem value="pending">待付款</SelectItem>
                <SelectItem value="paid">已到账</SelectItem>
                <SelectItem value="canceled">已取消</SelectItem>
                <SelectItem value="expired">已过期</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw /> 刷新
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">今日到账</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            <span className="text-2xl font-semibold tabular-nums">
              {formatTokens(stats?.todayPaidCount ?? 0)} 笔
            </span>
            <span className="text-xs text-muted-foreground">
              {stats === null ? "统计不可用" : `${formatMicrosAsYuan(stats.todayPaidMicros)} 元`}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">累计到账</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            <span className="text-2xl font-semibold tabular-nums">
              {formatTokens(stats?.totalPaidCount ?? 0)} 笔
            </span>
            <span className="text-xs text-muted-foreground">
              {stats === null ? "统计不可用" : `${formatMicrosAsYuan(stats.totalPaidMicros)} 元`}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">待付款</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatTokens(stats?.pendingCount ?? 0)} 笔
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">已过期</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatTokens(stats?.expiredCount ?? 0)} 笔
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">订单列表</CardTitle>
          <CardDescription>
            本页 {orders.length} 条 / 共 {formatTokens(data?.list.total ?? 0)} 条。
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <DataState
            loading={loading}
            error={error}
            empty={orders.length === 0}
            onRetry={reload}
            emptyTitle="没有订单"
            emptyDescription={status === "pending" ? "当前没有待确认的订单。" : "这个状态下没有订单。"}
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">订单号</TableHead>
                    <TableHead className="text-right">金额（元）</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>用户</TableHead>
                    <TableHead>创建</TableHead>
                    <TableHead>过期</TableHead>
                    <TableHead className="pr-4 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((order) => (
                    <TableRow key={order.orderNo}>
                      <TableCell className="pl-4 font-mono text-xs">{order.orderNo}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatMicrosAsYuan(order.amountMicro)}
                      </TableCell>
                      <TableCell>
                        <OrderStatusBadge status={order.status} />
                      </TableCell>
                      <TableCell className="text-sm">#{order.userId}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatDateTime(order.createdAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatDateTime(order.expiresAt)}
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex justify-end gap-1">
                          {order.status === "pending" ? (
                            <>
                              <Button variant="ghost" size="sm" onClick={() => setConfirming(order)}>
                                <CheckCircle2 /> 确认到账
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive"
                                onClick={() => void cancelOrder(order)}
                              >
                                <XCircle /> 取消
                              </Button>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
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
                  disabled={offset + PAGE_SIZE >= (data?.list.total ?? 0)}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </DataState>
        </CardContent>
      </Card>

      {confirming === null ? null : (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-base">确认到账？</CardTitle>
              <CardDescription>
                订单 <span className="font-mono">{confirming.orderNo}</span> · 用户 #
                {confirming.userId} · <span className="font-mono">{formatMicrosAsYuan(confirming.amountMicro)}</span> 元。
                <br />
                这会**立刻给用户加余额**，且不可撤销。重复确认不会重复加钱（幂等）。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirming(null)} disabled={busy}>
                取消
              </Button>
              <Button onClick={() => void confirmOrder(confirming)} disabled={busy}>
                {busy ? "确认中…" : "确认到账"}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
