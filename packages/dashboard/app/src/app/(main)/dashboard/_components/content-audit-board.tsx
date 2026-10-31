"use client";

/**
 * 内容审核（`/dashboard/content-audit`）：规则列表 + 推送健康度 + 命中统计。
 *
 * 接口（都要管理员权限）：
 * - `GET /api/admin/content-audit` → `{ items, status }`
 * - `POST /api/admin/content-audit` → 新建规则
 * - `PATCH /api/admin/content-audit/:id` → 改规则
 * - `DELETE /api/admin/content-audit/:id` → 删规则
 * - `POST /api/admin/content-audit/push` → 立刻推一次给 Go（排障用）
 *
 * 五条纪律：
 * - **规则 = 关键词**，只做大小写不敏感子串匹配，不做正则。页面必须写清。
 * - **推送是心跳式的**：内容没变也按周期再推一次（`revision` 不变、`generation` 递增）。
 *   所以「上次推送时间」旧**不代表**没生效，别据此判断失效。
 * - **Go 侧快照过期时默认放行**（可用性优先），严格模式才 503；
 *   `stale` 为真要在页面上说清「此刻审核可能不生效」。
 * - **命中统计只给计数**，绝不给被审文本（那是内容，不是指标）。
 * - **删规则要二次确认**：它会立刻从匹配里消失。
 */
import { useCallback, useState } from "react";

import { Pencil, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, adminOps, ApiError, type ContentAuditRuleView } from "@/lib/api";
import { formatDateTime, formatTokens } from "@/lib/format";

import { contentAuditActionLabel, contentAuditHitsOf, ruleHitCount } from "./content-audit-logic";
import { ContentAuditRuleDialog } from "./content-audit-dialog";
import { DataState } from "./data-state";
import { useResource } from "./use-resource";

export function ContentAuditBoard() {
  const [editing, setEditing] = useState<ContentAuditRuleView | "new" | null>(null);
  const [removing, setRemoving] = useState<ContentAuditRuleView | null>(null);

  const load = useCallback(() => adminOps.fetchContentAudit(api), []);
  const { data, error, loading, reload } = useResource(load);
  const items = data?.items ?? [];
  const status = data?.status;
  // 命中统计在接口类型里是 `Record<string, unknown>`，这里显式收窄（读不出就当没有）。
  const hits = contentAuditHitsOf(status?.hits);

  async function removeRule(rule: ContentAuditRuleView): Promise<void> {
    try {
      await adminOps.deleteContentAuditRule(api, rule.id);
      toast.success("已删除规则");
      setRemoving(null);
      reload();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "删除失败");
    }
  }

  async function pushNow(): Promise<void> {
    try {
      const result = await adminOps.pushContentAuditRules(api);
      toast.success(`已推送一次（revision ${result.revision ?? "—"}）`);
      reload();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "推送失败");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">内容审核</h1>
          <p className="text-sm text-muted-foreground">
            关键词规则只做**大小写不敏感子串匹配**，不是正则。命中 block 规则会 403 拒绝请求；
            命中 log 规则只记日志与计数。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void pushNow()}>
            <Send /> 立刻推送
          </Button>
          <Button variant="outline" onClick={reload}>
            <RefreshCw /> 刷新
          </Button>
          <Button onClick={() => setEditing("new")}>
            <Plus /> 添加规则
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">审核开关</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {status === undefined ? "—" : status.enabled ? "开启" : "关闭"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">规则数</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatTokens(status?.ruleCount ?? 0)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Go 侧快照</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {status?.goReady === true ? "就绪" : status?.goReady === false ? "未就绪" : "—"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">命中（拒绝 / 记录）</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatTokens(hits?.blocked ?? 0)} / {formatTokens(hits?.logged ?? 0)}
          </CardContent>
        </Card>
      </div>

      {status === undefined || status === null ? null : status.stale ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="text-base">Go 侧快照已过期</CardTitle>
            <CardDescription>
              审核规则已经推过去，但 Go 侧读到的快照超过 TTL。此刻**审核可能不生效**
              （Go 侧默认放行，可用性优先）；推送是心跳式的，内容没变也会按周期再推。
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">规则列表</CardTitle>
          <CardDescription>
            共 {items.length} 条。规则改动会随下一次心跳推给 Go；也可以点「立刻推送」马上生效。
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <DataState
            loading={loading}
            error={error}
            empty={items.length === 0}
            onRetry={reload}
            emptyTitle="还没有审核规则"
            emptyDescription="审核关闭时所有请求都会放行。点右上角「添加规则」开始。"
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">关键词</TableHead>
                    <TableHead>命中动作</TableHead>
                    <TableHead>分类</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>命中次数</TableHead>
                    <TableHead>备注</TableHead>
                    <TableHead>更新于</TableHead>
                    <TableHead className="pr-4 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((rule) => (
                    <TableRow key={rule.id}>
                      <TableCell className="pl-4 font-mono text-xs">{rule.pattern}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            rule.action === "block"
                              ? "bg-destructive/15 text-destructive"
                              : "bg-muted text-muted-foreground"
                          }
                        >
                          {contentAuditActionLabel(rule.action)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{rule.category ?? "—"}</TableCell>
                      <TableCell>
                        {rule.enabled ? (
                          <Badge variant="outline" className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                            启用
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="bg-muted text-muted-foreground">
                            停用
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatTokens(ruleHitCount(hits, rule.id))}
                      </TableCell>
                      <TableCell className="max-w-48 truncate text-xs text-muted-foreground">
                        {rule.note ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatDateTime(rule.updatedAt)}
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setEditing(rule)}>
                            <Pencil /> 编辑
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => setRemoving(rule)}
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
          </DataState>
        </CardContent>
      </Card>

      <ContentAuditRuleDialog
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条规则？</AlertDialogTitle>
            <AlertDialogDescription>
              关键词「{removing?.pattern ?? ""}」会立刻从匹配里消失，下一次推送给 Go 之后不再拦截。
              历史记录不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing !== null) void removeRule(removing);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
