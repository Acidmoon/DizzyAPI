"use client";

/**
 * 用量饼图（用户页与管理页共用）：**按模型 / 按接口 / 按用户**三个维度各一张。
 *
 * 三条纪律：
 * 1. **配色只走 `--chart-N` CSS 变量**（随主题变），**不注入 `<style>` 元素**——
 *    新前端的 CSP 是 `style-src 'self' + 两个 sha256`，注入的自定义 CSS 会被拦掉。
 *    recharts 的 `fill` 直接吃 CSS 变量，不需要 `<style>`。
 * 2. **占比与金额都由 `@/lib/usage-pie` 算**（整数微元，不经浮点）。
 * 3. **空数据画空态，不画空圆**：0 条时给一句「本期没有数据」，不是一片空白。
 *
 * 交互：扇区 hover 有原生 SVG `<title>`（无脚本兜底）+ recharts 的 tooltip；
 * 点击扇区可回调 `onSelect`（与页面筛选联动），是否联动由调用方决定。
 */

import { useMemo } from "react";

import { Cell, Pie, PieChart } from "recharts";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { formatMicrosAsYuan, formatTokens } from "@/lib/format";
import { isSelectable, toPieSlices, shareText, type PieGroup, type PieMeasure, type PieTotal } from "@/lib/usage-pie";

export interface UsagePieProps {
  /** 卡片标题（「按模型」/「按接口」/「按用户」）。 */
  readonly title: string;
  /** 卡标题下的一句说明（时间窗口等）。 */
  readonly description?: string;
  /** 分组数据（服务端已按费用降序、尾部归并成「其他」）。 */
  readonly groups: readonly PieGroup[];
  /** 占比口径，默认按费用（owner 关心的是花了多少钱）。 */
  readonly measure?: PieMeasure;
  /** 占比分母（服务端 totals —— 只要 `costMicros` / `tokens`，没有 `label`），不传则用列表之和。 */
  readonly total?: PieTotal;
  /** 点某个扇区（`null` = 点空白取消）；不传则不联动。 */
  readonly onSelect?: (label: string | null) => void;
  /** 当前筛选值（高亮对应扇区）。 */
  readonly selected?: string | null;
  /** 空态文案。 */
  readonly emptyText?: string;
}

const chartConfig = {
  share: { label: "占比" },
} satisfies ChartConfig;

/** 占比与绝对值的人话文案（图例与 tooltip 共用，避免两处漂）。 */
function valueTextOf(group: { costMicros: string; tokens: number }, measure: PieMeasure): string {
  return measure === "cost"
    ? `${formatMicrosAsYuan(group.costMicros)} 元`
    : `${formatTokens(group.tokens)} token`;
}

export function UsagePie({
  title,
  description,
  groups,
  measure = "cost",
  total,
  onSelect,
  selected = null,
  emptyText = "本期没有可统计的数据",
}: UsagePieProps) {
  const slices = useMemo(() => toPieSlices(groups, measure, total), [groups, measure, total]);

  const data = useMemo(
    () =>
      slices.map((slice) => ({
        name: slice.label,
        value: measure === "cost" ? Number(slice.share) : slice.tokens,
        share: slice.share,
        valueText: valueTextOf(slice, measure),
        fill: slice.color,
        other: slice.other,
      })),
    [slices, measure],
  );

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description === undefined ? null : <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="min-w-0">
        {slices.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <ChartContainer config={chartConfig} className="mx-auto aspect-square h-48 w-48 shrink-0">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="45%"
                  outerRadius="78%"
                  paddingAngle={1}
                  isAnimationActive={false}
                  onClick={(entry: unknown) => {
                    if (onSelect === undefined) return;
                    const picked = entry as { name?: string; payload?: { other?: boolean } } | undefined;
                    // 「其他」是归并项，不对应任何可筛选的真实值（模型名 / key id / 用户 id）。
                    if (picked === undefined || picked.payload === undefined) return;
                    if (!isSelectable(picked.payload)) return;
                    const label = picked.name;
                    onSelect(label === undefined || label === selected ? null : label);
                  }}
                >
                  {data.map((item) => (
                    <Cell
                      key={item.name}
                      fill={item.fill}
                      stroke={item.name === selected ? "var(--foreground)" : "transparent"}
                      strokeWidth={item.name === selected ? 2 : 1}
                    />
                  ))}
                </Pie>
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      hideLabel
                      formatter={(_value, name, item) => {
                        const payload = item.payload as { share: number; valueText: string } | undefined;
                        return (
                          <span className="flex flex-col gap-0.5 text-xs">
                            <span className="font-medium text-foreground">{String(name)}</span>
                            <span className="text-muted-foreground tabular-nums">
                              {shareText(payload?.share ?? 0)} · {payload?.valueText ?? ""}
                            </span>
                          </span>
                        );
                      }}
                    />
                  }
                />
              </PieChart>
            </ChartContainer>

            {/* 图例：名字 · 占比 · 绝对值。它是可点的（有 onSelect 时），所以用 button 而不是 li。 */}
            <ul className="flex min-w-0 flex-1 flex-col gap-1">
              {slices.map((slice) => {
                const active = slice.label === selected;
                const label = `${slice.label} · ${shareText(slice.share)} · ${valueTextOf(slice, measure)}`;
                return (
                  <li key={slice.label} className="min-w-0">
                    {onSelect === undefined || !isSelectable(slice) ? (
                      <span className="flex min-w-0 items-center gap-2 text-xs" data-pie-legend={slice.label}>
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-[2px]"
                          style={{ backgroundColor: slice.color }}
                        />
                        <span className="line-clamp-2 break-words">{label}</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-pressed={active}
                        data-pie-legend={slice.label}
                        className={`flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-muted ${
                          active ? "bg-muted font-medium" : ""
                        }`}
                        onClick={() => onSelect(active ? null : slice.label)}
                      >
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-[2px]"
                          style={{ backgroundColor: slice.color }}
                        />
                        <span className="line-clamp-2 break-words">{label}</span>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
