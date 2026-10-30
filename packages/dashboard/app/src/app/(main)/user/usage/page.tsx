"use client";

/**
 * 用量明细 `/user/usage`：筛选 + keyset 分页（「加载更多」）+ 导出 CSV + 每行详情。
 *
 * 分页为什么是「加载更多」而不是页码：`/api/usage` 只给 `nextCursor`（keyset 分页），
 * 没有总数也没有 offset，页码在跳页时会漏行。要页码得后端加接口，属别的批次。
 *
 * 导出走 `/api/usage/export`（JSON `{filename, content}`），前端自己拼 Blob 下载：
 * 阶段 0 定的口径是**不改 api 契约**，也不新开服务端路由。
 */

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

import { formatTokens } from "@/lib/format";

import {
  RANGE_LABELS,
  downloadUsageCsv,
  fetchKeys,
  fetchUsage,
  messageOfError,
  redirectToLogin,
} from "../_lib/api";
import type { ApiKeySummary, UsageRange, UsageRecord, UsageResponse } from "../_lib/types";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../_components/page-states";
import { UsageTable } from "../_components/usage-table";
import { UsageFilters } from "./_components/usage-filters";

export default function UserUsagePage() {
  const [range, setRange] = useState<UsageRange>("7d");
  const [model, setModel] = useState<string | null>(null);
  const [apiKeyId, setApiKeyId] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [records, setRecords] = useState<readonly UsageRecord[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [keys, setKeys] = useState<readonly ApiKeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = { range, ...(model === null ? {} : { model }), ...(apiKeyId === null ? {} : { apiKeyId }) };

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchUsage(query);
      setUsage(page);
      setRecords(page.records.items);
      setCursor(page.records.nextCursor);
    } catch (caught) {
      if ((caught as { unauthenticated?: boolean }).unauthenticated === true) {
        redirectToLogin();
        return;
      }
      setError(messageOfError(caught));
    } finally {
      setLoading(false);
    }
    // query 由 range / model / apiKeyId 拼成，依赖这三个就够（避免对象身份变化导致重复请求）。
  }, [range, model, apiKeyId]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  useEffect(() => {
    void (async () => {
      try {
        setKeys(await fetchKeys());
      } catch {
        // 密钥列表只用于筛选下拉，取不到就退化成「全部密钥」，不打断页面。
        setKeys([]);
      }
    })();
  }, []);

  const loadMore = useCallback(async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchUsage({ ...query, cursor });
      setRecords((current) => [...current, ...page.records.items]);
      setCursor(page.records.nextCursor);
    } catch (caught) {
      toast.error(messageOfError(caught));
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, range, model, apiKeyId]);

  const exportCsv = useCallback(async () => {
    setExporting(true);
    try {
      await downloadUsageCsv(query);
      toast.success("已开始下载 CSV");
    } catch (caught) {
      toast.error(messageOfError(caught));
    } finally {
      setExporting(false);
    }
  }, [range, model, apiKeyId]);

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">用量明细</h1>
          <p className="text-sm text-muted-foreground">按请求逐条列出，所有日期按本地时区显示</p>
        </div>
      </div>

      <UsageFilters
        range={range}
        model={model}
        apiKeyId={apiKeyId}
        models={usage?.models ?? []}
        keys={keys}
        exporting={exporting}
        onRangeChange={setRange}
        onModelChange={setModel}
        onApiKeyChange={setApiKeyId}
        onExport={() => void exportCsv()}
      />

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>{RANGE_LABELS[range]}记录</CardTitle>
          <CardDescription>
            {usage === null
              ? "正在统计…"
              : `本期共 ${formatTokens(usage.totals.requests)} 次请求 · 合计 ${formatTokens(usage.totals.tokens)} token`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error === null ? null : <ErrorBlock message={error} onRetry={() => void loadFirstPage()} />}
          {loading ? <LoadingBlock rows={8} label="正在加载用量记录…" /> : null}
          {!loading && error === null ? (
            records.length === 0 ? (
              <EmptyBlock
                title="这个筛选条件下没有记录"
                description="换一个时间范围，或确认这段时间内确实调用过接口"
              />
            ) : (
              <div className="flex flex-col gap-3">
                <UsageTable records={records} emptyTitle="没有记录" />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">已加载 {records.length} 条</span>
                  {cursor === null ? (
                    <span className="text-xs text-muted-foreground">没有更多了</span>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
                      {loadingMore ? "加载中…" : "加载更多"}
                    </Button>
                  )}
                </div>
              </div>
            )
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
