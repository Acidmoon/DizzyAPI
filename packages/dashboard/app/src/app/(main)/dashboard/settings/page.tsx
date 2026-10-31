import type { Metadata } from "next";

import { SettingsBoard } from "../_components/settings-board";

export const metadata: Metadata = {
  title: "设置 · DizzyAPI",
  description: "运行期配置覆盖（秘密字段只显示状态）。",
};

export default function Page() {
  return <SettingsBoard />;
}
