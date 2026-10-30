/**
 * 夹具的公共底座：域错误与测试用配置。
 *
 * 从 `test/fixtures.ts` 按域拆出（§5.6：测试文件 500 行上限）。行为逐字未改。
 */
import { validateApiConfig, type ResolvedApiConfig } from '../../src/config.ts'
import { isIssueList } from '@dizzyapi/plugin-kit'

export class DomainError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'DomainError'
    this.code = code
  }
}

export function resolvedConfig(overrides: Record<string, unknown> = {}): ResolvedApiConfig {
  const value = validateApiConfig({ port: 0, ...overrides })
  if (isIssueList(value)) throw new Error(`测试配置不合法：${value.map((item) => item.message).join('；')}`)
  return value
}
