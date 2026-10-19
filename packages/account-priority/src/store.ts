import {
  jsonFileStore,
  memoryStore,
  type JsonCodec,
  type JsonStore,
} from '@dizzyapi/plugin-kit'
import { AccountPriorityError, isAccountPriorityError } from './errors.ts'
import type { StrategyGroup } from './types.ts'
import { validateStrategyCollection } from './validate.ts'

export const SNAPSHOT_VERSION = 1

/**
 * 策略组的持久化形状。
 *
 * 按 D8，这份数据只有一个写者：本 TS 插件。Go 只接收推送后的只读快照，
 * 从不回写这个文件。
 */
export interface AccountPrioritySnapshot {
  readonly version: number
  readonly defaultStrategy: string | null
  readonly strategies: readonly StrategyGroup[]
}

export function emptySnapshot(): AccountPrioritySnapshot {
  return { version: SNAPSHOT_VERSION, defaultStrategy: null, strategies: [] }
}

function corrupt(detail: string): never {
  throw new AccountPriorityError('ACCOUNT_PRIORITY_STORE_CORRUPT', `策略存储损坏：${detail}`)
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    corrupt('文件内容必须是对象')
  }
  return value as Record<string, unknown>
}

export const accountPriorityCodec: JsonCodec<AccountPrioritySnapshot> = {
  encode(value) {
    return {
      version: SNAPSHOT_VERSION,
      defaultStrategy: value.defaultStrategy,
      strategies: value.strategies,
    }
  },

  decode(raw) {
    const source = asObject(raw)
    if (source.version !== SNAPSHOT_VERSION) {
      corrupt(`版本必须是 ${SNAPSHOT_VERSION}，收到 ${String(source.version)}`)
    }
    try {
      const collection = validateStrategyCollection(source.strategies, source.defaultStrategy, {
        code: 'ACCOUNT_PRIORITY_STORE_CORRUPT',
        label: '策略存储',
      })
      return {
        version: SNAPSHOT_VERSION,
        defaultStrategy: collection.defaultStrategy,
        strategies: collection.strategies,
      }
    } catch (error) {
      if (isAccountPriorityError(error)) throw error
      corrupt(error instanceof Error ? error.message : String(error))
    }
  },
}

export function createAccountPriorityStore(path: string | undefined): JsonStore<AccountPrioritySnapshot> {
  return path === undefined
    ? memoryStore(emptySnapshot)
    : jsonFileStore(path, accountPriorityCodec, emptySnapshot)
}
