"use client";

/**
 * 仪表盘（`/dashboard`）：管理员一屏看全站规模、今日与累计用量、以及运维健康度。
 *
 * 数据来源（两个接口，**都只要管理员权限**）：
 * - `GET /api/admin/stats` → 用户 / 账号 / key 计数 + 今日与累计 token、费用、近 30 天序列、Top 模型与 Top 用户
 * - `GET /api/admin/observability` → 六块数据源健康度 + 异常摘要（**任一源缺失只降级那一块，HTTP 仍 200**）
 *
 * 两条纪律：
 * - **金额一律走 `formatMicrosAsYuan`**（整数微元字符串，不经浮点）。
 * - **运维块「降级」不等于页面坏**：`degraded` 时顶部提示，各块照常渲染 —— 这正是它存在的原因。
 */
import { useCallback } from "react";

import { Activity, AlertTriangle, KeyRound, Server, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, adminOps } from "@/lib/api";
import { formatMicrosAsYuan, formatTokens } from "@/lib/format";

import { DataState } from "./data-state";
import { useResource } from "./use-resource";

interface Overview {
  readonly stats: Awaited<ReturnType<typeof adminOps.fetchAdminStats>>;
  readonly ops: Awaited<ReturnType<typeof adminOps.fetchObservability>>;
}

/** 数据源健康度徽标：`ok` 绿、`degraded` 黄、`unavailable` 红，**未知不放行**。 */
function HealthBadge({ health }: { health: { readonly state: string; readonly detail: string } }) {
  const tone =
    health.state === "ok"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : health.state === "degraded"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : "bg-destructive/15 text-destructive";
  const label = health.state === "ok" ? "正常" : health.state === "degraded" ? "降级" : "不可用";
  return (
    <Badge variant="outline" className={tone} title={health.detail}>
      {label}
    </Badge>
  );
}

/** 一张指标卡。`hint` 只放「数字本身」或「状态本身」，不放口径解释。 */
function Metric({
  title,
  value,
  hint,
  icon: Icon,
}: {
  title: string;
  value: string;
  hint?: string;
  icon: typeof Users;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <CardAction>
          <Icon className="size-4 text-muted-foreground" />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {hint === undefined ? null : <span className="text-xs text-muted-foreground">{hint}</span>}
      </CardContent>
    </Card>
  );
}

