import type { Metadata } from "next";

import { TopupBoard } from "../_components/topup-board";

export const metadata: Metadata = {
  title: "充值订单 · DizzyAPI",
  description: "人工到账：确认会真的加余额，且幂等。",
};

export default function Page() {
  return <TopupBoard />;
}
