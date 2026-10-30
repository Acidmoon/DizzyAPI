import type { Metadata } from "next";

import { DashboardOverview } from "./_components/dashboard-overview";

export const metadata: Metadata = {
  title: "仪表盘 · DizzyAPI 控制台",
};

/**
 * 仪表盘：正文在 `_components/dashboard-overview.tsx`（客户端组件，取 `/api/admin/stats`
 * 与 `/api/admin/observability`）。`page.tsx` 只负责 metadata 与组装。
 */
export default function Page() {
  return <DashboardOverview />;
}
