"use client";

/**
 * 概览页的四张指标卡：本期消费 / 请求数 / Token 总量 / 账户余额。
 *
 * 金额一律走 `@/lib/format`（整数微元、无浮点）；余额未启用时显示「未启用」而不是 0 ——
 * 「后台没开余额」与「余额是 0」是两件事，显示成 0 会让用户以为钱被扣光了。
 */

import { Coins, Hash, Receipt, Waves } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCentsAsYuan, formatTokens, formatYuan } from "@/lib/format";

import type { UsageTotals } from "../_lib/types";

interface MetricCardProps {
  icon: typeof Coins;
  title: string;
  value: string;
  hint: string;
  badge?: string;
}

function MetricCard({ icon: Icon, title, value, hint, badge }: MetricCardProps) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          <div className="flex size-7 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
            <Icon className="size-4" />
          </div>
        </CardTitle>
        <CardDescription>{title}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-2xl leading-none font-medium tracking-tight tabular-nums">{value}</div>
          {badge === undefined ? null : <Badge variant="secondary">{badge}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

export interface UsageMetricsProps {
  readonly totals: UsageTotals;
  readonly rangeLabel: string;
  /** `null` = 后台没开余额（不是 0）。 */
  readonly balanceCents: number | null;
}

export function UsageMetrics({ totals, rangeLabel, balanceCents }: UsageMetricsProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        icon={Receipt}
        title={`${rangeLabel}消费`}
        value={formatYuan(totals.costMicros)}
        hint={`${formatTokens(totals.requests)} 次请求的合计金额`}
      />
      <MetricCard
        icon={Hash}
        title={`${rangeLabel}请求数`}
        value={formatTokens(totals.requests)}
        hint="含失败请求（失败也计数，金额为 0）"
      />
      <MetricCard
        icon={Waves}
        title={`${rangeLabel}Token 总量`}
        value={formatTokens(totals.tokens)}
        hint={`输入 ${formatTokens(totals.inputTokens)} · 输出 ${formatTokens(totals.outputTokens)}`}
      />
      <MetricCard
        icon={Coins}
        title="账户余额"
        value={balanceCents === null ? "未启用" : `${formatCentsAsYuan(balanceCents)} 元`}
        hint={balanceCents === null ? "管理员关闭了余额显示" : "余额为负表示后付费欠费"}
      />
    </div>
  );
}
