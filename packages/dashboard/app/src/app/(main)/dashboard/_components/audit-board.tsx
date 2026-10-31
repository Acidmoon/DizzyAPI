"use client";

/**
 * 操作审计（`/dashboard/audit`）：谁、经哪个插件、对谁、做了什么、结果如何。
 *
 * 接口（要管理员权限）：
 * - `GET /api/admin/audit?actor=&action=&targetType=&from=&to=&limit=&offset=&stats=1`
 *
 * 五条纪律：
 * - **本页没有任何写操作**：审计能被改就等于没有。旧 SSR 版也是只读页面。
 * - **审计是旁路**：它挂掉不影响业务写操作，所以这里 503 只说明「暂时看不到记录」，
 *   不是「记录丢了」。
 * - **没映射的动作码原样显示**（不空白）：空白会让人以为「这条没事」。
 * - **时间窗按 UTC 切天**（与服务端、与旧 SSR 版同口径）。
 * - **元数据已脱敏**，但仍然可能很长：只截断展示，不整段塞进表格。
 */
import { useCallback, useState } from "react";

import { RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, adminOps } from "@/lib/api";
import { formatDateTime, formatTokens } from "@/lib/format";

import { AUDIT_ACTION_LABELS, AUDIT_TARGET_LABELS, auditActionLabel, auditTargetLabel, dateRangeMs, metadataLine } from "./audit-logic";
import { DataState } from "./data-state";
import { DateRangePicker, type DateRangeValue } from "./date-range-picker";
import { useResource } from "./use-resource";

const PAGE_SIZE = 50;

export function AuditBoard() {
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [targetType, setTargetType] = useState("");
  const [range, setRange] = useState<DateRangeValue>({ from: "", to: "" });
  const [offset, setOffset] = useState(0);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const load = useCallback(() => {
    const ms = dateRangeMs(range.from, range.to);
    if (ms === null) {
      // 区间反了或日期非法：明确失败，不发请求（发出去只会得到空结果，看不出原因）。
      return Promise.reject(
        new Error("日期范围不合法：起始日期不能晚于结束日期，且必须是 YYYY-MM-DD"),
      );
    }
    return adminOps.fetchAudit(api, {
      ...(actor.trim() === "" ? {} : { actor: actor.trim() }),
      ...(action === "" ? {} : { action }),
      ...(targetType === "" ? {} : { targetType }),
      ...ms,
      limit: PAGE_SIZE,
      offset,
      stats: "1",
    });
  }, [actor, action, targetType, range.from, range.to, offset]);

  const { data, error, loading, reload } = useResource(load);
  const items = data?.items ?? [];
  const stats = data?.stats;

  function changeRange(next: DateRangeValue): void {
    setRange(next);
    setOffset(0);
    setRangeError(dateRangeMs(next.from, next.to) === null ? "日期范围不合法" : null);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">操作审计</h1>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">记录总数</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatTokens(stats?.total ?? 0)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">今日</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatTokens(stats?.today ?? 0)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">最近 24 小时</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatTokens(stats?.last24h ?? 0)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">失败操作</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatTokens(stats?.failed ?? 0)}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">筛选条件</CardTitle>
          <CardDescription>
            操作者要填完整形态（形如 <code className="font-mono">user:1:admin</code>）；动作与目标是精确匹配。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="audit-actor">操作者</Label>
              <Input
                id="audit-actor"
                className="w-52"
                value={actor}
                onChange={(event) => {
                  setActor(event.target.value);
                  setOffset(0);
                }}
                placeholder="user:1:admin…"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="audit-action">动作</Label>
              <Select
                value={action}
                onValueChange={(value) => {
                  setAction(value === "all" ? "" : value);
                  setOffset(0);
                }}
              >
                <SelectTrigger id="audit-action" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">全部动作</SelectItem>
                    {Object.entries(AUDIT_ACTION_LABELS).map(([code, label]) => (
                      <SelectItem key={code} value={code}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="audit-target">目标类型</Label>
              <Select
                value={targetType}
                onValueChange={(value) => {
                  setTargetType(value === "all" ? "" : value);
                  setOffset(0);
                }}
              >
                <SelectTrigger id="audit-target" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">全部目标</SelectItem>
                    {Object.entries(AUDIT_TARGET_LABELS).map(([code, label]) => (
                      <SelectItem key={code} value={code}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>时间范围（UTC）</Label>
              <DateRangePicker value={range} onChange={changeRange} label="时间范围" />
            </div>
            <Button
              variant="outline"
              onClick={() => {
                setActor("");
                setAction("");
                setTargetType("");
                changeRange({ from: "", to: "" });
                setRangeError(null);
              }}
            >
              清空筛选
            </Button>
          </div>
          {rangeError === null ? null : (
            <p className="mt-2 text-xs text-destructive">{rangeError}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">审计记录</CardTitle>
          <CardDescription>
            本页 {items.length} 条 / 共 {formatTokens(data?.total ?? 0)} 条。保留期由 audit 插件配置，过期自动清理。
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <DataState
            loading={loading}
            error={error}
            empty={items.length === 0}
            onRetry={reload}
            emptyTitle="没有符合条件的审计记录"
            emptyDescription="换个筛选条件试试，或清空筛选看全部。"
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">时间（UTC）</TableHead>
                    <TableHead>操作者</TableHead>
                    <TableHead>发起插件</TableHead>
                    <TableHead>动作</TableHead>
                    <TableHead>目标</TableHead>
                    <TableHead>结果</TableHead>
                    <TableHead>摘要</TableHead>
                    <TableHead className="pr-4">元数据（已脱敏）</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="pl-4 text-xs whitespace-nowrap">
                        {formatDateTime(entry.at)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{entry.actor}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{entry.actorPlugin}</TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm">{auditActionLabel(entry.action)}</span>
                          <code className="font-mono text-[10px] text-muted-foreground">{entry.action}</code>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {auditTargetLabel(entry.targetType)}
                        {entry.targetId === "" ? null : (
                          <code className="ml-1 font-mono text-[10px] text-muted-foreground">
                            {entry.targetId}
                          </code>
                        )}
                      </TableCell>
                      <TableCell>
                        {entry.result === "failed" ? (
                          <Badge variant="outline" className="bg-destructive/15 text-destructive">
                            失败{entry.errorCode === null ? "" : ` ${entry.errorCode}`}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                            成功
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{entry.summary}</TableCell>
                      <TableCell className="pr-4 font-mono text-[10px] text-muted-foreground">
                        {metadataLine(entry.metadata)}
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
    </div>
  );
}
