"use client";

/**
 * 模型广场每行的**可用性小柱状图**（owner 要的那一列）。
 *
 * 纪律（与 `总工` 对齐的口径）：
 * 1. **三层编码**：高度（健康序）→ **形态**（实心 / 空心描边）→ **状态色**（绿 / 琥珀 / 红）；
 *    最右是「现在」，左侧不足补灰占位。**形态这一层是 2026-10-31 真机验收加的**：
 *    只靠颜色的话，灰阶主题下「探测自身异常」白底对比度 1.3:1，等于没画；
 * 2. **状态色用语义绿 / 琥珀 / 红，不许借用 `--chart-N`**（那是分类色，默认主题里是灰阶，
 *    owner 2026-11-01 直接提过「测试通过也是灰的，看不出好坏」）；
 * 3. **不注入 `<style>`**：颜色是 Tailwind 类、行内 `style` 只留高度；
 *    新前端 CSP 的 `style-src` 只放行两个 sha256，注入样式表会被拦；
 * 4. **不显示刻度**：窄屏只显示形状，靠 `title` 与读屏文案补细节 ——
 *    24 根柱子的刻度在 420px 下必然撑破表格；
 * 5. **空态给一句人话**，不是空白单元格；也**不把「没数据」画成红**（那就是假红）。
 *
 * 高度用百分比、轨道高度固定（`PROBE_BAR_TRACK_PX`）：这样柱高不依赖外部尺寸，
 * 不需要任何 JS 测量（也不会有布局抖动）。
 */

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
        {bars.map((bar) => (
          /**
           * 颜色 / 描边全部走 **Tailwind 类**（`bar.tone`），行内样式只留高度：
           * - 状态色要随深浅主题换档（`bg-emerald-600 dark:bg-emerald-500`），行内样式做不到；
           * - 也满足 CSP：不注入 `<style>`，不使用被 `style-src` 拦掉的写法。
           *
           * **形态是编码的一部分，别当装饰删掉**：`hollow`（只描边不填充）专门表示
           * 「这次探测自己没测出结论」（`probe-error`），而 `probe-error` **不给任何状态色**
           * —— 绿 / 琥珀 / 红都表示「测出来了，结论是这个」，给彩色等于把「不知道」画成「有结论」。
           */
          <span
            key={bar.key}
            data-probe-bar={bar.status ?? "empty"}
            data-probe-shape={bar.shape}
            className={`w-[3px] shrink-0 rounded-[1px] ${bar.tone}`}
            style={{ height: `${bar.heightPercent}%` }}
          />
        ))}
      </div>
    </div>
  );
}
