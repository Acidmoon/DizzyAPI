"use client";

/**
 * 运维总览（`/dashboard/observability`）：一屏看六块链路事实 + 异常摘要。
 *
 * 接口：`GET /api/admin/observability` → `ObservabilityReport`（服务端直接透传）。
 *
 * 六条纪律：
 * - **每块都带自己的健康度**（`ok` / `degraded` / `unavailable` + 人话原因）：
 *   一个源缺席**只降级那一块**，接口照常 200。所以页面不能因为一块不可用就整页报错。
 * - **告警码是稳定英文码**，页面给中文标签但保留原码（运维要按码查）。
 * - **金额是十进制字符串**（整数微元），页面只格式化，不做浮点。
 * - **这里没有账号 id / label / baseUrl**，也不该有——这是全站聚合视图。
 * - **「今天」按 UTC 的请求发生日**分桶，不是滚动 24 小时；页面要写清口径。
 */
import { useCallback, useState } from "react";

import { AlertTriangle, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, adminOps, type AdminObservabilityView, type SourceHealthView } from "@/lib/api";
import { formatDateTime, formatDurationMs, formatMicrosAsYuan, formatTokens } from "@/lib/format";

import { sourceHealthLabel, warningLabel } from "./admin-logic";
import { DataState } from "./data-state";
import { useResource } from "./use-resource";

/** 数据源健康度的徽标：正常 / 降级 / 不可用三种视觉必须能一眼分开。 */
function HealthBadge({ health }: { health: SourceHealthView | undefined }) {
  if (health === undefined) return null;
  const state = health.state;
  const tone =
    state === "ok"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : state === "degraded"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : "bg-destructive/15 text-destructive";
  return (
    <Badge variant="outline" className={tone}>
      {sourceHealthLabel(state)}
    </Badge>
  );
}

/** 一块数据的标题 + 健康度 + 说明。`hint` 可选：它只是口径解释，删掉不影响读数。 */
function BlockHeader({
  title,
  health,
  hint,
}: {
  title: string;
  health: SourceHealthView | undefined;
  hint?: string;
}) {
  return (
    <CardHeader>
      <div className="flex items-center justify-between gap-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <HealthBadge health={health} />
      </div>
      <CardDescription>
        {hint === undefined ? null : hint}
        {health !== undefined && health.detail !== "" ? ` · ${health.detail}` : ""}
      </CardDescription>
    </CardHeader>
  );
}

/** 一个「标签 / 数值」小行。 */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b py-1.5 last:border-b-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm tabular-nums">{value}</span>
    </div>
  );
}

