"use client";

/**
 * 连通性测试**详情弹窗**（管理员）。
 *
 * owner 2026-11-01 要求：测试不能只弹一句 toast，要能看到「探测用的提示词（Hi）」和
 * 「上游返回了什么」；200 就展示正文，非 200 就展示具体的报错。
 *
 * 接口：`POST /api/accounts/:id/test`。返回里有两块**只在本次响应存在**的详情
 * （不持久化、刷新列表就没了，所以详情只能在这个弹窗里看）：
 * - `request`：实际发出去的提示词 / 模型 / 协议 / 端点（端点已去 query）；
 * - `response`：上游响应片段（截断 2000 字符、疑似密钥已由服务端打码）。
 *
 * 三条显示纪律：
 * - **不自己拼展示数据**：提示词、端点、正文全部原样来自服务端，前端不硬编码「Hi」；
 * - **失败先说结论**：顶部是「失败 + HTTP 状态 + 耗时」，稳定 code 与人话摘要紧跟其后，
 *   正文片段放最后 —— 排查时先看结论，再看证据；
 * - **长正文不撑爆弹窗**：`pre` 用 `max-h` + `overflow-auto` 滚动，保留换行。
 */
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, adminUsers, ApiError, type AccountViewLike } from "@/lib/api";
import { formatDurationMs } from "@/lib/format";

/** 测试结果的类型直接取自端点函数，避免在页面里再声明一份同形类型。 */
type TestResult = Awaited<ReturnType<typeof adminUsers.testAccount>>;

/** 一个标签 + 一段等宽正文的小块（请求与响应共用）。 */
function PreBlock({ label, text, emptyHint }: { label: string; text: string; emptyHint: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <pre className="max-h-56 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all">
        {text === "" ? emptyHint : text}
      </pre>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs break-all">{value}</span>
    </div>
  );
}

export function AccountTestDialog({
  account,
  onClose,
  onRan,
}: {
  account: AccountViewLike;
  onClose: () => void;
  onRan: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = useCallback(async (): Promise<void> => {
    setRunning(true);
    setFailure(null);
    try {
      const outcome = await adminUsers.testAccount(api, account.id);
      setResult(outcome);
      // 服务端会把 lastTest* 落库，测完刷新列表才能看到「最近测试」列变化。
      onRan();
    } catch (cause) {
      setResult(null);
      setFailure(
        cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "测试请求本身失败了",
      );
    } finally {
      setRunning(false);
    }
  }, [account.id, onRan]);

  // 打开即测：管理员点「测试」要的是结果，不是再点一次「开始」。
  useEffect(() => {
    void run();
  }, [run]);

  const ok = result?.ok === true;
  const status = result?.status ?? null;
  const response = result?.response ?? null;
  const request = result?.request ?? null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>连通性测试</DialogTitle>
          <DialogDescription>
            {account.label} · #{account.id}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {result === null ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={
                  ok
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : "bg-destructive/15 text-destructive"
                }
              >
                {ok ? "通过" : "失败"}
              </Badge>
              <span className="text-sm tabular-nums">
                {status === null ? "未拿到 HTTP 响应" : `HTTP ${String(status)}`}
              </span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {formatDurationMs(result.latencyMs)}
              </span>
            </div>
          )}

          {running && result === null ? (
            <p className="text-sm text-muted-foreground">正在发一条最小真实请求…</p>
          ) : null}

          {failure === null ? null : <p className="text-xs text-destructive">{failure}</p>}

          {result?.error === null || result === null ? null : (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {result.error}
            </div>
          )}

          {request === null ? null : (
            <div className="grid gap-3">
              <div className="text-xs font-medium tracking-wide text-muted-foreground">请求</div>
              <PreBlock
                label="提示词"
                text={request.prompt ?? ""}
                emptyHint="—（这次只查了模型列表，没有提示词）"
              />
              <div className="grid gap-2 sm:grid-cols-3">
                <Field label="模型" value={request.model ?? "—（未指定）"} />
                <Field label="协议" value={request.protocol === "" ? "—" : request.protocol} />
                <Field label="端点" value={request.endpoint === "" ? "—" : request.endpoint} />
              </div>
            </div>
          )}

          {response === null ? null : (
            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium tracking-wide text-muted-foreground">响应</div>
                {response.truncated ? (
                  <span className="text-xs text-muted-foreground">已截断（只显示前 2000 字符）</span>
                ) : null}
              </div>
              <PreBlock label={`HTTP ${String(response.status)}`} text={response.bodySnippet} emptyHint="（响应体为空）" />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          <Button onClick={() => void run()} disabled={running}>
            {running ? "测试中…" : result === null ? "开始测试" : "再测一次"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
