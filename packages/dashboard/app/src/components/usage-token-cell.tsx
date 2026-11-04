"use client";

/**
 * 用量 token 四桶（输入 / 输出 / 缓存读 / 缓存写）。
 *
 * 用户概览、用量明细、管理面明细共用这一份实现：四个桶的口径与配色只在这里定义一次，
 * 避免三个页面各写一套后数字对不上。金额不在这里渲染，仍由调用方走 `@/lib/format`。
 */
import { formatTokens } from "@/lib/format";

export interface UsageTokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface UsageTokenCellProps extends UsageTokenCounts {
  readonly className?: string;
  /** 可选：鼠标悬停时的补充说明（例如合计 token）。 */
  readonly title?: string;
}

export function UsageTokenCell({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  className,
  title,
}: UsageTokenCellProps) {
  return (
    <div className={`flex flex-col gap-0.5 text-xs leading-5 tabular-nums ${className ?? ""}`} title={title}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span>
          <span className="text-muted-foreground">输入</span>{" "}
          <span className="font-medium text-emerald-600 dark:text-emerald-400">{formatTokens(inputTokens)}</span>
        </span>
        <span>
          <span className="text-muted-foreground">输出</span>{" "}
          <span className="font-medium text-violet-600 dark:text-violet-400">{formatTokens(outputTokens)}</span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span>
          <span className="text-muted-foreground">缓存读</span>{" "}
          <span className="font-medium text-sky-600 dark:text-sky-400">{formatTokens(cacheReadTokens)}</span>
        </span>
        <span>
          <span className="text-muted-foreground">缓存写</span>{" "}
          <span className="font-medium text-amber-600 dark:text-amber-400">{formatTokens(cacheWriteTokens)}</span>
        </span>
      </div>
    </div>
  );
}
