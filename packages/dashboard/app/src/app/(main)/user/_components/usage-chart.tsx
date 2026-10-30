"use client";

/**
 * 消费柱状图：**恒定 7 个时间点**（`toSevenPoints`），空桶补 0、X 轴标签照留。
 *
 * 口径来自 owner 对用量页的明确要求（旧 `web` 插件也是这个口径）：柱子数量不随区间变，
 * 7 天 / 30 天 / 90 天都是 7 根柱、7 个刻度；否则同一块区域里柱子的密度会跳变。
 *
 * 为什么用 recharts（`components/ui/chart.tsx` 的 ChartContainer）而不是手写 SVG：
 * 新的前端是上游模板（MIT）自带的图表栈，owner 说「直接用现成的、不要复刻」。
 */

import { useMemo } from "react";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { formatAxisLabel } from "@/lib/format";

import { costMicrosToChartNumber, hasData, toSevenPoints, type DailyPointLike } from "../_lib/seven-points";

const chartConfig = {
  cost: {
    label: "消费（元）",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

export interface UsageChartProps {
  readonly daily: readonly DailyPointLike[];
  readonly rangeLabel: string;
}

export function UsageChart({ daily, rangeLabel }: UsageChartProps) {
  const buckets = useMemo(() => toSevenPoints(daily), [daily]);
  const data = useMemo(
    () =>
      buckets.map((bucket) => ({
        label: formatAxisLabel(bucket.date),
        cost: costMicrosToChartNumber(bucket.costMicros),
        requests: bucket.requests,
        empty: !hasData(bucket),
      })),
    [buckets],
  );
  const hasAnyData = buckets.some((bucket) => hasData(bucket));

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>消费趋势</CardTitle>
        <CardDescription>
          {rangeLabel} · 恒定 7 个时间点，没有数据的时间点计 0
          {hasAnyData ? "" : "（本期还没有任何请求）"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-64 w-full"
          role="img"
          aria-label={`${rangeLabel}消费柱状图，共 7 个时间点`}
        >
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} strokeOpacity={0.5} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval={0} />
            <YAxis tickLine={false} axisLine={false} width={56} tickMargin={4} />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent indicator="line" hideLabel={false} />}
            />
            <Bar dataKey="cost" fill="var(--color-cost)" radius={[4, 4, 0, 0]} maxBarSize={64} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
