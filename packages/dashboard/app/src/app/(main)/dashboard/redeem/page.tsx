import type { Metadata } from "next";

import { RedeemBoard } from "../_components/redeem-board";

export const metadata: Metadata = {
  title: "兑换码 · DizzyAPI",
  description: "批次生成与兑换码管理；明文只在生成后出现一次。",
};

export default function Page() {
  return <RedeemBoard />;
}