export function DashboardOverview() {
  const load = useCallback(async (): Promise<Overview> => {
    // 两个接口并行：任一失败整块报错（页面级 prompt 比半张页面更诚实）。
    const [stats, ops] = await Promise.all([adminOps.fetchAdminStats(api), adminOps.fetchObservability(api)]);
    return { stats, ops };
  }, []);
  const { data, error, loading, reload } = useResource(load);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">仪表盘</h1>

      <DataState loading={loading} error={error} empty={data === null} onRetry={reload} emptyTitle="暂时没有概览数据">
        {data === null ? null : (
          <>
            {data.ops.degraded ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div className="flex flex-col gap-1">
                  <span>部分数据源不完整，下面按各自健康度标注。</span>
                  {data.ops.warnings.length === 0 ? null : (
                    <span className="text-xs text-muted-foreground">{data.ops.warnings.join(" · ")}</span>
                  )}
                </div>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric
                title="用户（管理员 / 启用 / 封禁）"
                value={`${formatTokens(data.stats.users.total)}`}
                hint={`管理员 ${formatTokens(data.stats.users.admins)} · 启用 ${formatTokens(data.stats.users.enabled)} · 封禁 ${formatTokens(data.stats.users.banned)}`}
                icon={Users}
              />
              <Metric
                title="上游账号（启用 / 停用）"
                value={`${formatTokens(data.stats.accounts.total)}`}
                hint={`启用 ${formatTokens(data.stats.accounts.enabled)} · 停用 ${formatTokens(data.stats.accounts.disabled)} · 待重新授权 ${formatTokens(data.stats.accounts.needsReauth)}`}
                icon={Server}
              />
              <Metric
                title="API 密钥（启用 / 停用）"
                value={`${formatTokens(data.stats.keys.total)}`}
                hint={`启用 ${formatTokens(data.stats.keys.enabled)} · 停用 ${formatTokens(data.stats.keys.disabled)}`}
                icon={KeyRound}
              />
              <Metric
                title="今日请求数"
                value={data.stats.usage === null ? "—" : formatTokens(data.stats.usage.today.requests)}
                hint={
                  data.stats.usage === null
                    ? "用量插件不在运行"
                    : `今日费用 ${formatMicrosAsYuan(data.stats.usage.today.costMicros)} 元`
                }
                icon={Activity}
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">累计用量</CardTitle>
                {data.stats.usage === null ? (
                  <CardDescription>用量插件不在运行：这块暂时没有数据（其余块照常）。</CardDescription>
                ) : null}
              </CardHeader>
              <CardContent>
                {data.stats.usage === null ? (
                  <p className="text-sm text-muted-foreground">—</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <Metric title="累计请求" value={formatTokens(data.stats.usage.total.requests)} icon={Activity} />
                    <Metric
                      title="累计 token"
                      value={formatTokens(data.stats.usage.total.tokens)}
                      hint={`入 ${formatTokens(data.stats.usage.total.inputTokens)} · 出 ${formatTokens(data.stats.usage.total.outputTokens)}`}
                      icon={Activity}
                    />
                    <Metric
                      title="累计费用"
                      value={`${formatMicrosAsYuan(data.stats.usage.total.costMicros)} 元`}
                      icon={Activity}
                    />
                    <Metric
                      title="费用最高的模型数"
                      value={formatTokens(data.stats.usage.models.length)}
                      icon={Activity}
                    />
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="grid gap-3 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">数据源健康度</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {(
                    [
                      ["用量链路", data.ops.usage.health],
                      ["Go 环形缓冲", data.ops.usage.gatewayHealth],
                      ["结算", data.ops.billing.health],
                      ["额度快照", data.ops.quota.health],
                      ["账号运行时", data.ops.runtime.health],
                      ["审计", data.ops.audit.health],
                      ["账号池", data.ops.accounts.health],
                    ] as const
                  ).map(([label, health]) => (
                    <div key={label} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-muted-foreground">{label}</span>
                      <div className="flex items-center gap-2">
                        {health.detail === "" ? null : (
                          <span className="max-w-[22ch] truncate text-xs text-muted-foreground" title={health.detail}>
                            {health.detail}
                          </span>
                        )}
                        <HealthBadge health={health} />
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">费用最高的模型（累计）</CardTitle>
                </CardHeader>
                <CardContent className="px-0">
                  {data.stats.usage === null || data.stats.usage.models.length === 0 ? (
                    <p className="px-4 text-sm text-muted-foreground">暂时没有模型用量。</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="pl-4">模型</TableHead>
                          <TableHead className="text-right">请求</TableHead>
                          <TableHead className="pr-4 text-right">费用（元）</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {[...data.stats.usage.models]
                          // 费用比较用 BigInt：微元可能超过 2^53，转 Number 会悄悄丢精度。
                          .sort((left, right) => {
                            const delta = BigInt(right.costMicros) - BigInt(left.costMicros);
                            return delta === 0n ? 0 : delta > 0n ? 1 : -1;
                          })
                          .slice(0, 8)
                          .map((model) => (
                            <TableRow key={model.model}>
                              <TableCell className="pl-4 font-mono text-xs">{model.model}</TableCell>
                              <TableCell className="text-right tabular-nums">{formatTokens(model.requests)}</TableCell>
                              <TableCell className="pr-4 text-right tabular-nums">
                                {formatMicrosAsYuan(model.costMicros)}
                              </TableCell>
                            </TableRow>
                          ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">消费最高的用户（累计）</CardTitle>
              </CardHeader>
              <CardContent className="px-0">
                {data.stats.usage === null || data.stats.usage.topUsers.length === 0 ? (
                  <p className="px-4 text-sm text-muted-foreground">暂时没有用户用量。</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">用户</TableHead>
                        <TableHead className="text-right">请求</TableHead>
                        <TableHead className="pr-4 text-right">费用（元）</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...data.stats.usage.topUsers]
                        .sort((left, right) => {
                          const delta = BigInt(right.costMicros) - BigInt(left.costMicros);
                          return delta === 0n ? 0 : delta > 0n ? 1 : -1;
                        })
                        .slice(0, 8)
                        .map((user) => (
                          <TableRow key={user.userId}>
                            <TableCell className="pl-4">{user.name ?? `用户 #${String(user.userId)}`}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatTokens(user.requests)}</TableCell>
                            <TableCell className="pr-4 text-right tabular-nums">
                              {formatMicrosAsYuan(user.costMicros)}
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </DataState>
    </div>
  );
}
