/**
 * 账号管理相关的接口形状（从 `types.ts` 搬出，理由见文件尾注释）。
 *
 * 拆出来的原因：`types.ts` 早已超过 §5.6 的 500 行上限、只许缩短；这一批要给
 * `AccountViewLike` 增加 `clientProfile`（客户端指纹档案 id），按纪律**先把同职责的一块搬出来再加**。
 * 搬法与 `types-usage.ts` 一致：本文件声明，`types.ts` 原处 `export *` 再导出，
 * 既有 `from './types.ts'` 的 import 一个都不用改。
 */
// ───────────────────────────── 账号管理 ─────────────────────────────

export interface AccountViewLike {
  readonly id: string
  readonly provider: string
  readonly kind: string
  readonly label: string
  readonly enabled: boolean
  readonly status: string
  readonly email: string | null
  readonly subject: string | null
  readonly baseUrl: string | null
  readonly protocol: string | null
  readonly models: string[] | null
  readonly modelMap: Record<string, string> | null
  readonly priority: number
  /**
   * 客户端指纹档案 id（`packages/client-mask` 的档案）；`null` = 不伪装。
   * **只是 id**：真实的头由 account-priority 在推快照时解析，HTTP 层不展开。
   */
  readonly clientProfile: string | null
  readonly accessExpiresAt: string | null
  readonly refreshDueAt: string | null
  readonly lastRefreshAt: string | null
  readonly lastError: string | null
  readonly failureCount: number
  readonly backoffUntil: string | null
  readonly lastTestAt: string | null
  readonly lastTestOk: boolean | null
  readonly lastTestError: string | null
  readonly lastTestLatencyMs: number | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AccountAdminQueryLike {
  readonly provider?: string
  readonly status?: string
  readonly cursor?: string
  readonly limit?: number
}

export interface AccountAdminPort {
  list(query?: AccountAdminQueryLike): readonly AccountViewLike[] | Promise<readonly AccountViewLike[]>
  get(id: string): AccountViewLike | Promise<AccountViewLike>
  create?(actor: string, input: unknown): Promise<unknown>
  update(
    actor: string,
    id: string,
    patch: {
      label?: string
      email?: string | null
      subject?: string | null
      baseUrl?: string | null
      protocol?: string | null
      models?: string[] | null
      modelMap?: Record<string, string> | null
      priority?: number
      /** 客户端指纹档案 id；`null` = 清空（不伪装）。 */
      clientProfile?: string | null
    },
  ): Promise<unknown>
  enable(actor: string, id: string): Promise<unknown>
  disable(actor: string, id: string): Promise<unknown>
  remove(actor: string, id: string): Promise<unknown>
  importCredentials?(actor: string, id: string, input: unknown): Promise<unknown>
  importAccounts?(actor: string, input: unknown): Promise<unknown>
  previewImport?(input: unknown): unknown
  /** 连通性测试：不发秘密、不回显秘密；返回状态码与耗时。 */
  testConnection?(id: string, input: { model?: string; protocol?: string }): Promise<AccountTestResultLike>
  /** 导入来源预检：逐条归一化，不含凭据。 */
  previewImportSource?(input: unknown): unknown
  /** 导入来源批量创建：部分成功，逐条返回结果。 */
  importSource?(actor: string, input: unknown): Promise<unknown>
}

export interface AccountTestResultLike {
  readonly ok: boolean
  readonly status: number | null
  readonly latencyMs: number
  readonly model: string | null
  readonly protocol: string | null
  readonly error: string | null
  readonly testedAt: string
}

// 注意：本文件**不 import** `types.ts`，避免两个类型文件互相引用。
// `types.ts` 用 `export * from './types-accounts.ts'` + 单独 `import type { AccountAdminPort }` ——
// 再导出不会把名字带进 `types.ts` 的作用域，所以那一行 import 是必须的（与 `types-usage.ts` 同一套路）。
