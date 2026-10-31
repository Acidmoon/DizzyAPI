"use client";

/**
 * 模型广场每行的**可用性小柱状图**（owner 要的那一列）。
 *
 * 纪律（与 `总工` 对齐的口径）：
 * 1. **4 级高度 + 颜色双编码**，最右是「现在」，左侧不足补灰占位；
 * 2. **不注入 `<style>`**：颜色是行内 `style` 里的 CSS 变量（走 `style-src-attr`），
 *    新前端 CSP 的 `style-src` 只放行两个 sha256，注入样式表会被拦；
 * 3. **不显示刻度**：窄屏只显示形状，靠 `title` 与读屏文案补细节 ——
 *    24 根柱子的刻度在 420px 下必然撑破表格；
 * 4. **空态给一句人话**，不是空白单元格；也**不把「没数据」画成红**（那就是假红）。
 *
 * 高度用百分比、轨道高度固定（`PROBE_BAR_TRACK_PX`）：这样柱高不依赖外部尺寸，
 * 不需要任何 JS 测量（也不会有布局抖动）。
 */

import type { CSSProperties } from "react";

import { formatDateTime } from "@/lib/format";
import type { ModelProbeView } from "@/lib/api";
import {
  PROBE_BAR_TRACK_PX,
  probeBars,
  probeSummaryText,
  type ProbeViewLike,
} from "@/lib/model-probe";

export interface ModelProbeBarsProps {
  /** 服务端给的探测视图；**没有这个键** = 这个模型没探过（不是挂了）。 */
  readonly probe?: ModelProbeView | undefined;
  /** 槽位数（页面按本页最多的模型算，保证各行左端对齐）。 */
  readonly slots: number;
}

/** 探测时刻（本地时区）。毫秒时间戳走 `@/lib/format` 的唯一格式化源。 */
function testedAtText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "时间未知";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return formatDateTime(date.toISOString());
}

export function ModelProbeBars({ probe, slots }: ModelProbeBarsProps) {
  if (probe === undefined || !probe.probed || probe.points.length === 0) {
    return <span className="text-xs text-muted-foreground">还没有探测数据</span>;
  }

  const view: ProbeViewLike = probe;
  const bars = probeBars(view.points, slots);
  const summary = probeSummaryText(view.points);
  const latest = view.points[0];
  const tooltip = latest === undefined ? summary : `${summary}（最近一次 ${testedAtText(latest.testedAtMs)}）`;

  return (
    <div className="flex items-end" style={{ height: PROBE_BAR_TRACK_PX }} title={tooltip} role="img" aria-label={tooltip}>
      {/* 轨道：`aria-hidden` —— 被读的是外面那一整句统计，不是一根根柱子。 */}
      <div aria-hidden className="flex h-full w-[118px] items-end gap-[2px]">
        {bars.map((bar) => {
          const style: CSSProperties = {
            height: `${bar.heightPercent}%`,
            backgroundColor: bar.color,
          };
          return (
            <span
              key={bar.key}
              data-probe-bar={bar.status ?? "empty"}
              className="w-[3px] shrink-0 rounded-[1px]"
              style={style}
            />
          );
        })}
      </div>
    </div>
  );
}
