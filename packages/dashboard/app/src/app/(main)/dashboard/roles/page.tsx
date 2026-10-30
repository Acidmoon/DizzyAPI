import type { Metadata } from "next";

import { RolesBoard } from "../_components/roles-board";

export const metadata: Metadata = {
  title: "角色权限 · DizzyAPI",
  description: "全站角色分布与改角色。",
};

export default function Page() {
  return <RolesBoard />;
}
