/**
 * 策略组与打分请求的校验。
 *
 * 规则必须与 Go 侧 `modules/accountpriority/config.go` 保持一致：
 * 两边都校验不是重复劳动——TS 在写盘前拒绝坏配置，Go 在应用前再拒绝一次，
 * 后者保证「任何来源的配置都不会被部分应用」。
 */
import { AccountPriorityError, type AccountPriorityErrorCode } from './errors.ts'
import type {
  AccountCandidate,
  FactorRule,
  StrategyDirection,
  StrategyFilter,
  StrategyGroup,
  StrategyHealthPolicy,
  StrategySelection,
  ScoreRequest,
} from './types.ts'

export const MAX_STRATEGIES = 64
export const MAX_CANDIDATES = 10_000
export const MAX_NAME_LENGTH = 200
export const MAX_DESCRIPTION_LENGTH = 2_000

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

const FACTOR_NAMES = new Set([
  'priority',
  'capacity',
  'health',
  'quota',
  'rateLimit',
  'headroom',
  'success',
  'latency',
  'cost',
  'freshness',
])

const FIXED_FACTORS = new Set(['health', 'quota', 'rateLimit', 'headroom', 'success'])

const DEFAULT_DIRECTIONS: Record<string, StrategyDirection> = {
  priority: 'desc',
  capacity: 'desc',
  health: 'desc',
  quota: 'desc',
  rateLimit: 'desc',
  headroom: 'desc',
  success: 'desc',
  latency: 'asc',
  cost: 'asc',
  freshness: 'desc',
}

const TIE_BREAKERS = new Set(['priority', 'weight', 'success', 'latency', 'freshness', 'accountId'])
const SELECTIONS = new Set<StrategySelection>(['rank', 'weighted-random'])
const HEALTH_POLICIES = new Set<StrategyHealthPolicy>([
  'exclude_unhealthy',
  'require_healthy',
  'allow_all',
])

const STRATEGY_KEYS = new Set([
  'id',
  'name',
  'description',
  'enabled',
  'filter',
  'factors',
  'selection',
  'tieBreaker',
  'maxCandidates',
])
const FILTER_KEYS = new Set([
  'providers',
  'kinds',
  'tags',
  'health',
  'excludeCooling',
  'excludeSaturated',
])
const FACTOR_KEYS = new Set(['weight', 'direction', 'unknown'])

export interface ValidationOptions {
  readonly code?: AccountPriorityErrorCode
  readonly label?: string
}

function fail(options: ValidationOptions, message: string): never {
  throw new AccountPriorityError(
    options.code ?? 'ACCOUNT_PRIORITY_STRATEGY_INVALID',
    `${options.label ?? '策略组'}：${message}`,
  )
}

