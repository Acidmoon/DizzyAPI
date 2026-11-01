import type { Metadata } from "next";

import { ClientsBoard } from "../_components/clients-board";

export const metadata: Metadata = {
  title: "客户端档案 · DizzyAPI",
  description: "上游请求的客户端指纹档案。",
};

export default function Page() {
  return <ClientsBoard />;
}
