import type { Metadata } from "next";

import { AuditBoard } from "../_components/audit-board";

export const metadata: Metadata = {
  title: "操作审计 · DizzyAPI",
  description: "管理员高危写操作的留痕（只读）。",
};

export default function Page() {
  return <AuditBoard />;
}
