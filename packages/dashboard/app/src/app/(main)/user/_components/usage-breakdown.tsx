"use client";

/**
 * 「按模型」消费构成：横向条 + 占比。
 *
 * 说明一件事实：`/api/usage` 的 `models` 只给**整个区间**的按模型汇总，没有「按模型的逐日序列」，
 * 所以这里做的是区间占比，不是按模型堆叠的 7 点柱状图。「按 API key 维度」同理缺聚合
 * （服务端没有按 key 分组），已作为缺口报给 `总工`，不在前端伪造。
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPercent, formatTokens, formatYuan } from "@/lib/format";
import type { UsageModelView } from "@/lib/api";

import { EmptyBlock } from "./page-states";

export interface UsageBreakdownProps {
  readonly models: readonly UsageModelView[];
  readonly rangeLabel: string;
}

export function UsageBreakdown({ models, rangeLabel }: UsageBreakdownProps) {
  if (models.length === 0) {
    return (
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>按模型</CardTitle>
          <CardDescription>{rangeLabel}</CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyBlock title="本期还没有按模型的数据" description="发一次请求后这里会出现模型维度" />
        </CardContent>
      </Card>
    );
  }

  const totalMicros = models.reduce((sum, row) => sum + safeMicros(row.costMicros), 0n);
  const rows = models.slice(0, 8);

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>按模型</CardTitle>
        <CardDescription>{rangeLabel}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {rows.map((row) => {
          const share = totalMicros === 0n ? 0 : Number((safeMicros(row.costMicros) * 10_000n) / totalMicros) / 100;
          return (
            <div key={row.model} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium" title={row.model}>
                  {row.model}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                  {formatYuan(row.costMicros)} · {formatPercent(share / 100)}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="presentation">
                <div className="h-full rounded-full bg-(--chart-1)" style={{ width: `${Math.max(share, 0.5)}%` }} />
              </div>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatTokens(row.requests)} 次请求 · {formatTokens(row.tokens)} token
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function safeMicros(value: string): bigint {
  return /^-?\d+$/.test(value) ? BigInt(value) : 0n;
}
