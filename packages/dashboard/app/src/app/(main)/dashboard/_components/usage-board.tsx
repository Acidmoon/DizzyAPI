"use client";

/**
 * 用量明细（`/dashboard/usage`）：全站请求明细 + 汇总 + 隔离区。
 *
 * 接口（都要管理员权限）：
 * - `GET /api/admin/usage?range=&userId=&model=&status=&cursor=&limit=`
 * - `GET /api/admin/usage/export` → `{ filename, content }`（CSV 文本，前端拼 Blob 下载）
 *
 * 三条纪律：
 * - 分页是 **keyset**（`cursor` 是上一页最后一条的 id），不是 offset —— 用 offset 会漏行。
 * - 隔离区（`rejected`）里的记录**不结算、不扣钱**，页面必须明说，否则就是「静默免单」。
 */
import { useCallback, useState } from "react";

import { Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, adminOps, ApiError } from "@/lib/api";
import {
  formatDateTime,
  formatDurationMs,
  formatMicrosAsYuan,
  formatTokens,
} from "@/lib/format";

import { DataState } from "./data-state";
import { useResource } from "./use-resource";

const PAGE_SIZE = 20;

export function UsageBoard() {
  const [range, setRange] = useState<"7d" | "30d" | "90d">("30d");
  const [model, setModel] = useState("");
  const [statusText, setStatusText] = useState("");
  const [userIdText, setUserIdText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [exporting, setExporting] = useState(false);

  /** 输入校验前先判：非法值不发请求（服务端会 400，但没必要打一趟）。 */
  const filters = useCallback(() => {
    const parsedStatus = /^\d+$/.test(statusText.trim()) ? Number(statusText.trim()) : undefined;
    const parsedUser = /^\d+$/.test(userIdText.trim()) ? Number(userIdText.trim()) : undefined;
    return {
      range,
      ...(model.trim() === "" ? {} : { model: model.trim() }),
      ...(parsedStatus === undefined ? {} : { status: parsedStatus }),
      ...(parsedUser === undefined ? {} : { userId: parsedUser }),
    };
  }, [range, model, statusText, userIdText]);

  // `cursor` 是 keyset 分页的「上一页最后一条 id」，**服务端合法区间是 [1, MAX]**（`admin_usage.ts`
  // 的 `parseIntegerParam(cursor, 'cursor', 0, 1, MAX)`）。首页不能发 `cursor=0` —— 那会直接 400，
  // 表现就是「用量明细页第一次打开永远是错误态，翻一页才出数据」。所以首屏整条不传。
  const load = useCallback(
    () =>
      adminOps.fetchAdminUsage(api, {
        ...filters(),
        ...(cursor > 0 ? { cursor } : {}),
        limit: PAGE_SIZE,
      }),
    [filters, cursor],
  );
  const { data, error, loading, reload } = useResource(load);
  const records = data?.records.items ?? [];

  async function exportCsv(): Promise<void> {
    setExporting(true);
    try {
      const file = await adminOps.exportAdminUsage(api, filters());
      // 服务端契约是 JSON `{filename, content}`（不是 text/csv），这里自己拼 Blob。
      const blob = new Blob([file.content], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success("已导出 CSV");
    } catch (cause) {
      const failure = cause instanceof ApiError ? cause : null;
      toast.error(failure?.message ?? "导出失败");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">用量明细</h1>
        <Button variant="outline" onClick={() => void exportCsv()} disabled={exporting}>
          <Download /> {exporting ? "导出中…" : "导出 CSV"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">筛选条件</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="usage-range">时间范围</Label>
              <Select
                value={range}
                onValueChange={(value) => {
                  setRange(value as typeof range);
                  setCursor(0);
                }}
              >
                <SelectTrigger id="usage-range" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="7d">近 7 天</SelectItem>
                    <SelectItem value="30d">近 30 天</SelectItem>
                    <SelectItem value="90d">近 90 天</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="usage-model">模型</Label>
              <Input
                id="usage-model"
                className="w-44"
                value={model}
                onChange={(event) => {
                  setModel(event.target.value);
                  setCursor(0);
                }}
                placeholder="精确匹配…"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="usage-user">用户 ID</Label>
              <Input
                id="usage-user"
                className="w-28"
                inputMode="numeric"
                value={userIdText}
                onChange={(event) => {
                  setUserIdText(event.target.value);
                  setCursor(0);
                }}
                placeholder="全部…"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="usage-status">HTTP 状态</Label>
              <Input
                id="usage-status"
                className="w-28"
                inputMode="numeric"
                value={statusText}
                onChange={(event) => {
                  setStatusText(event.target.value);
                  setCursor(0);
                }}
                placeholder="全部…"
                autoComplete="off"
              />
            </div>
            <Button variant="outline" onClick={reload}>
              <RefreshCw /> 刷新
            </Button>
          </div>
        </CardContent>
      </Card>

      {data !== null && data.rejected.total > 0 ? (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="text-base">隔离区 {formatTokens(data.rejected.total)} 条</CardTitle>
            <CardDescription>
              这些记录落库失败、**没有结算也没有扣钱**；其中 {formatTokens(data.rejected.pending)} 条待处理。
              点上面的「刷新」看最新；详细分页在隔离区接口。
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {data === null ? null : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">请求数</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold tabular-nums">
              {formatTokens(data.totals.requests)}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">token 合计</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold tabular-nums">
              {formatTokens(data.totals.tokens)}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">费用（元）</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold tabular-nums">
              {formatMicrosAsYuan(data.totals.costMicros)}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">价表</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {data.pricingAvailable ? "可用" : "不可用：费用显示为 0"}
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">请求明细</CardTitle>
          <CardDescription>
            {data === null ? "" : `${data.from} ~ ${data.to}，本页 ${records.length} 条`}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <DataState
            loading={loading}
            error={error}
            empty={records.length === 0}
            onRetry={reload}
            emptyTitle="这个窗口里没有请求"
            emptyDescription="换个时间范围或去掉筛选条件试试。"
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">时间</TableHead>
                    <TableHead>用户</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead className="text-right">输入 / 输出</TableHead>
                    <TableHead className="text-right">耗时</TableHead>
                    <TableHead className="text-right">状态</TableHead>
                    <TableHead className="pr-4 text-right">费用（元）</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell className="pl-4 text-xs">{formatDateTime(record.startedAt)}</TableCell>
                      <TableCell className="text-sm">
                        {record.userName ?? `#${String(record.userId)}`}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {record.model}
                        {record.upstreamModel === null || record.upstreamModel === record.model ? null : (
                          <span className="text-muted-foreground"> → {record.upstreamModel}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {formatTokens(record.inputTokens)} / {formatTokens(record.outputTokens)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {formatDurationMs(record.durationMs)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant="outline"
                          className={
                            record.status >= 200 && record.status < 300
                              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                              : "bg-destructive/15 text-destructive"
                          }
                        >
                          {record.status}
                        </Badge>
                        {record.errorCode === null ? null : (
                          <div className="mt-1 font-mono text-[10px] text-muted-foreground">{record.errorCode}</div>
                        )}
                      </TableCell>
                      <TableCell className="pr-4 text-right font-mono text-xs tabular-nums">
                        {formatMicrosAsYuan(record.costMicros)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between gap-2 px-4 pt-3">
              <span className="text-xs text-muted-foreground">
                {data?.records.nextCursor === null || data?.records.nextCursor === undefined
                  ? "已到最后一页"
                  : "还有更多"}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={cursor === 0} onClick={() => setCursor(0)}>
                  回到第一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={data?.records.nextCursor === null || data?.records.nextCursor === undefined}
                  onClick={() => setCursor(data?.records.nextCursor ?? cursor)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </DataState>
        </CardContent>
      </Card>
    </div>
  );
}
