import type { Context, Fiber } from 'cordis'
import { FiberState } from 'cordis'
import type { Entry } from '@cordisjs/plugin-loader'
import type { FieldSpec } from '@dizzyapi/plugin-kit'
import { isPlainObject } from './merge.ts'

/**
 * 一个「可以设的东西」：插件树里的一个 entry。
 *
 * 命名空间用 `entry.options.id`（如 `mailer`），**不是** `entry.id`：
 * 后者在嵌套树里会带上父级前缀（`development:hmr`），对人的稳定身份是前者。
 */
export interface Target {
  readonly ns: string
  readonly plugin: string
  readonly entry: Entry
  readonly fiber: Fiber | undefined
  /** 基线：app.yml 里人写的 config。设置插件只覆盖它，绝不改写它。 */
  readonly baseline: Record<string, unknown>
  /** 目标插件在 schema 上声明的字段元数据；没有就是空数组（＝整个配置面只读）。 */
  readonly fields: readonly FieldSpec[]
  readonly active: boolean
  readonly disabled: boolean
}

export function discoverTargets(ctx: Context): Target[] {
  const targets: Target[] = []
  for (const entry of ctx.loader.entries()) {
    const target = toTarget(entry)
    if (target !== undefined) targets.push(target)
  }
  return targets
}

export function findTarget(ctx: Context, ns: string): Target | undefined {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.id !== ns) continue
    return toTarget(entry)
  }
  return undefined
}

function toTarget(entry: Entry): Target | undefined {
  // group 自己没有配置面（它的 config 是子 entry 列表），不是命名空间
  if (entry.subgroup !== undefined || entry.options.group) return undefined

  const fiber = entry.fiber
  const schema = fiber?.runtime?.Config as { fields?: readonly FieldSpec[] } | undefined
  // 没有 Config 的 entry 没有可设的东西（loader / include 这类基础设施）。
  // 例外：**被禁用的**要留着——被禁用不等于不存在，报「被禁用了」才对得上用户的处境，
  // 也更接近真实原因（配置改了也不会应用）。
  if (schema === undefined && !entry.disabled) return undefined

  return {
    ns: entry.options.id,
    plugin: entry.options.name,
    entry,
    fiber,
    baseline: isPlainObject(entry.options.config) ? { ...entry.options.config } : {},
    fields: schema?.fields ?? [],
    active: fiber?.state === FiberState.ACTIVE,
    disabled: entry.disabled,
  }
}
