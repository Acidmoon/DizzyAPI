import type { Metadata } from "next";

import { ContentAuditBoard } from "../_components/content-audit-board";

export const metadata: Metadata = {
  title: "内容审核 · DizzyAPI",
  description: "审核关键词规则与推送健康度。",
};

export default function Page() {
  return <ContentAuditBoard />;
}
