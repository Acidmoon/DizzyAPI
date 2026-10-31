"use client";

/**
 * 日期范围选择（自研，不碰浏览器默认控件）。
 *
 * 为什么不用原生 `<input type="date">`：原生日期输入的浮层由**浏览器**绘制，
 * CSS 碰不到它，深色主题下会是一块白板；owner 明确要求「弹窗与悬浮提示不用
 * 浏览器默认的」。所以这里用 `Popover` + `Calendar`（react-day-picker）自绘。
 *
 * 两条纪律：
 * - **只出 `YYYY-MM-DD`**，不带时区。审计接口要的是毫秒时间戳，由调用方换算
 *   （`dateRangeMs` 在 `admin-logic.ts` 里，纯函数、可单测）。
 * - 结束日期是**含当天**：传 `2026-10-31` 意思是「10-31 那天也要」，所以换算成
 *   毫秒时右端要 +1 天（半开区间 `[from, to)`）。
 */
import { useState } from "react";

import { CalendarIcon } from "lucide-react";
import { zhCN } from "date-fns/locale";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** 把 `Date` 转成 `YYYY-MM-DD`（本地时区，不用 `toISOString`——那是 UTC，会差一天）。 */
function localDateText(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(year)}-${month}-${day}`;
}

/** 把 `YYYY-MM-DD` 解析成**本地时区**的当天零点。 */
function parseLocalDate(text: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  // `new Date(2026, 1, 30)` 会滚到 3 月 2 日；这里要的是「这个日子不存在就判非法」。
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

export interface DateRangeValue {
  /** 起始日（`YYYY-MM-DD`）；空串 = 不限。 */
  readonly from: string;
  /** 结束日（`YYYY-MM-DD`，**含当天**）；空串 = 不限。 */
  readonly to: string;
}

/**
 * 一个日期范围选择器（起 / 止两个日期）。
 *
 * `value` 是受控的；`onChange` 在用户选完一个日期时立刻触发，页面据此重新取数。
 */
export function DateRangePicker({
  value,
  onChange,
  label,
}: {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const from = parseLocalDate(value.from);
  const to = parseLocalDate(value.to);

  function text(): string {
    if (value.from === "" && value.to === "") return "不限";
    if (value.from === "") return `起 ${value.to}`;
    if (value.to === "") return `${value.from} 起`;
    return `${value.from} ~ ${value.to}`;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-52 justify-start" aria-label={label}>
          <CalendarIcon />
          {text()}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex flex-col gap-2 p-2">
          <div className="flex flex-wrap items-center gap-2 px-1">
            <span className="text-xs text-muted-foreground">起</span>
            <input
              type="text"
              value={value.from}
              onChange={(event) => onChange({ ...value, from: event.target.value })}
              placeholder="YYYY-MM-DD"
              aria-label="起始日期"
              className="w-28 rounded-md border bg-background px-2 py-1 font-mono text-xs"
            />
            <span className="text-xs text-muted-foreground">止</span>
            <input
              type="text"
              value={value.to}
              onChange={(event) => onChange({ ...value, to: event.target.value })}
              placeholder="YYYY-MM-DD"
              aria-label="结束日期"
              className="w-28 rounded-md border bg-background px-2 py-1 font-mono text-xs"
            />
          </div>
          <Calendar
            mode="range"
            locale={zhCN}
            numberOfMonths={1}
            selected={{ from: from ?? undefined, to: to ?? undefined }}
            onSelect={(range) => {
              const nextFrom = range?.from === undefined ? "" : localDateText(range.from);
              const nextTo = range?.to === undefined ? "" : localDateText(range.to);
              onChange({ from: nextFrom, to: nextTo });
              if (nextFrom !== "" && nextTo !== "") setOpen(false);
            }}
          />
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-xs text-muted-foreground">
              {value.from === "" && value.to === ""
                ? "当前不限时间范围"
                : `${value.from || "不限"} ~ ${value.to || "不限"}（含当天）`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange({ from: "", to: "" });
                setOpen(false);
              }}
            >
              清空
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 日期范围 → 毫秒区间（**半开区间** `[from, to)`，结束日含当天）。
 *
 * 纯函数放 `admin-logic.ts`（那里才有单测）；这里只留渲染。
 *
 * 注意口径：结束日 `2026-10-31` 要覆盖到当天 23:59:59.999，
 * 所以右端是「当天零点 + 1 天」，**左闭右开**——`to` 传 0 表示不限。
 */