function asObject(value: unknown, options: ValidationOptions, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(options, `${where} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function assertKnownKeys(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  options: ValidationOptions,
  where: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      fail(options, `${where} 有未知字段 ${key}`)
    }
  }
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  options: ValidationOptions,
  where: string,
  maxLength: number,
): string | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') fail(options, `${where}.${key} 必须是字符串`)
  if (value.length > maxLength) fail(options, `${where}.${key} 超过 ${maxLength} 字符`)
  return value
}

function optionalBoolean(
  raw: Record<string, unknown>,
  key: string,
  options: ValidationOptions,
  where: string,
): boolean | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') fail(options, `${where}.${key} 必须是布尔值`)
  return value
}

function optionalNumber(
  raw: Record<string, unknown>,
  key: string,
  options: ValidationOptions,
  where: string,
  min: number,
  max: number,
): number | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(options, `${where}.${key} 必须是有限数字`)
  }
  if (value < min || value > max) fail(options, `${where}.${key} 必须在 ${min} 到 ${max} 之间`)
  return value
}

function optionalInteger(
  raw: Record<string, unknown>,
  key: string,
  options: ValidationOptions,
  where: string,
  min: number,
  max: number,
): number | undefined {
  const value = optionalNumber(raw, key, options, where, min, max)
  if (value !== undefined && !Number.isSafeInteger(value)) {
    fail(options, `${where}.${key} 必须是整数`)
  }
  return value
}

function stringArray(
  value: unknown,
  options: ValidationOptions,
  where: string,
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) fail(options, `${where} 必须是字符串数组`)
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      fail(options, `${where} 里的元素必须是非空字符串`)
    }
    out.push(item)
  }
  return out
}

function validateFilter(value: unknown, options: ValidationOptions, where: string): StrategyFilter | undefined {
  if (value === undefined) return undefined
  const raw = asObject(value, options, where)
  assertKnownKeys(raw, FILTER_KEYS, options, where)

  const providers = stringArray(raw.providers, options, `${where}.providers`)
  const kinds = stringArray(raw.kinds, options, `${where}.kinds`)
  let tags: Record<string, string> | undefined
  if (raw.tags !== undefined) {
    const tagObject = asObject(raw.tags, options, `${where}.tags`)
    tags = {}
    for (const [key, tagValue] of Object.entries(tagObject)) {
      if (key.trim() === '') fail(options, `${where}.tags 不能有空键`)
      if (typeof tagValue !== 'string') fail(options, `${where}.tags.${key} 必须是字符串`)
      tags[key] = tagValue
    }
  }

  let health: StrategyHealthPolicy | undefined
  if (raw.health !== undefined) {
    if (typeof raw.health !== 'string' || !HEALTH_POLICIES.has(raw.health as StrategyHealthPolicy)) {
      fail(options, `${where}.health 只能是 exclude_unhealthy / require_healthy / allow_all`)
    }
    health = raw.health as StrategyHealthPolicy
  }

  const excludeCooling = optionalBoolean(raw, 'excludeCooling', options, where)
  const excludeSaturated = optionalBoolean(raw, 'excludeSaturated', options, where)

  return {
    ...(providers === undefined ? {} : { providers }),
    ...(kinds === undefined ? {} : { kinds }),
    ...(tags === undefined ? {} : { tags }),
    ...(health === undefined ? {} : { health }),
    ...(excludeCooling === undefined ? {} : { excludeCooling }),
    ...(excludeSaturated === undefined ? {} : { excludeSaturated }),
  }
}

function validateFactors(
  value: unknown,
  options: ValidationOptions,
  where: string,
): Record<string, FactorRule> {
  const raw = asObject(value, options, where)
  const factors: Record<string, FactorRule> = {}
  let total = 0

  for (const [name, ruleValue] of Object.entries(raw)) {
    if (!FACTOR_NAMES.has(name)) {
      fail(options, `${where} 有未知因子 ${name}`)
    }
    const rule = asObject(ruleValue, options, `${where}.${name}`)
    assertKnownKeys(rule, FACTOR_KEYS, options, `${where}.${name}`)

    const weight = optionalNumber(rule, 'weight', options, `${where}.${name}`, 0, 100)
    if (weight === undefined) fail(options, `${where}.${name}.weight 是必填项`)

    let direction: StrategyDirection | undefined
    if (rule.direction !== undefined) {
      if (rule.direction !== 'asc' && rule.direction !== 'desc') {
        fail(options, `${where}.${name}.direction 只能是 asc 或 desc`)
      }
      direction = rule.direction
    }
    const effectiveDirection = direction ?? DEFAULT_DIRECTIONS[name]
    if (FIXED_FACTORS.has(name) && effectiveDirection === 'asc') {
      fail(options, `${where}.${name} 是固定分数因子，只能越大越好`)
    }

    const unknown = optionalNumber(rule, 'unknown', options, `${where}.${name}`, 0, 1)

    if (weight > 0) total += weight
    factors[name] = {
      weight,
      ...(direction === undefined ? {} : { direction }),
      ...(unknown === undefined ? {} : { unknown }),
    }
  }

  if (total <= 0) fail(options, `${where} 至少要有一个权重大于 0 的因子`)
  return factors
}

export function validateStrategyGroup(value: unknown, options: ValidationOptions = {}): StrategyGroup {
  const label = options.label ?? '策略组'
  const raw = asObject(value, { ...options, label }, label)
  assertKnownKeys(raw, STRATEGY_KEYS, { ...options, label }, label)

  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
    fail({ ...options, label }, 'id 只允许小写字母、数字、点、下划线与连字符，且必须以字母或数字开头')
  }
  const id = raw.id

  const name = optionalString(raw, 'name', { ...options, label }, label, MAX_NAME_LENGTH)
  const description = optionalString(raw, 'description', { ...options, label }, label, MAX_DESCRIPTION_LENGTH)
  const enabled = optionalBoolean(raw, 'enabled', { ...options, label }, label)
  const filter = validateFilter(raw.filter, { ...options, label }, `${label}.filter`)
  const factors = validateFactors(raw.factors, { ...options, label }, `${label}.factors`)

  let selection: StrategySelection | undefined
  if (raw.selection !== undefined) {
    if (typeof raw.selection !== 'string' || !SELECTIONS.has(raw.selection as StrategySelection)) {
      fail({ ...options, label }, 'selection 只能是 rank 或 weighted-random')
    }
    selection = raw.selection as StrategySelection
  }

  let tieBreaker: string[] | undefined
  if (raw.tieBreaker !== undefined) {
    if (!Array.isArray(raw.tieBreaker)) fail({ ...options, label }, 'tieBreaker 必须是字符串数组')
    const seen = new Set<string>()
    tieBreaker = []
    for (const item of raw.tieBreaker) {
      if (typeof item !== 'string' || !TIE_BREAKERS.has(item)) {
        fail({ ...options, label }, `未知 tieBreaker：${String(item)}`)
      }
      if (seen.has(item)) fail({ ...options, label }, `tieBreaker 重复：${item}`)
      seen.add(item)
      tieBreaker.push(item)
    }
  }

  const maxCandidates = optionalInteger(raw, 'maxCandidates', { ...options, label }, label, 0, MAX_CANDIDATES)

  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(filter === undefined ? {} : { filter }),
    factors,
    ...(selection === undefined ? {} : { selection }),
    ...(tieBreaker === undefined ? {} : { tieBreaker }),
    ...(maxCandidates === undefined ? {} : { maxCandidates }),
  }
}

export interface StrategyCollection {
  readonly strategies: StrategyGroup[]
  readonly defaultStrategy: string | null
}

export function validateStrategyCollection(
  value: unknown,
  defaultStrategy: unknown,
  options: ValidationOptions = {},
): StrategyCollection {
  if (!Array.isArray(value)) fail(options, 'strategies 必须是数组')
  if (value.length > MAX_STRATEGIES) {
    fail(options, `策略组最多 ${MAX_STRATEGIES} 个，收到 ${value.length} 个`)
  }

  const strategies: StrategyGroup[] = []
  const seen = new Set<string>()
  let enabledCount = 0
  for (let index = 0; index < value.length; index += 1) {
    const strategy = validateStrategyGroup(value[index], {
      ...options,
      label: `策略组 #${index + 1}`,
    })
    if (seen.has(strategy.id)) fail(options, `策略组 id 重复：${strategy.id}`)
    seen.add(strategy.id)
    if (strategy.enabled !== false) enabledCount += 1
    strategies.push(strategy)
  }
  if (strategies.length > 0 && enabledCount === 0) {
    fail(options, '至少要启用一个策略组')
  }

  let resolvedDefault: string | null = null
  if (defaultStrategy !== undefined && defaultStrategy !== null) {
    if (typeof defaultStrategy !== 'string') fail(options, 'defaultStrategy 必须是字符串或 null')
    resolvedDefault = defaultStrategy
    if (strategies.length > 0) {
      const target = strategies.find((strategy) => strategy.id === defaultStrategy)
      if (target === undefined) fail(options, `默认策略组 ${defaultStrategy} 不存在`)
      if (target.enabled === false) fail(options, `默认策略组 ${defaultStrategy} 未启用`)
    }
  } else if (strategies.length > 0) {
    resolvedDefault = strategies.find((strategy) => strategy.enabled !== false)?.id ?? null
  }

  return { strategies, defaultStrategy: resolvedDefault }
}

