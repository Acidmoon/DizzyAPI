import type { Metadata } from "next";

import { ObservabilityBoard } from "../_components/observability-board";

export const metadata: Metadata = {
  title: "运维总览 · DizzyAPI",
  description: "用量 / 结算 / 额度 / 运行时 / 审计 / 账号池健康一屏总览。",
};

export default function Page() {
  return <ObservabilityBoard />;
}
