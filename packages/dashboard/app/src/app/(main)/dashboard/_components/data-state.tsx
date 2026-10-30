"use client";

/**
 * 管理面页面的三态渲染原语（加载 / 无权限 / 出错 / 空）。
 *
 * 为什么要统一：13 个管理页如果各写一套骨架与空态，文案与视觉会逐渐漂，
 * 而且「加载中」和「空列表」的区别很容易被写丢（空列表被当成加载中就是白屏）。
 *
 * 纪律：
 * - **无权限不渲染空白**：403 明确说「需要管理员权限」，不是「没有数据」。
 * - **401 与 403 分开**：401 是没登录（该跳登录页），403 是登录了但不是管理员。
 * - 空态用 `Empty` 组件，加载态用 `Skeleton`，两者视觉上必须能区分。
 */
import type { ReactNode } from "react";

import { AlertTriangle, ShieldX } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { ApiError } from "@/lib/api";

/** 出错的统一呈现：401 / 403 有专门文案，其余给 code + 重试。 */
export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  if (error.isForbidden) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldX />
          </EmptyMedia>
          <EmptyTitle>需要管理员权限</EmptyTitle>
          <EmptyDescription>
            这个页面只有管理员能看。如果你认为自己应该是管理员，请联系站点管理员调整角色。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (error.isUnauthorized) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldX />
          </EmptyMedia>
          <EmptyTitle>登录状态已失效</EmptyTitle>
          <EmptyDescription>请重新登录后再回到这个页面。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>加载失败</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>
          {error.message}（<code className="font-mono text-xs">{error.code}</code>）
        </span>
        {onRetry === undefined ? null : (
          <Button variant="outline" size="sm" className="w-fit" onClick={onRetry}>
            重试
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** 加载态：一块卡片骨架（不写死行数，免得空表时抖）。 */
export function LoadingState({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
      <span className="sr-only">正在加载…</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

/** 空态：明确说「没有数据」，与加载态区分。 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description === undefined ? null : <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action === undefined ? null : action}
    </Empty>
  );
}

/**
 * 三态统一入口：`loading` → 骨架、`error` → 错误、`empty` → 空态、否则渲染内容。
 *
 * 顺序是**刻意**的：先 loading（有旧数据时也不闪空态），再 error，最后 empty。
 */
export function DataState({
  loading,
  error,
  empty,
  onRetry,
  emptyTitle,
  emptyDescription,
  children,
}: {
  loading: boolean;
  error: ApiError | null;
  empty: boolean;
  onRetry?: () => void;
  emptyTitle: string;
  emptyDescription?: string;
  children: ReactNode;
}) {
  if (loading) return <LoadingState />;
  if (error !== null) return <ErrorState error={error} onRetry={onRetry} />;
  if (empty) return <EmptyState title={emptyTitle} description={emptyDescription} />;
  return <>{children}</>;
}