const CANDIDATE_KEYS = new Set([
  'accountId',
  'provider',
  'kind',
  'disabled',
  'priority',
  'weight',
  'health',
  'tags',
  'cooldownUntil',
  'quotaRatio',
  'rateLimitRatio',
  'inFlight',
  'concurrency',
  'lastUsedAt',
  'successRate',
  'latencyP95Ms',
  'costMultiplier',
])

function validateCandidate(value: unknown, index: number): AccountCandidate {
  const options: ValidationOptions = {
    code: 'ACCOUNT_PRIORITY_INVALID_ARGUMENT',
    label: `候选账号 #${index + 1}`,
  }
  const raw = asObject(value, options, options.label ?? '候选账号')
  assertKnownKeys(raw, CANDIDATE_KEYS, options, options.label ?? '候选账号')

  if (typeof raw.accountId !== 'string' || raw.accountId.trim() === '') {
    fail(options, 'accountId 必须是非空字符串')
  }
  if (typeof raw.provider !== 'string' || raw.provider.trim() === '') {
    fail(options, 'provider 必须是非空字符串')
  }
  for (const key of ['kind', 'cooldownUntil', 'lastUsedAt'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') {
      fail(options, `${key} 必须是字符串`)
    }
  }
  if (raw.disabled !== undefined && typeof raw.disabled !== 'boolean') {
    fail(options, 'disabled 必须是布尔值')
  }
  if (raw.health !== undefined) {
    if (!['unknown', 'healthy', 'degraded', 'unhealthy'].includes(String(raw.health))) {
      fail(options, 'health 只能是 unknown / healthy / degraded / unhealthy')
    }
  }
  if (raw.tags !== undefined) {
    const tags = asObject(raw.tags, options, `${options.label}.tags`)
    for (const [key, tagValue] of Object.entries(tags)) {
      if (typeof tagValue !== 'string') fail(options, `tags.${key} 必须是字符串`)
    }
  }
  for (const key of [
    'priority',
    'weight',
    'quotaRatio',
    'rateLimitRatio',
    'inFlight',
    'concurrency',
    'successRate',
    'latencyP95Ms',
    'costMultiplier',
  ] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key] as number))) {
      fail(options, `${key} 必须是有限数字`)
    }
  }

  return raw as unknown as AccountCandidate
}

