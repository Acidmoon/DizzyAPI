import type { Metadata } from "next";

import { UsageBoard } from "../_components/usage-board";

export const metadata: Metadata = {
  title: "用量明细 · DizzyAPI",
  description: "全站请求明细、汇总与隔离区。",
};

export default function Page() {
  return <UsageBoard />;
}