export function ObservabilityBoard() {
  const [nonce, setNonce] = useState(0);

  const load = useCallback(() => {
    void nonce;
    return adminOps.fetchObservability(api);
  }, [nonce]);
  const { data, error, loading, reload } = useResource(load);

  const report: AdminObservabilityView | null = data ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">运维总览</h1>
                  </div>
        <Button variant="outline" onClick={reload}>
          <RefreshCw /> 刷新
        </Button>
      </div>

      <DataState
        loading={loading}
        error={error}
        empty={report === null}
        onRetry={reload}
        emptyTitle="没有拿到运维报告"
        emptyDescription="聚合服务不在运行时会返回 503（OBSERVABILITY_UNAVAILABLE）。"
      >
        {report === null ? null : (
          <>
            {report.degraded ? (
              <Card className="border-amber-500/40 bg-amber-500/5">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="size-4 text-amber-600" />
                    <CardTitle className="text-base">部分数据源不完整</CardTitle>
                  </div>
                </CardHeader>
              </Card>
            ) : null}

            {report.warnings.length === 0 ? null : (
              <Card className="border-destructive/40">
                <CardHeader>
                  <CardTitle className="text-base">异常摘要（{report.warnings.length}）</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="flex flex-col gap-1.5">
                    {report.warnings.map((code) => (
                      <li key={code} className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge variant="outline" className="bg-destructive/15 text-destructive">
                          {code}
                        </Badge>
                        <span className="text-muted-foreground">{warningLabel(code)}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <BlockHeader
                  title="用量链路"
                  health={report.usage.health}
                          />
                <CardContent>
                  {report.usage.service === null ? (
                    <p className="text-sm text-muted-foreground">用量服务不在运行，读不到轮询状态。</p>
                  ) : (
                    <div className="flex flex-col">
                      <Metric label="已落库记录" value={formatTokens(report.usage.service.records)} />
                      <Metric
                        label="轮询中"
                        value={report.usage.service.polling ? "是" : "否"}
                      />
                      <Metric
                        label="连续失败"
                        value={formatTokens(report.usage.service.consecutiveFailures)}
                      />
                      <Metric label="缺口记录" value={formatTokens(report.usage.service.gapRecords)} />
                      <Metric
                        label="隔离区（待处理 / 总）"
                        value={`${formatTokens(report.usage.service.rejectedPending)} / ${formatTokens(report.usage.service.rejectedCount)}`}
                      />
                      <Metric
                        label="价目表可用"
                        value={report.usage.service.pricingAvailable ? "是" : "否"}
                      />
                      {report.usage.gateway === null ? null : (
                        <>
                          <Metric
                            label="Go 缓冲（容量 / 占用）"
                            value={`${formatTokens(report.usage.gateway.capacity)} / ${formatTokens(report.usage.gateway.size)}`}
                          />
                          <Metric
                            label="Go 缓冲丢失 / 缺口"
                            value={`${formatTokens(report.usage.gateway.dropped)} / ${formatTokens(report.usage.gateway.gap)}`}
                          />
                        </>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <BlockHeader
                  title="结算"
                  health={report.billing.health}
                          />
                <CardContent>
                  {report.billing.totals === null ? (
                    <p className="text-sm text-muted-foreground">结算服务不在运行，读不到状态计数。</p>
                  ) : (
                    <div className="flex flex-col">
                      <Metric
                        label="累计扣费"
                        value={`${formatMicrosAsYuan(report.billing.chargedMicros)} 元`}
                      />
                      <Metric label="已结算" value={formatTokens(report.billing.totals.settled)} />
                      <Metric label="待结算" value={formatTokens(report.billing.totals.pending)} />
                      <Metric label="结算中" value={formatTokens(report.billing.totals.settling)} />
                      <Metric label="无价格" value={formatTokens(report.billing.totals.noPrice)} />
                      <Metric label="无用户" value={formatTokens(report.billing.totals.noUser)} />
                      <Metric label="失败" value={formatTokens(report.billing.totals.failed)} />
                      <Metric label="待核查" value={formatTokens(report.billing.totals.review)} />
                      <Metric label="透支" value={formatTokens(report.billing.totals.overdrawn)} />
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <BlockHeader
                  title="额度快照"
                  health={report.quota.health}
                          />
                <CardContent>
                  <div className="flex flex-col">
                    <Metric
                      label="就绪"
                      value={report.quota.ready === null ? "—" : report.quota.ready ? "是" : "否"}
                    />
                    <Metric
                      label="快照年龄"
                      value={report.quota.ageMs === null ? "—" : formatDurationMs(report.quota.ageMs)}
                    />
                    <Metric
                      label="TTL"
                      value={report.quota.ttlMs === null ? "—" : formatDurationMs(report.quota.ttlMs)}
                    />
                    <Metric
                      label="过期"
                      value={report.quota.stale === null ? "—" : report.quota.stale ? "是" : "否"}
                    />
                    <Metric label="条目数" value={formatTokens(report.quota.size ?? 0)} />
                    <Metric label="代次" value={report.quota.generation === null ? "—" : String(report.quota.generation)} />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <BlockHeader
                  title="账号运行时"
                  health={report.runtime.health}
                          />
                <CardContent>
                  <div className="flex flex-col">
                    <Metric
                      label="在途请求"
                      value={report.runtime.active === null ? "—" : formatTokens(report.runtime.active)}
                    />
                    <Metric
                      label="冷却中账号"
                      value={report.runtime.cooling === null ? "—" : formatTokens(report.runtime.cooling)}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <BlockHeader
                  title="审计"
                  health={report.audit.health}
                          />
                <CardContent>
                  <div className="flex flex-col">
                    <Metric label="记录总数" value={formatTokens(report.audit.total)} />
                    <Metric label="失败操作" value={formatTokens(report.audit.failed)} />
                    <Metric label="最近一条" value={formatDateTime(report.audit.lastAt)} />
                    {report.audit.windowTruncated ? (
                      <p className="mt-1 text-xs text-amber-600">
                        窗口里扫到的条数等于上限，按动作的分组计数可能偏小。
                      </p>
                    ) : null}
                    {report.audit.recentActions.length === 0 ? null : (
                      <ul className="mt-2 flex flex-col gap-1">
                        {report.audit.recentActions.slice(0, 6).map((item) => (
                          <li key={item.action} className="flex items-center justify-between gap-2 text-xs">
                            <code className="font-mono">{item.action}</code>
                            <span className="tabular-nums text-muted-foreground">
                              {formatTokens(item.count)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <BlockHeader
                  title="账号池健康"
                  health={report.accounts.health}
                  hint="健康四态分布；unknown 表示还没检查过，不是「健康」"
                />
                <CardContent>
                  <div className="flex flex-col">
                    <Metric label="账号总数" value={formatTokens(report.accounts.total)} />
                    <Metric label="启用中" value={formatTokens(report.accounts.enabled)} />
                    <Metric label="健康" value={formatTokens(report.accounts.healthy)} />
                    <Metric label="降级" value={formatTokens(report.accounts.degraded)} />
                    <Metric label="异常" value={formatTokens(report.accounts.unhealthy)} />
                    <Metric label="未检查" value={formatTokens(report.accounts.unknown)} />
                    <Metric
                      label="系统自动停用"
                      value={formatTokens(report.accounts.autoDisabled)}
                    />
                    <Metric label="最近一轮检查" value={formatDateTime(report.accounts.lastPassAt)} />
                    {report.accounts.lastPass === null ? null : (
                      <>
                        <Metric
                          label="检查 / 成功 / 失败"
                          value={`${formatTokens(report.accounts.lastPass.checked)} / ${formatTokens(report.accounts.lastPass.healthy)} / ${formatTokens(report.accounts.lastPass.failed)}`}
                        />
                        <Metric
                          label="自动停用 / 自动恢复"
                          value={`${formatTokens(report.accounts.lastPass.autoDisabled)} / ${formatTokens(report.accounts.lastPass.autoEnabled)}`}
                        />
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </DataState>
    </div>
  );
}
