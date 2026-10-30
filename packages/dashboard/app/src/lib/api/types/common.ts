/**
 * 与业务无关的公共形状：错误信封、设置、插件目录、健康。
 *
 * 能 import 的**一律 import**（`packages/api/src/types.ts` 是纯类型文件，
 * 前端 `import type` 不产生运行时依赖），不手抄。
 */
import type { CatalogModuleView, GatewayHealthView } from '@dizzyapi/plugin-api/types'

export type { CatalogModuleView, GatewayComponentHealth, GatewayHealthState, GatewayHealthView } from '@dizzyapi/plugin-api/types'

/** 健康检查的响应（服务端就是 `GatewayHealthView`，直接复用）。 */
export type HealthView = GatewayHealthView

/** 错误信封（服务端 `respondError` 的形状；405 / 404 / 403 也走这里）。 */
export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly requestId: string
  }
}

/**
 * `GET /api/settings` 的一个字段。
 *
 * `type` 是服务端 schema 里的控件类型（`string` / `number` / `boolean` / `enum` …），
 * `writable` 为假表示改不了（来自 `app.yml` 基线）。
 */
export interface SettingsFieldView {
  readonly key: string
  readonly label: string
  readonly type: string
  readonly value: unknown
  readonly writable: boolean
}

/** `GET /api/settings` 的一个命名空间。 */
export interface SettingsNamespaceView {
  readonly id: string
  readonly title: string
  readonly fields: readonly SettingsFieldView[]
}

/** `GET /api/settings` 的响应。 */
export interface SettingsView {
  readonly namespaces: readonly SettingsNamespaceView[]
}

/** `GET /api/catalog/modules` 的响应（管理员）。 */
export interface CatalogModulesView {
  readonly generatedAt: string
  readonly modules: readonly CatalogModuleView[]
}
