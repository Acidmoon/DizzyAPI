"use client";

/**
 * 模型广场顶部的**探测状态提示**。
 *
 * 这条是批 3 的验收重点：**探测停摆必须显眼**。
 *
 * 为什么不显示等于骗人：探测停摆时（探测账户余额不足 / 探测 key 被拒 / 连不上网关）
 * 所有模型都没有新数据，但模型可能一个都没挂。用户看到一片「未知」只会以为模型全挂了 ——
 * `总工` 的原话是「假红比不监测更糟」。
 *
 * 三种状态（判定顺序在 `probeNoticeOf` 里，这里只画）：
 * - **停摆**（`blockedReason` 非空）：醒目告警，并明写「这不是模型故障」；
 * - **没启用 / 第一轮还没跑完**：只说明情况，不制造紧张感；
 * - **正常**：不占版面（返回 `null`）。
 */

import { Info, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { ModelProbeSummaryView } from "@/lib/api";
import { probeNoticeOf } from "@/lib/model-probe";

export interface ModelProbeNoticeProps {
  /** 服务端给的探测总体状态；**没有这个键** = 没接探测服务，什么都不显示。 */
  readonly summary?: ModelProbeSummaryView | undefined;
}

export function ModelProbeNotice({ summary }: ModelProbeNoticeProps) {
  const notice = probeNoticeOf(summary);
  if (notice === null || summary === undefined) return null;

  const blocked = notice.tone === "danger";
  const detail = blocked ? summary.blockedDetail : null;
  return (
    <Alert
      variant={blocked ? "destructive" : "default"}
      className={blocked ? "border-destructive/40" : "border-border"}
      data-probe-notice={summary.blockedReason ?? "info"}
    >
      {blocked ? <TriangleAlert /> : <Info />}
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>{notice.description}</AlertDescription>
      {/* 技术细节（可读的失败原因）单独一行：它不含秘密，是排障的第一手线索。 */}
      {detail === null ? null : <AlertDescription className="text-xs">{detail}</AlertDescription>}
    </Alert>
  );
}
