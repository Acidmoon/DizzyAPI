/**
 * 测试夹具：清单放在**模块级导出** `catalog` 上，默认导出没有静态属性。
 * 目录在没有静态清单时会动态 import 模块来读它。
 */
import { Service, type Context } from 'cordis'
import { standardSchema, type FieldSpec } from '@dizzyapi/plugin-kit'

export const catalog = {
  capabilities: ['gamma-feature'],
  events: [{ name: 'gamma/happened', description: 'gamma 事件' }],
} as const

const FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '数据文件', kind: 'string', writable: false },
]

export class FakeGamma extends Service {
  static Config = standardSchema<Record<string, unknown>>(
    'test',
    (value) => (isRecord(value) ? value : {}),
    FIELDS,
  )

  readonly config: Record<string, unknown>

  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'fakeGamma')
    this.config = config
  }

  scan(): string {
    return 'scanned'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export default FakeGamma
