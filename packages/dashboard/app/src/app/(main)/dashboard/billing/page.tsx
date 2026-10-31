import type { Metadata } from "next";

import { BillingBoard } from "../_components/billing-board";

export const metadata: Metadata = {
  title: "结算 · DizzyAPI",
  description: "真实扣费的记录与汇总（只读）。",
};

export default function Page() {
  return <BillingBoard />;
}
