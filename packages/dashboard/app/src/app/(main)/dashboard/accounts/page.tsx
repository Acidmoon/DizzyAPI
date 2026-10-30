import type { Metadata } from "next";

import { AccountsBoard } from "../_components/accounts-board";

export const metadata: Metadata = {
  title: "上游账号池 · DizzyAPI",
  description: "上游账号：先筛条件，再看列表。凭据与令牌一律不回显。",
};

export default function Page() {
  return <AccountsBoard />;
}
