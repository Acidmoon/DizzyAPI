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

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { UsagePie } from "@/components/usage-pie";
import { toast } from "sonner";

import { formatTokens } from "@/lib/format";

import {
  api,
  errorMessage,
  keys as keysApi,
  usage as usageApi,
  type ApiKeySummaryView,
  type UsageRowView,
  type UsageView,
} from "@/lib/api";

import { RANGE_LABELS, type UsageRange } from "../_lib/labels";
import { isUnauthenticated, redirectToLogin } from "../_lib/session";
import { downloadUsageCsv } from "../_lib/usage-download";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../_components/page-states";
import { UsageTable } from "../_components/usage-table";
import { UsageFilters } from "./_components/usage-filters";

export default function UserUsagePage() {
  const [range, setRange] = useState<UsageRange>("7d");
  const [model, setModel] = useState<string | null>(null);
  const [apiKeyId, setApiKeyId] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  /** 饼图专用的汇总：**只跟 range 走、不跟筛选走**，否则点了模型就只剩一个扇区。 */
  const [breakdown, setBreakdown] = useState<UsageView | null>(null);
  const [records, setRecords] = useState<readonly UsageRowView[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [keys, setKeys] = useState<readonly ApiKeySummaryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = { range, ...(model === null ? {} : { model }), ...(apiKeyId === null ? {} : { apiKeyId }) };

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await usageApi.fetchUsage(api, query);
      setUsage(page);
      setRecords(page.records.items);
      setCursor(page.records.nextCursor);
      // 没有筛选时，这一份就是全区间分布，饼图直接用它（省一次往返）。
      if (model === null && apiKeyId === null) setBreakdown(page);
    } catch (caught) {
      if (isUnauthenticated(caught)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
    // query 由 range / model / apiKeyId 拼成，依赖这三个就够（避免对象身份变化导致重复请求）。
  }, [range, model, apiKeyId]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  // 饼图要的是「整个区间」的分布，不能被「按模型筛选」自己收窄成一项
  // （否则点一下模型，饼图就只剩一个 100% 的扇区，看着像筛选坏了）。
  // 有筛选时才单独拉一次全区间分布；无筛选的情况由 `loadFirstPage` 顺手填好。
  useEffect(() => {
    if (model === null && apiKeyId === null) return;
    let alive = true;
    void (async () => {
      try {
        const page = await usageApi.fetchUsage(api, { range, limit: 1 });
        if (alive) setBreakdown(page);
      } catch {
        // 饼图是辅助信息：取不到就保留上一次的分布，不打断列表。
      }
    })();
    return () => {
      alive = false;
    };
  }, [range, model, apiKeyId]);

  const modelGroups = useMemo(
    () =>
      (breakdown?.models ?? []).map((row) => ({
        label: row.model,
        costMicros: row.costMicros,
        tokens: row.tokens,
        requests: row.requests,
        other: row.other === true,
      })),
    [breakdown],
  );

  const apiKeyGroups = useMemo(
    () =>
      (breakdown?.apiKeys ?? []).map((row) => ({
        label: row.apiKeyName,
        costMicros: row.costMicros,
        tokens: row.tokens,
        requests: row.requests,
        other: row.other === true,
      })),
    [breakdown],
  );

  /** 当前选中的 API key 在饼图里的展示名（空 id = 没筛）。 */
  const selectedKeyLabel = useMemo(() => {
    if (apiKeyId === null) return null;
    return (breakdown?.apiKeys ?? []).find((row) => row.apiKeyId === apiKeyId)?.apiKeyName ?? null;
  }, [apiKeyId, breakdown]);

  useEffect(() => {
    void (async () => {
      try {
        setKeys((await keysApi.listKeys(api)).items);
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
      const page = await usageApi.fetchUsage(api, { ...query, cursor });
      setRecords((current) => [...current, ...page.records.items]);
      setCursor(page.records.nextCursor);
    } catch (caught) {
      toast.error(errorMessage(caught));
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
      toast.error(errorMessage(caught));
    } finally {
      setExporting(false);
    }
  }, [range, model, apiKeyId]);

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">用量明细</h1>
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

      {/* 两张饼图：按模型 / 按接口（API key）。点扇区或图例即联动上面的筛选。 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <UsagePie
          title="按模型"
          description={`${RANGE_LABELS[range]} · 点一项按模型筛选`}
          measure="cost"
          groups={modelGroups}
          total={usage?.totals}
          selected={model}
          onSelect={(label) => setModel(label)}
          emptyText="本期还没有模型用量"
        />
        <UsagePie
          title="按接口"
          description={`${RANGE_LABELS[range]} · 按 API key 切分，点一项筛选`}
          measure="cost"
          groups={apiKeyGroups}
          total={usage?.totals}
          selected={selectedKeyLabel}
          onSelect={(label) => {
            const matched = (usage?.apiKeys ?? []).find((item) => item.apiKeyName === label);
            setApiKeyId(matched === undefined || matched.apiKeyId === "" ? null : matched.apiKeyId);
          }}
          emptyText="本期还没有接口用量"
        />
      </div>

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
