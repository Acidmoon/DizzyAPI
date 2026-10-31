import type { Metadata } from "next";

import { AccountsBoard } from "../_components/accounts-board";

export const metadata: Metadata = {
  title: "上游账号池 · DizzyAPI",
  description: "上游账号池。",
};

export default function Page() {
  return <AccountsBoard />;
}
