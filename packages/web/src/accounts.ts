/**
 * 账号页共用的展示与表单解析（列表页 / 详情页 / 批量表单共用一份口径）。
 *
 * 这里只做「显示」与「把表单文本解析成参数」；写入一律经 `accountAdmin` 服务，
 * 账号记录仍由 identity 独占写入。
 */
import type { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { WebError } from './forms.ts'

/** `status` 的中文说明（人话，不是错误码）。 */
export function statusText(status: string): string {
  switch (status) {
    case 'active':
      return '正常'
    case 'needs_reauth':
      return '待重新授权'
    case 'auto_disabled':
      return '自动停用'
    default:
      return status
  }
}

/** 状态徽章：`active` 绿、自动停用黄、其余红。 */
export function statusBadge(t: PageTemplateService, status: string): string {
  const kind = status === 'active' ? 'ok' : status === 'auto_disabled' ? 'warn' : 'err'
  return t.renderBadge(statusText(status), kind)
}

export function healthText(health: string): string {
  switch (health) {
    case 'healthy':
      return '健康'
    case 'degraded':
      return '降级'
    case 'unhealthy':
      return '不健康'
    case 'unknown':
      return '未知'
    default:
      return health
  }
}

/** 健康徽章；`unknown` 保持中性（未知不是「默认健康」）。 */
export function healthBadge(t: PageTemplateService, health: string): string {
  if (health === 'healthy') return t.renderBadge(healthText(health), 'ok')
  if (health === 'degraded') return t.renderBadge(healthText(health), 'warn')
  if (health === 'unhealthy') return t.renderBadge(healthText(health), 'err')
  return t.renderBadge(healthText(health))
}

/** ISO 时间 → `YYYY-MM-DD HH:mm UTC`；空值给破折号。 */
export function formatTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—'
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`
}

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : String(value)
}

export function labelsText(labels: readonly string[] | null | undefined): string {
  if (labels === null || labels === undefined || labels.length === 0) return '—'
  return labels.join(', ')
}

/** 表单里的标签文本：逗号 / 换行分隔；空文本 = 清空。 */
export function parseLabels(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/** 批量表单勾选的账号 id：去空、去重、保序。 */
export function parseIds(form: URLSearchParams): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const value of form.getAll('ids')) {
    const id = value.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (ids.length === 0) throw new WebError('WEB_ACCOUNT_IDS_REQUIRED', '先勾选要操作的账号')
  return ids
}

/** 必填的正数（权重）。 */
export function requirePositiveNumber(text: string, field: string): number {
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) {
    throw new WebError('WEB_ACCOUNT_NUMBER_INVALID', `${field}必须是大于 0 的数值`)
  }
  return value
}

/** 必填的整数（并发上限 / 优先级）。 */
export function requireInteger(text: string, field: string, min: number, max: number): number {
  const value = Number(text)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new WebError('WEB_ACCOUNT_NUMBER_INVALID', `${field}必须是 ${min}–${max} 的整数`)
  }
  return value
}

/**
 * 把服务抛出的错误变成人话：带稳定 code 的领域错误显示其中文消息，
 * 其余统一兜底，不把内部细节（堆栈 / 路径）暴露给页面。
 */
export function errorText(error: unknown): string {
  if (error instanceof WebError) return error.message
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (
      typeof code === 'string' &&
      code !== '' &&
      error.message.length > 0 &&
      error.message.length <= 160 &&
      !error.message.includes('\n')
    ) {
      return error.message
    }
  }
  return '操作失败，请稍后再试'
}
