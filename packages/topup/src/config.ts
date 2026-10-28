import {
  checkConfigObject,
  issue,
  knownKeysOf,
  readPositiveInteger,
  readString,
  readStringArray,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'
import { providerIds } from './providers.ts'

/**
 * 充值订单插件配置。
 *
 * `dataPath` 省略 = 纯内存（测试 / 内嵌）；app.yml 里显式写 `./data/topup.db` 才是持久化。
 * `adminPlugins` 是管理面白名单（列表 / 确认到账 / 取消 / 统计），省略或空 = 谁都不许。
 * `provider` 必须是已注册的支付通道 id；**未知 id 明确失败**（fail-closed，不回落 manual）。
 * 金额范围用「元」的整数表示，进入订单前统一换算成整数微元。
 */
export interface TopupConfig {
  readonly dataPath?: string
  readonly adminPlugins?: readonly string[]
  readonly provider?: string
  readonly expiresMinutes?: number
  readonly minAmountYuan?: number
  readonly maxAmountYuan?: number
}

export interface ResolvedTopupConfig {
  readonly dataPath: string | undefined
  readonly adminPlugins: readonly string[]
  readonly provider: string
  readonly expiresMinutes: number
  readonly minAmountYuan: number
  readonly maxAmountYuan: number
}

const TOPUP_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '充值订单数据库位置', kind: 'string', writable: false },
  { key: 'adminPlugins', label: '可管理充值订单的插件', kind: 'stringArray', writable: false },
  {
    key: 'provider',
    label: '支付通道 id',
    kind: 'string',
    writable: false,
    values: providerIds(),
  },
  {
    key: 'expiresMinutes',
    label: '订单有效期（分钟）',
    kind: 'integer',
    writable: true,
    min: 1,
    max: 10_080,
  },
  { key: 'minAmountYuan', label: '最低充值金额（元）', kind: 'integer', writable: false, min: 1 },
  { key: 'maxAmountYuan', label: '最高充值金额（元）', kind: 'integer', writable: false, min: 1 },
]

const KNOWN_KEYS = knownKeysOf(TOPUP_FIELDS)

export const TOPUP_DEFAULTS = {
  dataPath: './data/topup.db',
  provider: 'manual',
  expiresMinutes: 30,
  minAmountYuan: 1,
  maxAmountYuan: 10_000,
} as const

const MAX_AMOUNT_YUAN = 1_000_000_000

export function validateTopupConfig(value: unknown): ResolvedTopupConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const dataPath = readString(raw, 'dataPath', issues)
  const adminPlugins = readStringArray(raw, 'adminPlugins', issues)
  const provider = readString(raw, 'provider', issues)
  const expiresMinutes = readPositiveInteger(raw, 'expiresMinutes', issues, { min: 1, max: 10_080 })
  const minAmountYuan = readPositiveInteger(raw, 'minAmountYuan', issues, { min: 1, max: MAX_AMOUNT_YUAN })
  const maxAmountYuan = readPositiveInteger(raw, 'maxAmountYuan', issues, { min: 1, max: MAX_AMOUNT_YUAN })

  // 未知支付通道必须明确失败：静默回落 manual 会把「配了支付宝」变成「手动转账」。
  if (provider !== undefined && !providerIds().includes(provider)) {
    issues.push(
      issue(`provider 未知：${JSON.stringify(provider)}（可用：${providerIds().join(' / ')}）`),
    )
  }

  const min = minAmountYuan ?? TOPUP_DEFAULTS.minAmountYuan
  const max = maxAmountYuan ?? TOPUP_DEFAULTS.maxAmountYuan
  if (min > max) {
    issues.push(issue(`minAmountYuan（${min}）不能大于 maxAmountYuan（${max}）`))
  }

  if (issues.length > 0) return issues
  return {
    dataPath: dataPath ?? TOPUP_DEFAULTS.dataPath,
    adminPlugins: adminPlugins ?? [],
    provider: provider ?? TOPUP_DEFAULTS.provider,
    expiresMinutes: expiresMinutes ?? TOPUP_DEFAULTS.expiresMinutes,
    minAmountYuan: min,
    maxAmountYuan: max,
  }
}

export const TOPUP_CONFIG_SCHEMA = standardSchema<ResolvedTopupConfig>(
  'dizzyapi',
  validateTopupConfig,
  TOPUP_FIELDS,
)
