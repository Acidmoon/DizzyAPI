"use client";

/**
 * 用户概览 `/user`：指标卡 + 消费趋势（恒 7 点）+ 按模型 + 最近 10 条请求。
 *
 * 「最近 10 条」是 owner 的明确口径（旧 `web` 页面是 20 条，改版时要求只留 10 条）。
 * 完整列表在 `/user/usage`（明细页，带筛选与分页）。
 */

import { useCallback, useEffect, useState } from "react";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { api, auth, errorMessage, usage as usageApi, type SessionView, type UsageView } from "@/lib/api";

import { RANGE_LABELS, rangeLabel, type UsageRange } from "./_lib/labels";
import { isUnauthenticated, redirectToLogin } from "./_lib/session";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "./_components/page-states";
import { UsageBreakdown } from "./_components/usage-breakdown";
import { UsageChart } from "./_components/usage-chart";
import { UsageMetrics } from "./_components/usage-metrics";
import { UsageTable } from "./_components/usage-table";

/** 概览页只给最近 10 条（口径固定，不是可调参数）。 */
const RECENT_LIMIT = 10;

export default function UserOverviewPage() {
  const [range, setRange] = useState<UsageRange>("7d");
  const [session, setSession] = useState<SessionView | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSession, nextUsage] = await Promise.all([
        auth.fetchSession(api),
        usageApi.fetchUsage(api, { range, limit: RECENT_LIMIT }),
      ]);
      setSession(nextSession);
      setUsage(nextUsage);
    } catch (caught) {
      if (isUnauthenticated(caught)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  const recent = usage?.records.items.slice(0, RECENT_LIMIT) ?? [];

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">概览</h1>
          <p className="text-sm text-muted-foreground">
            {session === null ? "正在读取账户…" : `${session.user.name} · 所有日期按本地时区显示`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={range} onValueChange={(value) => setRange(value as UsageRange)}>
            <SelectTrigger size="sm" className="w-32" aria-label="选择时间范围">
              <SelectValue placeholder={RANGE_LABELS[range]} />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(RANGE_LABELS) as UsageRange[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {RANGE_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button asChild size="sm" variant="outline">
            <Link href="/user/usage">用量明细</Link>
          </Button>
        </div>
      </div>

      {error === null ? null : <ErrorBlock message={error} onRetry={() => setReload((value) => value + 1)} />}

      {loading && usage === null ? (
        <Card className="min-w-0 overflow-hidden">
          <CardContent className="pt-6">
            <LoadingBlock rows={6} />
          </CardContent>
        </Card>
      ) : null}

      {usage === null ? null : (
        <>
          <UsageMetrics
            totals={usage.totals}
            rangeLabel={rangeLabel(usage.range)}
            balanceCents={session?.user.balanceCents ?? null}
          />
          <UsageChart daily={usage.daily} rangeLabel={rangeLabel(usage.range)} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <UsageBreakdown models={usage.models} rangeLabel={rangeLabel(usage.range)} />
            <Card className="min-w-0 overflow-hidden">
              <CardHeader>
                <CardTitle>最近请求</CardTitle>
                <CardDescription>只看最近 {RECENT_LIMIT} 条，完整记录请进用量明细</CardDescription>
              </CardHeader>
              <CardContent>
                {recent.length === 0 ? (
                  <EmptyBlock title="还没有请求记录" description="用 API 密钥发一次请求后，这里会出现记录" />
                ) : (
                  <UsageTable records={recent} emptyTitle="还没有请求记录" compact />
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
