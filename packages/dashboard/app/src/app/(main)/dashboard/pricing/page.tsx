import type { Metadata } from "next";

import { PricingBoard } from "../_components/pricing-board";

export const metadata: Metadata = {
  title: "模型价格 · DizzyAPI",
  description: "价表读写：没配价的模型在闸门打开后会被拒绝。",
};

export default function Page() {
  return <PricingBoard />;
}
