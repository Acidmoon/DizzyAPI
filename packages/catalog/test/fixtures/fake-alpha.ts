/**
 * 测试夹具：带静态 `catalog` 清单的插件。
 *
 * 清单故意声明了一条指向秘密字段的 storage（`apiSecret`）——目录必须拒绝输出它，
 * 并把这条声明记进 `unknown`，而不是把秘密当路径吐出来。
 */
import { Service, type Context } from 'cordis'
import { standardSchema, type FieldSpec } from '@dizzyapi/plugin-kit'

const FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '数据文件', kind: 'string', writable: false },
  { key: 'apiSecret', label: '秘密', kind: 'string', writable: false, secret: true },
  { key: 'mode', label: '模式', kind: 'enum', values: ['a', 'b'], writable: true },
]

export class FakeAlpha extends Service {
  static Config = standardSchema<Record<string, unknown>>(
    'test',
    (value) => (isRecord(value) ? value : {}),
    FIELDS,
  )

  static catalog = {
    version: 1,
    description: '测试用 alpha 插件',
    capabilities: ['alpha-feature'],
    events: [{ name: 'alpha/changed', description: '数据变了', payload: 'id: string' }],
    bridge: [
      {
        method: 'alpha.query',
        direction: 'inbound',
        description: '查询 alpha',
        responseShape: 'AlphaResult',
      },
    ],
    storage: [
      { key: 'dataPath', kind: 'file', description: 'alpha 数据文件' },
      { key: 'apiSecret', kind: 'file', description: '这条声明必须被拒绝' },
    ],
    shapes: {
      AlphaResult: {
        description: 'alpha 查询结果',
        fields: {
          id: { type: 'string' },
          note: { type: 'string', optional: true },
        },
      },
    },
    methods: {
      ping: { description: 'ping 一下' },
      _internal: { private: true, description: '内部方法' },
    },
  } as const

  readonly config: Record<string, unknown>

  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'fakeAlpha')
    this.config = config
  }

  ping(one: string, two: number): string {
    return `${one}:${two}`
  }

  status(): string {
    return 'ok'
  }

  _internal(): void {
    // 惯例私有；目录会保留但标成 privateByConvention。
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export default FakeAlpha
