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
 * **形状依据服务端**：`packages/settings/src/service.ts` 的 `SettingsFieldView`
 * （`buildFieldViews()` 产出，`api` 插件的 `routes/settings.ts` 原样透传）。
 *
 * 注意与服务端**逐字对应**的几点（前端原先写错了，`管理台` 那批踩到）：
 * - 键名是 **`path`**（点分路径，如 `smtp.host`），不是 `key`；
 * - 控件类型是 **`kind`**（`string` / `number` / `boolean` / `enum` / `secret` …），不是 `type`；
 * - **没有** `value` 这个必填键：值是秘密的字段**根本没有** `value` 键，
 *   只有 `configured`（配没配）；`object` 字段的值放在 `children` 里。
 */
/** 设置字段的控件类型（`packages/kit/src/schema.ts` 的 `FieldKind`）。 */
export type SettingsFieldKind = 'string' | 'boolean' | 'integer' | 'enum' | 'stringArray' | 'object'

export interface SettingsFieldView {
  /** 点分路径，如 `smtp.host`。 */
  readonly path: string
  readonly label: string
  /** 控件类型（服务端 `FieldKind`）。 */
  readonly kind: SettingsFieldKind
  /** 来自 `app.yml` 基线的字段不可写。 */
  readonly writable: boolean
  /** 值是秘密：**没有** `value` 键，只有 `configured`。 */
  readonly secret: boolean
  /** 值是凭据引用名（不是秘密本体），可以显示。 */
  readonly credentialRef: boolean
  /** 枚举字段的可选值。 */
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly unit?: string
  /** 当前配置里的值；`secret` 与 `object` 字段没有这个键。 */
  readonly value?: unknown
  /** 只有 `secret` 字段有：眼下到底配了没有（永远不告诉你配的是什么）。 */
  readonly configured?: boolean
  /** 只有 `object` 字段有：子字段。 */
  readonly children?: readonly SettingsFieldView[]
}

/**
 * `GET /api/settings` 的一个命名空间。
 *
 * **形状依据服务端**：`packages/settings/src/service.ts` 的 `SettingsNamespaceView`。
 * 服务端给的是 `ns`（命名空间 id）、`plugin`、`active` / `disabled` / `writable` /
 * `overridden`、`revision` / `updatedAt`、`pending` / `pendingReason` —— **没有** `id` / `title`。
 */
export interface SettingsNamespaceView {
  /** 命名空间 id（entry 的 id）。 */
  readonly ns: string
  /** 所属插件名。 */
  readonly plugin: string
  /** 插件此刻是否在运行。 */
  readonly active: boolean
  /** 插件是否被禁用。 */
  readonly disabled: boolean
  /** 有没有可写字段。没有的话，这个命名空间只是「只读可见」。 */
  readonly writable: boolean
  /** 有没有覆盖。 */
  readonly overridden: boolean
  readonly revision: string | null
  readonly updatedAt: string | null
  /** 有覆盖，却因为目标缺失 / 被禁用 / 尚未装载而没能应用。 */
  readonly pending: boolean
  readonly pendingReason?: 'missing' | 'disabled' | 'inactive'
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
