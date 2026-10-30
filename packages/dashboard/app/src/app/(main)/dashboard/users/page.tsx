import type { Metadata } from "next";

import { UsersBoard } from "../_components/users-board";

export const metadata: Metadata = {
  title: "用户管理 · DizzyAPI",
  description: "全站用户列表与编辑：名称、角色、状态、余额、并发上限。",
};

export default function Page() {
  return <UsersBoard />;
}
