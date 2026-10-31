"use client";

/**
 * 充值 `/user/topup`：下单 → 人工确认到账。
 *
 * **本批没有在线支付**（`packages/topup` 只实现 `manual` 通道）：下单只生成一笔
 * `pending` 订单，页面必须让用户明确「不会自动到账」，否则用户转完账看到余额没变会以为丢了。
 *
 * 金额口径：输入框收「元」的十进制字符串，服务端自己换算成整数微元（**不经浮点**）；
 * 展示一律走唯一格式化源（`formatMicrosYuan`）。
 */

import { useCallback, useEffect, useState } from "react";

import { Plus, Wallet } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, errorMessage, formatMicrosYuan, topup } from "@/lib/api";
import type { TopupOptionsView, TopupOrderView } from "@/lib/api";

import {
  TOPUP_STATUS_HINTS,
  TOPUP_STATUS_LABELS,
  TOPUP_STATUS_VARIANTS,
  formatLocalDateTime,
  normalizeYuanInput,
  statusLabel,
} from "../_lib/labels";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../_components/page-states";

/** 订单列表一次取多少（服务端上限 100）。 */
const ORDER_LIMIT = 20;

export default function UserTopupPage() {
  const [options, setOptions] = useState<TopupOptionsView | null>(null);
  const [orders, setOrders] = useState<readonly TopupOrderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<TopupOrderView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextOptions, page] = await Promise.all([
        topup.fetchTopupOptions(api),
        topup.fetchMyOrders(api, { limit: ORDER_LIMIT }),
      ]);
      setOptions(nextOptions);
      setOrders(page.items);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    setFormError(null);
    let micros: string;
    try {
      micros = normalizeYuanInput(amount);
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "金额格式不对");
      return;
    }
    if (micros === "0") {
      setFormError("充值金额必须大于 0");
      return;
    }
    setSubmitting(true);
    try {
      const created = await topup.createOrder(api, {
        amountYuan: amount.trim(),
        ...(note.trim() === "" ? {} : { note: note.trim() }),
      });
      setAmount("");
      setNote("");
      setOrders((current) => [created.order, ...current]);
      toast.success("订单已创建，等待管理员确认到账");
      await load();
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const confirmCancel = async () => {
    if (cancelTarget === null) return;
    const target = cancelTarget;
    setCancelTarget(null);
    try {
      const canceled = await topup.cancelOrder(api, target.orderNo);
      setOrders((current) => current.map((order) => (order.orderNo === canceled.orderNo ? canceled : order)));
      toast.success("订单已取消");
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const pending = orders.find((order) => order.status === "pending");

  return (
    <div className="@container/main flex min-w-0 flex-col gap-4 md:gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">充值</h1>
        <p className="text-sm text-muted-foreground">
          只支持人工确认到账：下单后请联系管理员线下转账，核对后由管理员确认，金额进余额。
          <strong className="ml-1 text-foreground">尚未接入在线支付，不会自动到账。</strong>
        </p>
      </div>

      {error === null ? null : <ErrorBlock message={error} onRetry={() => void load()} />}

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>新建充值订单</CardTitle>
          <CardDescription>
            {loading
              ? "正在读取下单参数…"
              : options === null
                ? "下单参数不可用"
                : `单笔 ${formatMicrosYuan(options.minAmountMicros)} ~ ${formatMicrosYuan(options.maxAmountMicros)} 元 · 订单 ${options.expiresMinutes} 分钟内有效 · 支付方式：${options.providerLabel}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {options === null ? null : <p className="text-sm text-muted-foreground">{options.notice}</p>}
          <form
            className="flex flex-wrap items-start gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field className="w-48" data-invalid={formError === null ? undefined : true}>
              <FieldLabel htmlFor="amount-yuan">充值金额（元）</FieldLabel>
              <Input
                id="amount-yuan"
                value={amount}
                inputMode="decimal"
                autoComplete="off"
                placeholder="例如：100"
                onChange={(event) => setAmount(event.target.value)}
                aria-invalid={formError === null ? undefined : true}
              />
              <FieldDescription>最多 6 位小数</FieldDescription>
            </Field>
            <Field className="w-64">
              <FieldLabel htmlFor="amount-note">备注（可选）</FieldLabel>
              <Input
                id="amount-note"
                value={note}
                autoComplete="off"
                placeholder="例如：对公转账尾号 1234"
                onChange={(event) => setNote(event.target.value)}
              />
              <FieldDescription>只给自己和管理员看</FieldDescription>
            </Field>
            <div className="flex flex-col gap-1 pt-5">
              <Button type="submit" disabled={submitting || loading}>
                <Plus className="size-3.5" />
                {submitting ? "创建中…" : "创建订单"}
              </Button>
            </div>
          </form>
          {formError === null ? null : <FieldError>{formError}</FieldError>}
        </CardContent>
      </Card>

      {pending === undefined ? null : (
        <Card className="min-w-0 overflow-hidden border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="size-4" />
              待确认订单 {pending.orderNo}
            </CardTitle>
            <CardDescription>{TOPUP_STATUS_HINTS.pending}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <p>
              金额 <strong className="tabular-nums">{formatMicrosYuan(pending.amountMicro)} 元</strong> · 请在{" "}
              {formatLocalDateTime(pending.expiresAt)} 前完成转账
            </p>
            <p className="text-muted-foreground">{pending.instructions ?? "请联系管理员确认到账。"}</p>
          </CardContent>
        </Card>
      )}

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>我的充值订单</CardTitle>
          <CardDescription>只列出你自己最近 {ORDER_LIMIT} 笔订单</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <LoadingBlock rows={5} label="正在加载充值订单…" />
          ) : orders.length === 0 ? (
            <EmptyBlock title="还没有充值订单" description="上面填一个金额就能创建第一笔" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>单号</TableHead>
                  <TableHead className="text-right">金额</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>支付方式</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((order) => (
                  <TableRow key={order.orderNo}>
                    <TableCell className="font-mono text-xs">{order.orderNo}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMicrosYuan(order.amountMicro)} 元
                    </TableCell>
                    <TableCell>
                      <Badge variant={TOPUP_STATUS_VARIANTS[order.status] ?? "outline"}>
                        {statusLabel(TOPUP_STATUS_LABELS, order.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{order.providerLabel}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatLocalDateTime(order.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {order.status === "pending" ? (
                        <Button size="sm" variant="ghost" onClick={() => setCancelTarget(order)}>
                          取消
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={cancelTarget !== null}
        onOpenChange={(open) => (open ? undefined : setCancelTarget(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>取消这笔订单？</AlertDialogTitle>
            <AlertDialogDescription>
              单号 {cancelTarget?.orderNo ?? ""}，取消后不能再确认到账，需要重新下单。
              如果你已经转账，请先联系管理员。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>不取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmCancel()}>取消订单</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
