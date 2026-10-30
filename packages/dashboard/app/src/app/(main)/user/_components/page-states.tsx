"use client";

/**
 * 三种页面状态：加载中 / 出错 / 空。**每页都要有这三种**（owner 的验收口径），
 * 所以做成共享件，不在页面里各写一遍「正在加载…」。
 *
 * 文案一律简体中文；错误只显示服务端给的 message + 重试按钮，不吞错误也不铺堆栈。
 */

import type { ReactNode } from "react";

import { AlertCircle, Inbox, RefreshCw } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

/** 加载态：给表格用的一行行骨架，`rows` 控制行数。 */
export function LoadingBlock({ rows = 4, label = "正在加载…" }: { rows?: number; label?: string }) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}

/** 出错态：`onRetry` 存在时给「重试」，否则只说明原因。 */
export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>没能取到数据</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
      {onRetry === undefined ? null : (
        <AlertAction>
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            重试
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}

/** 空态：说明「为什么这里是空的」，而不是什么都不显示。 */
export function EmptyBlock({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description === undefined ? null : <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children === undefined ? null : <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}
