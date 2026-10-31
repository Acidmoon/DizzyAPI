"use client";

/**
 * 结算（`/dashboard/billing`）：真实扣费的**只读**视图。
 *
 * 接口（都要管理员权限）：
 * - `GET /api/admin/billing?status=&limit=&offset=` → `{ totals, daily, models, records, generatedAt }`
 *
 * 四条纪律：
 * - **本页没有写操作**：扣费由 `billing` 插件在后台按真实 usage 结算，
 *   管理面只能看。给「重新扣费」这类按钮会让人以为能改账——不能有。
 * - **金额一律字符串**：服务端给的是整数微元的十进制字符串，页面只透传与格式化，
 *   绝不做浮点运算。
 * - **「待处理」的口径与服务端的 `problem` 筛选一致**（失败 / 待核查 / 结算中残留），
 *   两处必须用同一个判定函数，否则指标卡数字与列表对不上。
 * - **日期按 UTC**：结算的「今日」与按天汇总都是 UTC 日，跟服务端同口径。
 */
import { useCallback, useState } from "react";

import { RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, adminOps } from "@/lib/api";
import { formatMicrosAsYuan, formatMonthDayLabel, formatTokens } from "@/lib/format";

import { isProblemSettleStatus, settleStatusLabel } from "./admin-logic";
import { DataState } from "./data-state";
import { useResource } from "./use-resource";

const PAGE_SIZE = 20;

type StatusFilter = "all" | "problem" | "settled" | "failed" | "review" | "no-price" | "no-user";

/** 状态徽标：失败 / 待核查 / 结算中是需要人看的，用醒目色；已结算是常态。 */
function SettleStatusBadge({ status }: { status: string }) {
  const tone = isProblemSettleStatus(status)
    ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
    : status === "settled"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : "bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={tone}>
      {settleStatusLabel(status)}
    </Badge>
  );
}

export function BillingBoard() {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [offset, setOffset] = useState(0);

  const load = useCallback(
    () =>
      adminOps.fetchBilling(api, {
        ...(status === "all" ? {} : { status }),
        limit: PAGE_SIZE,
        offset,
      }),
    [status, offset],
  );
  const { data, error, loading, reload } = useResource(load);

  const totals = data?.totals;
  const records = data?.records.items ?? [];
  // 「待处理」= 失败 + 待核查 + 结算中残留，与服务端 `problem` 筛选同一口径。
  const openCases =
    (totals?.failed ?? 0) + (totals?.review ?? 0) + (totals?.settling ?? 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">结算</h1>
        <div className="flex items-center gap-2">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as StatusFilter);
              setOffset(0);
            }}
          >
            <SelectTrigger size="sm" className="w-40" aria-label="按结算状态筛选">
              <span className="text-muted-foreground">状态：</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="problem">待处理（失败 / 待核查 / 残留）</SelectItem>
                <SelectItem value="settled">已结算</SelectItem>
                <SelectItem value="failed">失败</SelectItem>
                <SelectItem value="review">待核查</SelectItem>
                <SelectItem value="no-price">无价格</SelectItem>
                <SelectItem value="no-user">无用户</SelectItem>
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
            <CardTitle className="text-sm text-muted-foreground">累计扣费</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatMicrosAsYuan(totals?.chargedMicros ?? "0")} 元
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">今日扣费（UTC）</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatMicrosAsYuan(totals?.todayChargedMicros ?? "0")} 元
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">已结算</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatTokens(totals?.settled ?? 0)} 笔
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">待处理</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatTokens(openCases)} 笔
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">结算记录</CardTitle>
          <CardDescription>
            本页 {records.length} 条 / 共 {formatTokens(data?.records.total ?? 0)} 条。
            「待处理」包含失败、待核查与结算中残留；被隔离的用量不结算也不扣费。
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <DataState
            loading={loading}
            error={error}
            empty={records.length === 0}
            onRetry={reload}
            emptyTitle="没有结算记录"
            emptyDescription="这个筛选下没有记录。结算只在有真实用量落库之后才会产生记录。"
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">请求时间</TableHead>
                    <TableHead>请求 ID</TableHead>
                    <TableHead>用户</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">费用（元）</TableHead>
                    <TableHead className="text-right">扣后余额（元）</TableHead>
                    <TableHead className="pr-4">备注</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((record) => (
                    <TableRow key={record.reqId}>
                      <TableCell className="pl-4 text-xs whitespace-nowrap">
                        {record.startedAt.slice(5, 16).replace("T", " ")}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{record.reqId}</TableCell>
                      <TableCell className="text-sm">#{record.userId}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {record.model === "" ? "—" : record.model}
                      </TableCell>
                      <TableCell>
                        <SettleStatusBadge status={record.status} />
                        {record.overdrawn ? (
                          <Badge variant="outline" className="ml-1 bg-destructive/15 text-destructive">
                            透支
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatMicrosAsYuan(record.costMicro)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {record.balanceAfter === null ? "—" : formatMicrosAsYuan(record.balanceAfter)}
                      </TableCell>
                      <TableCell className="pr-4 text-xs text-muted-foreground">
                        {record.note ?? "—"}
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
                  disabled={offset + PAGE_SIZE >= (data?.records.total ?? 0)}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">按天汇总</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">日期</TableHead>
                    <TableHead className="text-right">请求数</TableHead>
                    <TableHead className="text-right">已结算</TableHead>
                    <TableHead className="pr-4 text-right">扣费（元）</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.daily ?? []).map((point) => (
                    <TableRow key={point.date}>
                      <TableCell className="pl-4 text-xs whitespace-nowrap">
                        {formatMonthDayLabel(point.date)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatTokens(point.records)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatTokens(point.settled)}
                      </TableCell>
                      <TableCell className="pr-4 text-right font-mono tabular-nums">
                        {formatMicrosAsYuan(point.chargedMicros)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">按模型</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">模型</TableHead>
                    <TableHead className="text-right">请求数</TableHead>
                    <TableHead className="pr-4 text-right">扣费（元）</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.models ?? []).map((model) => (
                    <TableRow key={model.model}>
                      <TableCell className="pl-4 font-mono text-xs">
                        {model.model === "" ? "—" : model.model}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatTokens(model.records)}
                      </TableCell>
                      <TableCell className="pr-4 text-right font-mono tabular-nums">
                        {formatMicrosAsYuan(model.chargedMicros)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