export function validateScoreRequest(value: unknown): ScoreRequest {
  const options: ValidationOptions = {
    code: 'ACCOUNT_PRIORITY_INVALID_ARGUMENT',
    label: '打分请求',
  }
  const raw = asObject(value, options, '打分请求')
  for (const key of Object.keys(raw)) {
    if (!['strategy', 'candidates', 'limit', 'now', 'seed'].includes(key)) {
      fail(options, `有未知字段 ${key}`)
    }
  }
  if (raw.strategy !== undefined && typeof raw.strategy !== 'string') {
    fail(options, 'strategy 必须是字符串')
  }
  if (!Array.isArray(raw.candidates)) fail(options, 'candidates 必须是数组')
  if (raw.candidates.length > MAX_CANDIDATES) {
    fail(options, `一次最多评分 ${MAX_CANDIDATES} 个候选，收到 ${raw.candidates.length} 个`)
  }
  const seen = new Set<string>()
  const candidates = raw.candidates.map((candidate, index) => {
    const parsed = validateCandidate(candidate, index)
    if (seen.has(parsed.accountId)) fail(options, `候选账号 id 重复：${parsed.accountId}`)
    seen.add(parsed.accountId)
    return parsed
  })
  if (raw.limit !== undefined) {
    if (
      typeof raw.limit !== 'number' ||
      !Number.isSafeInteger(raw.limit) ||
      raw.limit < 0 ||
      raw.limit > MAX_CANDIDATES
    ) {
      fail(options, `limit 必须是 0 到 ${MAX_CANDIDATES} 的整数`)
    }
  }
  if (raw.now !== undefined && typeof raw.now !== 'string') {
    fail(options, 'now 必须是 RFC3339 字符串')
  }
  if (raw.seed !== undefined) {
    if (typeof raw.seed !== 'number' || !Number.isSafeInteger(raw.seed) || raw.seed < 0) {
      fail(options, 'seed 必须是非负安全整数')
    }
  }

  return {
    ...(raw.strategy === undefined ? {} : { strategy: raw.strategy as string }),
    candidates,
    ...(raw.limit === undefined ? {} : { limit: raw.limit as number }),
    ...(raw.now === undefined ? {} : { now: raw.now as string }),
    ...(raw.seed === undefined ? {} : { seed: raw.seed as number }),
  }
}
