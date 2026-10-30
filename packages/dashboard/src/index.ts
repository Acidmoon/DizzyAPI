/**
 * DizzyAPI 控制台插件（Next.js 静态导出 SPA 的托管方）。
 *
 * 上游是 `arhamkhnz/next-shadcn-admin-dashboard`（MIT，commit `feba542`），
 * 整份 vendor 在 `packages/dashboard/app/`，出处与改动清单见同目录 `README.md`。
 *
 * 本包（`src/`）只做两件事：发静态字节、给页面路由做回退。业务页面在 `app/`。
 */
import { DashboardService } from './service.ts'

declare module 'cordis' {
  interface Context {
    dashboard: DashboardService
  }
}

export { DashboardService }
export {
  DASHBOARD_CONFIG_SCHEMA,
  DASHBOARD_DEFAULTS,
  validateDashboardConfig,
  type DashboardConfig,
  type ResolvedDashboardConfig,
} from './config.ts'
export { contentSecurityPolicy, injectScriptNonce, newNonce } from './csp.ts'
export { StaticServer, type StaticServerOptions } from './static-server.ts'
export { contentTypeOf, extensionOf, looksLikeFile } from './mime.ts'
export { defaultDistDir } from './paths.ts'

export default DashboardService
