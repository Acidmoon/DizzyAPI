import packageJson from "../../package.json";

const currentYear = new Date().getFullYear();

/**
 * 站点级常量。
 *
 * `repository` 仍指向上游项目：AI 面板的组件与布局来自
 * arhamkhnz/next-shadcn-admin-dashboard（MIT），出处与改动清单见
 * `packages/dashboard/README.md`。
 */
export const APP_CONFIG = {
  name: "DizzyAPI",
  // 站点地址：生产由构建期环境变量 `NEXT_PUBLIC_SITE_URL` 注入（`metadataBase` 要用绝对地址）。
  // 仓库里不留真实域名，没注入时退回本地回环，构建与本地预览都能跑。
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://127.0.0.1:7792",
  repository: "https://github.com/arhamkhnz/next-shadcn-admin-dashboard",
  version: packageJson.version,
  copyright: `© ${currentYear} DizzyAPI`,
  meta: {
    title: "DizzyAPI 控制台",
    description: "DizzyAPI 自托管模型网关的控制台：账号池、模型价格、用量结算与 API 密钥管理。",
  },
};
