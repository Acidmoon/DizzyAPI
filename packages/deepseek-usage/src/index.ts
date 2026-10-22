/**
 * 「用量信息」页插件（DeepSeek 开放平台用量页的像素级复刻）。
 *
 * 它是**独立的前端页面**，不改动 `packages/console` 现有的控制台：
 * 自己起一个 127.0.0.1 的 HTTP 服务，渲染 DeepSeek「用量信息」页，
 * 数据来自本项目的 `usage` / `user` / `auth` 服务。
 *
 * 视觉对齐依据是原站的实测值（见 `tokens.ts`），不复制原站 CSS / JS / 图片。
 */
import { DeepseekUsageService } from './service.ts'

declare module 'cordis' {
  interface Context {
    deepseekUsage: DeepseekUsageService
  }
}

export { DeepseekUsageService }
export {
  DEEPSEEK_USAGE_CONFIG_SCHEMA,
  DEEPSEEK_USAGE_DEFAULTS,
  validateDeepseekUsageConfig,
  type DeepseekUsageConfig,
  type ResolvedDeepseekUsageConfig,
} from './config.ts'
export {
  addMicros,
  microsToCents,
  microsToYuan,
  RANGE_DAYS,
  sumMicros,
  type ApiKeyOption,
  type Board,
  type DayPoint,
  type GroupBy,
  type ModelBoard,
  type RangeKey,
} from './board.ts'
export {
  collectBoard,
  toChartData,
  type ChartDatum,
  type UsageReader,
  type UsageRow,
} from './collect.ts'
export { renderPage, renderStackedBarChart, type RenderContext } from './render.ts'
export { UsagePageServer, readSessionCookie, type UsagePageHandlers } from './http.ts'
export { DARK_TOKENS, FONT_STACK, METRICS, formatAxisDate, formatCents, formatCompact, formatThousands } from './tokens.ts'

export default DeepseekUsageService
