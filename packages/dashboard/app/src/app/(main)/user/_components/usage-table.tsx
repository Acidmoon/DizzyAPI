"use client";

/**
 * 用量表格（概览的「最近请求」与明细页共用）：每行一个「详情」按钮 → 详情弹窗。
 *
 * 为什么共用：owner 明确要求「最近请求与用量明细里都要有查看详情」，两处用同一份实现
 * 才能保证字段与文案一致；分叉两份迟早会漂移。
 *
 * 宽表靠 `Table` 自带的 `overflow-x-auto` 容器横向滚（上游 `table.tsx` 已经这么做），
 * 420px 下不会被裁掉右边的列。
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatDurationMs, formatTokens, formatYuan } from "@/lib/format";
import type { UsageRowView } from "@/lib/api";

import { EmptyBlock } from "./page-states";
import { UsageDetailDialog } from "./usage-detail-dialog";

function StatusBadge({ record }: { record: UsageRowView }) {
  const ok = record.status === 200;
  return (
    <span
      className={
        ok ? "text-xs font-medium text-emerald-600 dark:text-emerald-400" : "text-xs font-medium text-destructive"
      }
      data-status={record.status}
    >
      {ok ? "成功" : `失败 ${record.status}`}
    </span>
  );
}

export interface UsageTableProps {
  readonly records: readonly UsageRowView[];
  readonly emptyTitle: string;
  readonly emptyDescription?: string;
  /** 最近请求传 true：列更少（时间 / 模型 / 状态 / 金额 / 详情）。 */
  readonly compact?: boolean;
  readonly caption?: string;
}

export function UsageTable({ records, emptyTitle, emptyDescription, compact = false, caption }: UsageTableProps) {
  const [activeReqId, setActiveReqId] = useState<string | null>(null);

  if (records.length === 0) {
    return <EmptyBlock title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <>
      <Table>
        {caption === undefined ? null : <caption className="pb-2 text-left text-sm text-muted-foreground">{caption}</caption>}
        <TableHeader>
          <TableRow>
            <TableHead>时间</TableHead>
            <TableHead>模型</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">Token</TableHead>
            {compact ? null : <TableHead className="text-right">耗时</TableHead>}
            <TableHead className="text-right">金额</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => (
            <TableRow key={record.reqId}>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatDateTime(record.startedAt)}
              </TableCell>
              <TableCell className="max-w-44 truncate font-medium" title={record.model}>
                {record.model}
              </TableCell>
              <TableCell>
                <StatusBadge record={record} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatTokens(record.totalTokens)}</TableCell>
              {compact ? null : (
                <TableCell className="text-right tabular-nums">{formatDurationMs(record.durationMs)}</TableCell>
              )}
              <TableCell className="text-right tabular-nums">{formatYuan(record.costMicros)}</TableCell>
              <TableCell className="text-right">
                <Button size="sm" variant="ghost" onClick={() => setActiveReqId(record.reqId)}>
                  详情
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <UsageDetailDialog reqId={activeReqId} onOpenChange={(open) => (open ? undefined : setActiveReqId(null))} />
    </>
  );
}
