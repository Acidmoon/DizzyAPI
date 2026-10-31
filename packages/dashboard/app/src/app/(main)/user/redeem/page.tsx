"use client";

/**
 * 兑换码 `/user/redeem`：输码兑换进余额 + 我的兑换记录。
 *
 * 纪律：
 * - 兑换码是**秘密等价的凭据**：只走 POST body，**不进 URL / 不进 localStorage / 不打 console**；
 * - 兑换失败是**状态类拒绝**（未知 / 已用 / 停用 / 过期 / 兑换中），按服务端稳定码给中文提示，
 *   且**不回显用户输入的码**（服务端也不回显）；
 * - 兑换成功后余额变了：直接重拉，不自己算（余额只有 `user` 插件一个写者）。
 */

import { useCallback, useEffect, useState } from "react";

import { Ticket } from "lucide-react";
import { toast } from "sonner";

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
import { api, errorMessage, formatMicrosYuan, redeem } from "@/lib/api";
import type { RedemptionView } from "@/lib/api";

import { formatLocalDateTime, redeemErrorMessage } from "../_lib/labels";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../_components/page-states";

const REDEMPTION_LIMIT = 20;

export default function UserRedeemPage() {
  const [items, setItems] = useState<readonly RedemptionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ amountMinor: string; balanceMinor: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await redeem.fetchMyRedemptions(api, { limit: REDEMPTION_LIMIT });
      setItems(page.items);
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
    const trimmed = code.trim();
    if (trimmed === "") {
      setFormError("请先输入兑换码");
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await redeem.redeem(api, { code: trimmed });
      setCode("");
      setLastResult({ amountMinor: result.amountMinor, balanceMinor: result.balanceMinor });
      toast.success(`兑换成功：${formatMicrosYuan(result.amountMinor)} 元已到账`);
      await load();
    } catch (caught) {
      // 状态类拒绝按稳定码给中文；其余用服务端的人话 message。
      const codeOfError = (caught as { code?: string }).code ?? "";
      setFormError(redeemErrorMessage(codeOfError, errorMessage(caught)));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="@container/main flex min-w-0 flex-col gap-4 md:gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">兑换码</h1>
        <p className="text-sm text-muted-foreground">
          兑换成功后额度直接进余额；兑换码不区分大小写，分隔符可以省略。
        </p>
      </div>

      {error === null ? null : <ErrorBlock message={error} onRetry={() => void load()} />}

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>输入兑换码</CardTitle>
          <CardDescription>每张码只能兑换一次</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form
            className="flex flex-wrap items-start gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field className="w-72" data-invalid={formError === null ? undefined : true}>
              <FieldLabel htmlFor="redeem-code">兑换码</FieldLabel>
              <Input
                id="redeem-code"
                value={code}
                autoComplete="off"
                spellCheck={false}
                placeholder="例如：ABCD-EFGH-JKMN"
                onChange={(event) => setCode(event.target.value)}
                aria-invalid={formError === null ? undefined : true}
              />
              <FieldDescription>粘贴时前后的空格会被忽略</FieldDescription>
            </Field>
            <div className="flex flex-col gap-1 pt-5">
              <Button type="submit" disabled={submitting}>
                <Ticket className="size-3.5" />
                {submitting ? "兑换中…" : "兑换"}
              </Button>
            </div>
          </form>
          {formError === null ? null : <FieldError>{formError}</FieldError>}
          {lastResult === null ? null : (
            <p className="text-sm">
              上次兑换：<strong className="tabular-nums">{formatMicrosYuan(lastResult.amountMinor)} 元</strong>
              ，兑换后余额{" "}
              <strong className="tabular-nums">{formatMicrosYuan(lastResult.balanceMinor)} 元</strong>
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>我的兑换记录</CardTitle>
          <CardDescription>只显示掩码，完整兑换码不会出现在这里</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <LoadingBlock rows={4} label="正在加载兑换记录…" />
          ) : items.length === 0 ? (
            <EmptyBlock title="还没有兑换记录" description="兑换成功后这里会出现一条" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>兑换码</TableHead>
                  <TableHead className="text-right">额度</TableHead>
                  <TableHead>批次</TableHead>
                  <TableHead>兑换时间</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.codeId}>
                    <TableCell className="font-mono text-xs">{item.codeMask}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMicrosYuan(item.amountMinor)} 元
                    </TableCell>
                    <TableCell className="text-muted-foreground">{item.batchName ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatLocalDateTime(item.redeemedAt)}
                    </TableCell>
                    <TableCell>
                      <Badge>已兑换</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
