/**
 * 测试夹具：没有清单的插件。
 *
 * 目录只能靠反射：服务、方法、inject、Config 字段；事件 / 桥 / 数据形状都必须是
 * `unknown`，不能被编造。`dataPath` 会按字段名推导成存储路径。
 */
import { Service, type Context } from 'cordis'
import { standardSchema, type FieldSpec } from '@dizzyapi/plugin-kit'

const FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '数据文件', kind: 'string', writable: false },
  { key: 'token', label: '令牌', kind: 'string', writable: false, secret: true },
  { key: 'limit', label: '上限', kind: 'integer', writable: true, min: 1, max: 100 },
]

export class FakeBeta extends Service {
  static Config = standardSchema<Record<string, unknown>>(
    'test',
    (value) => (isRecord(value) ? value : {}),
    FIELDS,
  )

  static inject = ['fakeAlpha']

  readonly config: Record<string, unknown>

  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'fakeBeta')
    this.config = config
  }

  work(): string {
    return 'done'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export default FakeBeta
