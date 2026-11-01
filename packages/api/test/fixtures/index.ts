/**
 * 测试夹具的统一入口（从 `test/fixtures.ts` 按域拆出，§5.6）。
 *
 * 各假端口在 `fixtures/<域>.ts`；这里是装配点：`createFixture()` 把它们拼成 `ApiRuntime`。
 * 用例只 import 这个文件的 `createFixture` / `Fixture` / `FixtureOptions`。
 */
import { rm } from 'node:fs/promises'
import type { ApiRuntime, FrontendPageLike } from '../../src/types.ts'
import { DomainError, resolvedConfig } from './support.ts'
import { FakeUser, FakeAuth } from './session.ts'
import { createFakeFrontend, FakeCatalog, type FakeFrontend } from './catalog.ts'
import { FakeAccountAdmin } from './accounts.ts'
import { FakeSettings } from './settings.ts'
import { FakeApiKey } from './keys.ts'
import { FakeAccountPriority, FakeUsage } from './usage.ts'
import { FakePricing } from './pricing.ts'
import { FakeRedeem, FakeBilling, FakeTopup } from './commerce.ts'
import { FakeModelHub } from './modelhub.ts'
import { FakeAudit, FakeContentAudit } from './audit.ts'
import { FakeClientMask } from './client-mask.ts'
import { FakeObservability, sampleObservabilityReport } from './observability.ts'

export { DomainError, resolvedConfig } from './support.ts'
export { FakeUser, FakeAuth } from './session.ts'
export { createFakeFrontend, FakeCatalog } from './catalog.ts'
export type { FakeFrontend } from './catalog.ts'
export { FakeAccountAdmin } from './accounts.ts'
export { FakeSettings } from './settings.ts'
export { FakeApiKey } from './keys.ts'
export { FakeAccountPriority, FakeUsage } from './usage.ts'
export { FakePricing } from './pricing.ts'
export { FakeRedeem, FakeBilling, FakeTopup } from './commerce.ts'
export { FakeModelHub } from './modelhub.ts'
export { FakeAudit, FakeContentAudit } from './audit.ts'
export { FakeClientMask } from './client-mask.ts'
export { FakeObservability, sampleObservabilityReport } from './observability.ts'

export interface Fixture {
  readonly runtime: ApiRuntime
  readonly user: FakeUser
  readonly auth: FakeAuth
  readonly frontend: FakeFrontend
  readonly catalog: FakeCatalog
  readonly accountAdmin: FakeAccountAdmin
  readonly settings: FakeSettings
  readonly apiKey: FakeApiKey
  readonly priority: FakeAccountPriority
  readonly usage: FakeUsage
  readonly pricing: FakePricing
  readonly redeem: FakeRedeem
  readonly billing: FakeBilling
  readonly topup: FakeTopup
  readonly modelhub: FakeModelHub
  readonly audit: FakeAudit
  readonly observability: FakeObservability
  readonly contentAudit: FakeContentAudit
  readonly clientMask: FakeClientMask
  readonly cleanup: () => Promise<void>
}

export interface FixtureOptions {
  readonly config?: Record<string, unknown>
  readonly withApiKey?: boolean
  readonly withSettings?: boolean
  readonly withoutFrontend?: boolean
  /** 模拟新前端 web 在跑（旧 SPA 缺失时健康检查不再报 degraded）。 */
  readonly withWeb?: boolean
  readonly withoutCatalog?: boolean
  readonly withoutAccountAdmin?: boolean
  readonly withoutPriority?: boolean
  readonly withoutUsage?: boolean
  readonly withoutPricing?: boolean
  readonly withoutRedeem?: boolean
  readonly withoutBilling?: boolean
  readonly withoutTopup?: boolean
  readonly withoutModelHub?: boolean
  readonly withoutAudit?: boolean
  readonly withoutObservability?: boolean
  readonly withoutContentAudit?: boolean
  readonly withoutClientMask?: boolean
  readonly pages?: FrontendPageLike[]
}

export async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const user = new FakeUser()
  const auth = new FakeAuth(user)
  const frontend = await createFakeFrontend(options.pages ?? [])
  const catalog = new FakeCatalog()
  const accountAdmin = new FakeAccountAdmin()
  const settings = new FakeSettings()
  const apiKey = new FakeApiKey()
  const priority = new FakeAccountPriority()
  const usage = new FakeUsage()
  const pricing = new FakePricing()
  const redeem = new FakeRedeem()
  const billing = new FakeBilling()
  const topup = new FakeTopup()
  const modelhub = new FakeModelHub()
  const audit = new FakeAudit()
  const observability = new FakeObservability()
  const contentAudit = new FakeContentAudit()
  const clientMask = new FakeClientMask()

  const runtime: ApiRuntime = {
    config: resolvedConfig(options.config),
    user,
    auth,
    frontend: () => (options.withoutFrontend === true ? undefined : frontend),
    web: () => options.withWeb === true ? {} : undefined,
    catalog: () => (options.withoutCatalog === true ? undefined : catalog),
    accountAdmin: () => (options.withoutAccountAdmin === true ? undefined : accountAdmin),
    settings: () => (options.withSettings === false ? undefined : settings),
    apiKey: () => (options.withApiKey === false ? undefined : apiKey),
    accountPriority: () => (options.withoutPriority === true ? undefined : priority),
    usage: () => (options.withoutUsage === true ? undefined : usage),
    pricing: () => (options.withoutPricing === true ? undefined : pricing),
    redeem: () => (options.withoutRedeem === true ? undefined : redeem),
    billing: () => (options.withoutBilling === true ? undefined : billing),
    topup: () => (options.withoutTopup === true ? undefined : topup),
    modelhub: () => (options.withoutModelHub === true ? undefined : modelhub),
    audit: () => (options.withoutAudit === true ? undefined : audit),
    observability: () => (options.withoutObservability === true ? undefined : observability),
    contentAudit: () => (options.withoutContentAudit === true ? undefined : contentAudit),
    clientMask: () => (options.withoutClientMask === true ? undefined : clientMask),
    now: () => new Date('2026-10-19T12:00:00.000Z'),
    uptimeSec: () => 42,
    log: () => undefined,
  }

  return {
    runtime,
    user,
    auth,
    frontend,
    catalog,
    accountAdmin,
    settings,
    apiKey,
    priority,
    usage,
    pricing,
    redeem,
    billing,
    topup,
    modelhub,
    audit,
    observability,
    contentAudit,
    clientMask,
    async cleanup() {
      await rm(frontend.root, { recursive: true, force: true })
    },
  }
}
