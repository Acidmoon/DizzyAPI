/**
 * 运行期服务解析（结构面）。
 *
 * 本插件**不 inject** `apiKey` / `credentials` / `modelhub`（D5）：它们被禁用时
 * 本插件不跟着 PENDING，而是把「探测停摆的原因」摆到 `status()` 上 ——
 * 静默不探测和「模型全挂了」在页面上长得一模一样，必须能区分。
 *
 * 每个解析器都做两件事：确认目标 fiber 处于 ACTIVE、确认它真的有我们要的那个方法。
 * 只做前者不够：服务注册与 `[Service.init]` 完成之间有一段时间服务对象在但状态没就绪。
 */
import { FiberState, type Context } from 'cordis'
import type { ApiKeySeam, CredentialsSeam } from './probe-key.ts'

/** 模型目录的结构面（`modelhub` 的只读服务）。 */
export interface ModelHubSeam {
  catalog(query?: Readonly<Record<string, never>>): {
    readonly available: readonly { readonly model: string; readonly accountCount: number }[]
    readonly unavailable: readonly { readonly model: string; readonly accountCount: number }[]
  }
}

/** 按名字取一个 ACTIVE 的服务实现；不在 / 未激活 / 形状不符都返回 undefined。 */
function activeImpl(ctx: Context, name: string): unknown {
  const impl = ctx.root.reflect._getImpl(name, false)
  if (impl === undefined || impl.ctx.fiber.state !== FiberState.ACTIVE) return undefined
  return impl.value
}

export function modelHubSeam(ctx: Context): ModelHubSeam | undefined {
  const value = activeImpl(ctx, 'modelhub') as Partial<ModelHubSeam> | undefined
  return typeof value?.catalog === 'function' ? (value as ModelHubSeam) : undefined
}

export function apiKeySeam(ctx: Context): ApiKeySeam | undefined {
  const value = activeImpl(ctx, 'apiKey') as Partial<ApiKeySeam> | undefined
  return typeof value?.create === 'function' ? (value as ApiKeySeam) : undefined
}

export function credentialsSeam(ctx: Context): CredentialsSeam | undefined {
  const value = activeImpl(ctx, 'credentials') as Partial<CredentialsSeam> | undefined
  return typeof value?.resolve === 'function' ? (value as CredentialsSeam) : undefined
}
