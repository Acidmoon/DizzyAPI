"use client";

/**
 * 单条用量详情弹窗：**模型、总耗时、TTFT、token 四桶、实际扣费**（owner 点名的五项）。
 *
 * 数据按 `reqId` 现取（`GET /api/usage/:reqId`），不拿列表行凑：列表行没有
 * `ttftMs` / `reasoningTokens` / `usageComplete`，而且详情接口的 404 与「不是自己的」同形，
 * 前端不必也不该区分。
 *
 * TTFT 为 `null` 时显示「—（未采集）」——旧记录真的没采集过，显示 0 毫秒是在说谎。
 */

import { useEffect, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatDurationMs, formatTokens, formatTtftMs, formatYuan } from "@/lib/format";
import { api, errorMessage, usage as usageApi, type UsageDetailRowView } from "@/lib/api";

import { ErrorBlock } from "./page-states";

interface DetailRowProps {
  label: string;
  value: string;
  hint?: string;
}

function DetailRow({ label, value, hint }: DetailRowProps) {
  return (
    <div className="flex flex-col gap-0.5 border-b py-2 last:border-b-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">
        {value}
        {hint === undefined ? null : <span className="ml-2 text-xs font-normal text-muted-foreground">{hint}</span>}
      </dd>
    </div>
  );
}

export interface UsageDetailDialogProps {
  readonly reqId: string | null;
  readonly onOpenChange: (open: boolean) => void;
}

export function UsageDetailDialog({ reqId, onOpenChange }: UsageDetailDialogProps) {
  const [record, setRecord] = useState<UsageDetailRowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const open = reqId !== null;

  useEffect(() => {
    if (reqId === null) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setRecord(null);
    void (async () => {
      try {
        const detail = await usageApi.fetchUsageDetail(api, reqId);
        if (alive) setRecord(detail.record);
      } catch (caught) {
        if (alive) setError(errorMessage(caught));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [reqId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>请求详情</DialogTitle>
          <DialogDescription className="break-all">{reqId ?? ""}</DialogDescription>
        </DialogHeader>
        {error !== null ? <ErrorBlock message={error} /> : null}
        {loading ? (
          <div className="flex flex-col gap-2" role="status" aria-live="polite">
            <span className="sr-only">正在加载详情…</span>
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : null}
        {record === null || loading ? null : (
          <dl className="flex flex-col">
            <DetailRow label="模型" value={record.model} hint={record.upstreamModel ?? undefined} />
            <DetailRow label="总耗时" value={formatDurationMs(record.durationMs)} />
            <DetailRow label="首字延迟（TTFT）" value={formatTtftMs(record.ttftMs)} />
            <DetailRow label="输入 token" value={formatTokens(record.inputTokens)} />
            <DetailRow label="输出 token" value={formatTokens(record.outputTokens)} />
            <DetailRow label="缓存读取 token" value={formatTokens(record.cacheReadTokens)} />
            <DetailRow label="缓存写入 token" value={formatTokens(record.cacheWriteTokens)} />
            <DetailRow label="合计 token" value={formatTokens(record.totalTokens)} />
            <DetailRow label="实际扣费" value={formatYuan(record.costMicros)} hint="按真实 token 用量计算" />
            <DetailRow label="API 密钥" value={record.apiKeyName === "" ? "—" : record.apiKeyName} />
            <DetailRow
              label="状态"
              value={record.status === 200 ? "成功" : `失败（HTTP ${record.status}）`}
              hint={record.errorCode ?? undefined}
            />
            <DetailRow label="协议 / 流式" value={`${record.protocol} · ${record.stream ? "流式" : "非流式"}`} />
            <DetailRow label="发生时间" value={formatDateTime(record.startedAt)} />
            {record.usageComplete ? null : (
              <DetailRow
                label="用量完整性"
                value={record.usagePresent ? "部分采集（上游未返回完整用量）" : "上游未返回用量"}
              />
            )}
          </dl>
        )}
      </DialogContent>
    </Dialog>
  );
}
