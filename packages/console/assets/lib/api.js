/**
 * 浏览器侧 API 客户端。
 *
 * 两套实现共用 `FrontendApis` 契约（见 src/contracts.ts）：
 * - `createHttpApis()`：同源 REST，cookie 会话，不把令牌放进 URL / localStorage；
 * - `createMockApis()`：纯内存假数据，用于开发预览与测试，不需要后端。
 *
 * 账号 DTO 永远不含 token / credentialRef；设置里的秘密字段只有 `configured`。
 * 这是前端不接触秘密的结构性保证，不是靠调用方自觉。
 */

/** @typedef {import('../../src/contracts.ts').FrontendApis} FrontendApis */
/** @typedef {import('../../src/contracts.ts').AccountSummary} AccountSummary */
/** @typedef {import('../../src/contracts.ts').AccountListQuery} AccountListQuery */
/** @typedef {import('../../src/contracts.ts').AccountListResponse} AccountListResponse */
/** @typedef {import('../../src/contracts.ts').AccountUpdateInput} AccountUpdateInput */
/** @typedef {import('../../src/contracts.ts').CreateAccountInput} CreateAccountInput */
/** @typedef {import('../../src/contracts.ts').ImportAccountCredentialsInput} ImportAccountCredentialsInput */
/** @typedef {import('../../src/contracts.ts').CredentialImportPreview} CredentialImportPreview */
/** @typedef {import('../../src/contracts.ts').CatalogResponse} CatalogResponse */
/** @typedef {import('../../src/contracts.ts').SettingsDescribeResponse} SettingsDescribeResponse */
/** @typedef {import('../../src/contracts.ts').SettingsNamespaceView} SettingsNamespaceView */
/** @typedef {import('../../src/contracts.ts').SettingsFieldView} SettingsFieldView */
/** @typedef {import('../../src/contracts.ts').SettingsPatch} SettingsPatch */
/** @typedef {import('../../src/contracts.ts').GatewayHealth} GatewayHealth */
/** @typedef {import('../../src/contracts.ts').ConsoleManifestResponse} ConsoleManifestResponse */
/** @typedef {import('../../src/contracts.ts').UsageResponse} UsageResponse */
/** @typedef {import('../../src/contracts.ts').UsageQuery} UsageQuery */
/** @typedef {import('../../src/contracts.ts').UsageDailyPoint} UsageDailyPoint */
/** @typedef {import('../../src/contracts.ts').UsageTotals} UsageTotals */
/** @typedef {import('../../src/contracts.ts').ApiKeySummary} ApiKeySummary */
/** @typedef {import('../../src/contracts.ts').ApiKeyListResponse} ApiKeyListResponse */
/** @typedef {import('../../src/contracts.ts').CreatedApiKey} CreatedApiKey */
/** @typedef {import('../../src/contracts.ts').TopupOptions} TopupOptions */
/** @typedef {import('../../src/contracts.ts').TopupOrder} TopupOrder */
/** @typedef {import('../../src/contracts.ts').TopupOrderInput} TopupOrderInput */

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, requestId?: string | null, details?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'ApiError'
    /** @type {number} */
    this.status = options.status ?? 0
    /** @type {string} */
    this.code = options.code ?? 'API_ERROR'
    /** @type {string | null} */
    this.requestId = options.requestId ?? null
    /** @type {unknown} */
    this.details = options.details
  }
}

/** @param {unknown} error @returns {error is ApiError} */
export function isApiError(error) {
  return error instanceof ApiError
}

/**
 * @typedef {{
 *   baseUrl?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   headers?: Readonly<Record<string, string>>,
 * }} HttpOptions
 * @typedef {{
 *   method?: string,
 *   query?: Readonly<Record<string, string | number | boolean | null | undefined>>,
 *   body?: unknown,
 *   signal?: AbortSignal,
 *   headers?: Readonly<Record<string, string>>,
 * }} RequestOptions
 * @typedef {(path: string, options?: RequestOptions) => Promise<any>} RequestFunction
 */

/**
 * @param {HttpOptions} [options]
 * @returns {RequestFunction}
 */
export function createHttpTransport(options = {}) {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  // 所有 /api/* 都要求这个自定义头；统一在 transport 里加，避免每个调用点各写一遍。
  // 自定义头会让浏览器先发预检，而网关不发任何 CORS 头，跨站页面因此发不出请求。
  const defaultHeaders = { 'X-Requested-With': 'dizzyapi', ...(options.headers ?? {}) }

  return async (path, request = {}) => {
    const url = withQuery(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`, request.query)
    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/json', ...defaultHeaders, ...(request.headers ?? {}) }
    const hasBody = request.body !== undefined
    if (hasBody) headers['Content-Type'] = 'application/json'

    const controller = new AbortController()
    let timedOut = false
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort()
          }, timeoutMs)
        : undefined
    const external = request.signal
    const onAbort = () => controller.abort()
    if (external !== undefined) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', onAbort, { once: true })
    }

    let response
    try {
      response = await fetchImpl(url, {
        method: request.method ?? 'GET',
        headers,
        body: hasBody ? JSON.stringify(request.body) : undefined,
        credentials: 'same-origin',
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut) throw new ApiError(`请求超时（${timeoutMs}ms）：${url}`, { code: 'TIMEOUT' })
      if (external?.aborted) throw new ApiError('请求已取消', { code: 'ABORTED' })
      throw new ApiError(`网络错误：${error instanceof Error ? error.message : String(error)}`, {
        code: 'NETWORK_ERROR',
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    }

    const text = await response.text()
    const data = parseBody(text, response.headers.get('content-type'))
    if (!response.ok) {
      const detail = asRecord(data)
      const error = asRecord(detail?.error)
      throw new ApiError(
        typeof error?.message === 'string'
          ? error.message
          : typeof detail?.message === 'string'
            ? detail.message
            : `${response.status} ${response.statusText}`,
        {
          status: response.status,
          code:
            typeof error?.code === 'string'
              ? error.code
              : typeof detail?.code === 'string'
                ? detail.code
                : `HTTP_${response.status}`,
          requestId: response.headers.get('x-request-id'),
          details: data,
        },
      )
    }
    return data
  }
}

/**
 * @param {HttpOptions} [options]
 * @returns {FrontendApis}
 */
export function createHttpApis(options = {}) {
  const request = createHttpTransport(options)
  return {
    session: {
      /** @returns {Promise<import('../../src/contracts.ts').SessionResponse>} */
      get: () => request('/session'),
      /**
       * @param {{ email: string, password: string }} input
       * @returns {Promise<import('../../src/contracts.ts').LoginResponse>}
       */
      login: (input) => request('/auth/login', { method: 'POST', body: input }),
      /** @returns {Promise<void>} */
      logout: async () => {
        await request('/auth/logout', { method: 'POST' })
      },
      /**
       * @param {{ email: string, password: string, name?: string }} input
       * @returns {Promise<import('../../src/contracts.ts').AuthTicket>}
       */
      registerRequest: (input) => request('/auth/register/request', { method: 'POST', body: input }),
      /**
       * @param {{ email: string, code: string }} input
       * @returns {Promise<import('../../src/contracts.ts').LoginResponse>}
       */
      registerConfirm: (input) => request('/auth/register/confirm', { method: 'POST', body: input }),
      /**
       * @param {{ email: string }} input
       * @returns {Promise<import('../../src/contracts.ts').AuthTicket>}
       */
      requestPasswordReset: (input) => request('/auth/password/reset/request', { method: 'POST', body: input }),
      /**
       * @param {{ email: string, code: string, password: string }} input
       * @returns {Promise<{ userId: number, revokedSessions: number }>}
       */
      confirmPasswordReset: (input) => request('/auth/password/reset/confirm', { method: 'POST', body: input }),
      /**
       * @param {{ name?: string, avatar?: string | null }} patch
       * @returns {Promise<import('../../src/contracts.ts').SessionUser>}
       */
      updateProfile: (patch) => request('/profile', { method: 'PATCH', body: patch }),
      /**
       * @param {{ currentPassword: string, newPassword: string }} input
       * @returns {Promise<{ revokedSessions: number }>}
       */
      changePassword: (input) => request('/profile/password', { method: 'POST', body: input }),
    },
    users: {
      /**
       * @param {{ status?: 'enabled' | 'banned', offset?: number, limit?: number }} [query]
       * @returns {Promise<import('../../src/contracts.ts').AdminUserListResponse>}
       */
      list: (query = {}) =>
        request('/users', { query: { status: query.status, offset: query.offset, limit: query.limit } }),
      /** @param {number} id @returns {Promise<import('../../src/contracts.ts').AdminUserSummary>} */
      get: (id) => request(`/users/${id}`),
      /**
       * @param {number} id
       * @param {import('../../src/contracts.ts').AdminUserUpdateInput} patch
       * @returns {Promise<import('../../src/contracts.ts').AdminUserSummary>}
       */
      update: (id, patch) => request(`/users/${id}`, { method: 'PATCH', body: patch }),
      /** @param {number} id @returns {Promise<{ removed: true }>} */
      remove: (id) => request(`/users/${id}`, { method: 'DELETE' }),
      /**
       * @param {number} id
       * @param {import('../../src/contracts.ts').AdminBalanceInput} input
       * @returns {Promise<{ balanceMinor: string }>}
       */
      adjustBalance: (id, input) =>
        request(`/users/${id}/balance`, {
          method: 'POST',
          body: { delta: input.deltaMinor, reason: input.reason },
        }),
    },
    accounts: {
      /** @param {AccountListQuery} [query] @returns {Promise<AccountListResponse>} */
      list: (query = {}) =>
        request('/accounts', {
          query: {
            provider: query.provider,
            status: query.status,
            cursor: query.cursor,
            limit: query.limit,
          },
        }),
      /** @param {string} id @returns {Promise<AccountSummary>} */
      get: (id) => request(`/accounts/${encodeURIComponent(id)}`),
      /** @param {CreateAccountInput} input @returns {Promise<AccountSummary>} */
      create: (input) => request('/accounts', { method: 'POST', body: input }),
      /** @param {string} id @param {AccountUpdateInput} patch @returns {Promise<AccountSummary>} */
      update: (id, patch) => request(`/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
      /** @param {string} id @returns {Promise<{ removed: true }>} */
      remove: (id) => request(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      /**
       * @param {string} id
       * @param {ImportAccountCredentialsInput} input
       * @returns {Promise<AccountSummary>}
       */
      importCredentials: (id, input) =>
        request(`/accounts/${encodeURIComponent(id)}/credentials`, { method: 'POST', body: input }),
      /**
       * @param {ImportAccountCredentialsInput} input
       * @returns {Promise<CredentialImportPreview>}
       */
      previewImport: (input) => request('/accounts/import/preview', { method: 'POST', body: input }),
      /**
       * @param {string} id
       * @param {import('../../src/contracts.ts').AccountTestInput} [input]
       * @returns {Promise<import('../../src/contracts.ts').AccountTestResult>}
       */
      test: (id, input = {}) =>
        request(`/accounts/${encodeURIComponent(id)}/test`, { method: 'POST', body: input }),
      /**
       * @param {import('../../src/contracts.ts').AccountImportSourceInput} input
       * @returns {Promise<import('../../src/contracts.ts').AccountImportPreview>}
       */
      previewImportSource: (input) => request('/accounts/import/preview', { method: 'POST', body: input }),
      /**
       * @param {import('../../src/contracts.ts').AccountImportSourceInput} input
       * @returns {Promise<import('../../src/contracts.ts').AccountImportResult>}
       */
      importSource: (input) => request('/accounts/import', { method: 'POST', body: input }),
    },
    catalog: {
      /** @returns {Promise<CatalogResponse>} */
      list: () => request('/catalog/modules'),
    },
    settings: {
      /** @returns {Promise<SettingsDescribeResponse>} */
      describe: () => request('/settings'),
      /**
       * @param {string} ns
       * @param {SettingsPatch} patch
       * @param {string} [expectedRevision]
       * @returns {Promise<SettingsNamespaceView>}
       */
      update: (ns, patch, expectedRevision) =>
        request(`/settings/${encodeURIComponent(ns)}`, {
          method: 'POST',
          body: expectedRevision === undefined ? { patch } : { patch, expectedRevision },
        }),
      /** @param {string} ns @returns {Promise<SettingsNamespaceView>} */
      reset: (ns) => request(`/settings/${encodeURIComponent(ns)}`, { method: 'DELETE' }),
    },
    health: {
      /** @returns {Promise<GatewayHealth>} */
      get: () => request('/health'),
    },
    usage: {
      /** @param {UsageQuery} query @returns {Promise<UsageResponse>} */
      get: (query) =>
        request('/usage', {
          query: {
            range: query.range,
            apiKeyId: query.apiKeyId,
            model: query.model,
            cursor: query.cursor,
            limit: query.limit,
          },
        }),
      /** @param {UsageQuery} query @returns {Promise<{ filename: string, content: string }>} */
      exportCsv: (query) =>
        request('/usage/export', {
          query: { format: 'csv', range: query.range, apiKeyId: query.apiKeyId, model: query.model },
        }),
    },
    adminUsage: {
      /** @param {import('../../src/contracts.ts').AdminUsageQuery} query */
      list: (query) =>
        request('/admin/usage', {
          query: {
            range: query.range,
            userId: query.userId,
            apiKeyId: query.apiKeyId,
            model: query.model,
            status: query.status,
            cursor: query.cursor,
            limit: query.limit,
          },
        }),
      /** @param {import('../../src/contracts.ts').AdminUsageQuery} query */
      exportCsv: (query) =>
        request('/admin/usage/export', {
          query: {
            format: 'csv',
            range: query.range,
            userId: query.userId,
            apiKeyId: query.apiKeyId,
            model: query.model,
            status: query.status,
          },
        }),
    },
    stats: {
      /** @returns {Promise<import('../../src/contracts.ts').GatewayStats>} */
      get: () => request('/admin/stats'),
    },
    pricing: {
      /** @returns {Promise<import('../../src/contracts.ts').PricingListResponse>} */
      list: () => request('/pricing'),
      /** @param {string} model */
      get: (model) => request(`/pricing/${encodeURIComponent(model)}`),
      /** @param {string} model @param {import('../../src/contracts.ts').ModelPriceInput} input */
      set: (model, input) => request(`/pricing/${encodeURIComponent(model)}`, { method: 'PUT', body: input }),
      /** @param {string} model */
      remove: (model) => request(`/pricing/${encodeURIComponent(model)}`, { method: 'DELETE' }),
    },
    keys: {
      /** @returns {Promise<ApiKeyListResponse>} */
      list: () => request('/keys'),
      /** @param {{ name: string }} input @returns {Promise<CreatedApiKey>} */
      create: (input) => request('/keys', { method: 'POST', body: input }),
      /**
       * @param {string} id
       * @param {import('../../src/contracts.ts').UpdateApiKeyInput} input
       * @returns {Promise<ApiKeySummary>}
       */
      update: (id, input) => request(`/keys/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
      /** @param {string} id @returns {Promise<{ removed: true }>} */
      remove: (id) => request(`/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      /** @param {string} id @returns {Promise<CreatedApiKey>} */
      rotate: (id) => request(`/keys/${encodeURIComponent(id)}/rotate`, { method: 'POST' }),
    },
    topup: {
      /** @returns {Promise<TopupOptions>} */
      options: () => request('/topup/options'),
      /** @param {TopupOrderInput} input @returns {Promise<TopupOrder>} */
      createOrder: (input) => request('/topup/orders', { method: 'POST', body: input }),
    },
    console: {
      /** @returns {Promise<ConsoleManifestResponse>} */
      manifest: () => request('/console/manifest'),
    },
  }
}

/**
 * 纯内存 mock。数据形状与真实 REST 完全一致；延迟可设为 0 让测试同步感更强。
 * @param {{ latencyMs?: number, now?: () => Date }} [options]
 * @returns {FrontendApis}
 */
export function createMockApis(options = {}) {
  const latencyMs = Math.max(0, options.latencyMs ?? 120)
  const now = options.now ?? (() => new Date())
  const state = createMockState(now)
  const wait = () =>
    latencyMs === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, latencyMs))
  const stamp = () => now().toISOString()

  const sessionInfo = () => {
    const at = now().toISOString()
    return {
      id: 'mock-session',
      createdAt: at,
      expiresAt: new Date(now().getTime() + 7 * 86_400_000).toISOString(),
      lastSeenAt: at,
    }
  }

  /** 用户表单是唯一写者；会话用户只是它的一份视图，改完要重算余额可见性。 */
  const syncSessionUser = () => {
    const record = state.users.find((item) => item.id === state.sessionUser.id)
    if (record === undefined) return
    state.sessionUser = {
      ...state.sessionUser,
      name: record.name,
      status: record.status,
      role: record.role,
      balanceEnabled: record.balanceEnabled,
      balanceCents:
        record.role === 'admin' || record.balanceEnabled ? centsOfMinor(record.balanceMinor) : null,
      updatedAt: stamp(),
    }
  }

  return {
    session: {
      /** @returns {Promise<import('../../src/contracts.ts').SessionResponse>} */
      async get() {
        await wait()
        if (!state.authenticated) {
          throw new ApiError('需要登录后才能访问', { status: 401, code: 'API_UNAUTHORIZED' })
        }
        return {
          user: clone(state.sessionUser),
          email: state.sessionEmail,
          session: sessionInfo(),
          permissions: { admin: state.sessionUser.role === 'admin' },
        }
      },
      /**
       * @param {{ email: string, password: string }} input
       * @returns {Promise<import('../../src/contracts.ts').LoginResponse>}
       */
      async login(input) {
        await wait()
        if (input.email.trim() === '' || input.password === '') {
          throw new ApiError('邮箱或密码错误', { status: 401, code: 'AUTH_CREDENTIALS_INVALID' })
        }
        state.authenticated = true
        state.sessionEmail = input.email.trim()
        syncSessionUser()
        return { user: clone(state.sessionUser), session: sessionInfo() }
      },
      async logout() {
        await wait()
        state.authenticated = false
      },
      /**
       * @param {{ email: string, password: string, name?: string }} input
       * @returns {Promise<import('../../src/contracts.ts').AuthTicket>}
       */
      async registerRequest(input) {
        await wait()
        state.pendingEmail = input.email.trim()
        state.pendingCode = '123456'
        return {
          email: state.pendingEmail,
          expiresAt: new Date(now().getTime() + 600_000).toISOString(),
          resendAfterMs: 60_000,
        }
      },
      /**
       * @param {{ email: string, code: string }} input
       * @returns {Promise<import('../../src/contracts.ts').LoginResponse>}
       */
      async registerConfirm(input) {
        await wait()
        if (input.code.trim() !== state.pendingCode) {
          throw new ApiError('验证码无效或已过期', { status: 401, code: 'AUTH_CODE_INVALID' })
        }
        state.authenticated = true
        state.sessionEmail = input.email.trim() || state.pendingEmail
        syncSessionUser()
        return { user: clone(state.sessionUser), session: sessionInfo() }
      },
      /**
       * @param {{ email: string }} input
       * @returns {Promise<import('../../src/contracts.ts').AuthTicket>}
       */
      async requestPasswordReset(input) {
        await wait()
        state.pendingCode = '654321'
        return {
          email: input.email.trim(),
          expiresAt: new Date(now().getTime() + 600_000).toISOString(),
          resendAfterMs: 60_000,
        }
      },
      /**
       * @param {{ email: string, code: string, password: string }} input
       * @returns {Promise<{ userId: number, revokedSessions: number }>}
       */
      async confirmPasswordReset(input) {
        await wait()
        if (input.code.trim() !== state.pendingCode) {
          throw new ApiError('验证码无效或已过期', { status: 401, code: 'AUTH_CODE_INVALID' })
        }
        return { userId: state.sessionUser.id, revokedSessions: 0 }
      },
      /**
       * @param {{ name?: string, avatar?: string | null }} patch
       * @returns {Promise<import('../../src/contracts.ts').SessionUser>}
       */
      async updateProfile(patch) {
        await wait()
        if (patch.name !== undefined) {
          const name = patch.name.trim()
          if (name === '') throw new ApiError('用户名不能为空', { status: 400, code: 'USER_NAME_INVALID' })
          const record = state.users.find((item) => item.id === state.sessionUser.id)
          if (record !== undefined) record.name = name
          state.sessionUser = { ...state.sessionUser, name, updatedAt: stamp() }
        }
        if (patch.avatar !== undefined) {
          state.sessionUser = { ...state.sessionUser, avatar: patch.avatar, updatedAt: stamp() }
        }
        return clone(state.sessionUser)
      },
      /**
       * @param {{ currentPassword: string, newPassword: string }} input
       * @returns {Promise<{ revokedSessions: number }>}
       */
      async changePassword(input) {
        await wait()
        if (input.currentPassword === '') {
          throw new ApiError('当前密码不正确', { status: 401, code: 'AUTH_CREDENTIALS_INVALID' })
        }
        return { revokedSessions: 0 }
      },
    },
    users: {
      /**
       * @param {{ status?: 'enabled' | 'banned', offset?: number, limit?: number }} [query]
       * @returns {Promise<import('../../src/contracts.ts').AdminUserListResponse>}
       */
      async list(query = {}) {
        await wait()
        const filtered = state.users.filter(
          (user) => query.status === undefined || user.status === query.status,
        )
        const offset = query.offset ?? 0
        const limit = Math.min(Math.max(query.limit ?? 100, 1), 500)
        return { items: clone(filtered.slice(offset, offset + limit)) }
      },
      /** @param {number} id @returns {Promise<import('../../src/contracts.ts').AdminUserSummary>} */
      async get(id) {
        await wait()
        const user = state.users.find((item) => item.id === id)
        if (user === undefined) throw new ApiError('没有这个用户', { status: 404, code: 'USER_NOT_FOUND' })
        return clone(user)
      },
      /**
       * @param {number} id
       * @param {import('../../src/contracts.ts').AdminUserUpdateInput} patch
       * @returns {Promise<import('../../src/contracts.ts').AdminUserSummary>}
       */
      async update(id, patch) {
        await wait()
        const user = state.users.find((item) => item.id === id)
        if (user === undefined) throw new ApiError('没有这个用户', { status: 404, code: 'USER_NOT_FOUND' })
        if (patch.name !== undefined && patch.name.trim() === '') {
          throw new ApiError('用户名不能为空', { status: 400, code: 'USER_NAME_INVALID' })
        }
        Object.assign(user, patch, { updatedAt: stamp() })
        if (user.id === state.sessionUser.id) syncSessionUser()
        return clone(user)
      },
      /** @param {number} id @returns {Promise<{ removed: true }>} */
      async remove(id) {
        await wait()
        const index = state.users.findIndex((item) => item.id === id)
        if (index < 0) throw new ApiError('没有这个用户', { status: 404, code: 'USER_NOT_FOUND' })
        state.users.splice(index, 1)
        return { removed: true }
      },
      /**
       * @param {number} id
       * @param {import('../../src/contracts.ts').AdminBalanceInput} input
       * @returns {Promise<{ balanceMinor: string }>}
       */
      async adjustBalance(id, input) {
        await wait()
        if (!/^-?\d+$/.test(input.deltaMinor)) {
          throw new ApiError('金额必须是整数最小单位', { status: 400, code: 'USER_BALANCE_INVALID' })
        }
        const user = state.users.find((item) => item.id === id)
        if (user === undefined) throw new ApiError('没有这个用户', { status: 404, code: 'USER_NOT_FOUND' })
        user.balanceMinor = (BigInt(user.balanceMinor) + BigInt(input.deltaMinor)).toString()
        user.updatedAt = stamp()
        if (user.id === state.sessionUser.id) syncSessionUser()
        return { balanceMinor: user.balanceMinor }
      },
    },
    accounts: {
      async list(query = {}) {
        await wait()
        const provider = query.provider
        const status = query.status
        const filtered = state.accounts.filter(
          (account) => (provider === undefined || account.provider === provider) && (status === undefined || account.status === status),
        )
        const offset = query.cursor === undefined ? 0 : Number(query.cursor)
        if (!Number.isSafeInteger(offset) || offset < 0) {
          throw new ApiError('cursor 非法', { status: 400, code: 'ACCOUNT_CURSOR_INVALID' })
        }
        const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
        const items = filtered.slice(offset, offset + limit)
        const next = offset + limit < filtered.length ? String(offset + limit) : null
        return { items: clone(items), nextCursor: next }
      },
      async get(id) {
        await wait()
        const account = state.accounts.find((item) => item.id === id)
        if (account === undefined) throw new ApiError(`没有这个账号：${id}`, { status: 404, code: 'ACCOUNT_NOT_FOUND' })
        return clone(account)
      },
      async create(input) {
        await wait()
        if (typeof input.label !== 'string' || input.label.trim() === '') {
          throw new ApiError('label 不能为空', { status: 400, code: 'ACCOUNT_ADMIN_INPUT_INVALID' })
        }
        if (input.provider === 'custom' && input.kind === 'oauth') {
          throw new ApiError('custom provider 只能用于 api_key 账号', { status: 400, code: 'ACCOUNT_ADMIN_INPUT_INVALID' })
        }
        const now = stamp()
        const account = /** @type {AccountSummary} */ ({
          id: `acc_mock_${state.accounts.length + 1}_${Math.random().toString(36).slice(2, 8)}`,
          provider: input.provider,
          kind: input.kind,
          label: input.label.trim(),
          enabled: input.enabled ?? true,
          status: 'active',
          email: input.email ?? null,
          subject: input.subject ?? null,
          baseUrl: input.baseUrl ?? null,
          protocol: input.protocol ?? null,
          models: input.models ?? null,
          modelMap: input.modelMap ?? null,
          priority: input.priority ?? 0,
          accessExpiresAt: null,
          refreshDueAt: null,
          lastRefreshAt: null,
          lastError: null,
          failureCount: 0,
          backoffUntil: null,
          createdAt: now,
          updatedAt: now,
        })
        state.accounts.unshift(account)
        return clone(account)
      },
      async update(id, patch) {
        await wait()
        const account = state.accounts.find((item) => item.id === id)
        if (account === undefined) throw new ApiError(`没有这个账号：${id}`, { status: 404, code: 'ACCOUNT_NOT_FOUND' })
        if (patch.label !== undefined && patch.label.trim() === '') {
          throw new ApiError('label 不能为空', { status: 400, code: 'ACCOUNT_LABEL_INVALID' })
        }
        Object.assign(account, clone(patch), { updatedAt: stamp() })
        return clone(account)
      },
      async remove(id) {
        await wait()
        const index = state.accounts.findIndex((item) => item.id === id)
        if (index < 0) throw new ApiError(`没有这个账号：${id}`, { status: 404, code: 'ACCOUNT_NOT_FOUND' })
        state.accounts.splice(index, 1)
        return { removed: true }
      },
      async importCredentials(id, input) {
        await wait()
        const account = state.accounts.find((item) => item.id === id)
        if (account === undefined) throw new ApiError(`没有这个账号：${id}`, { status: 404, code: 'ACCOUNT_NOT_FOUND' })
        if (input.payload === undefined || input.payload === null || input.payload === '') {
          throw new ApiError('payload 不能为空', { status: 400, code: 'ACCOUNT_ADMIN_INPUT_INVALID' })
        }
        Object.assign(account, { updatedAt: stamp() })
        return clone(account)
      },
      async previewImport(input) {
        await wait()
        if (input.payload === undefined || input.payload === null || input.payload === '') {
          throw new ApiError('payload 不能为空', { status: 400, code: 'ACCOUNT_ADMIN_INPUT_INVALID' })
        }
        return {
          format: 'api-key',
          provider: 'openai',
          kind: 'api_key',
          email: null,
          subject: null,
          expiresAt: null,
          hasAccessToken: false,
          hasRefreshToken: false,
          hasApiKey: true,
        }
      },
      /** @param {string} id */
      async test(id) {
        await wait()
        const account = state.accounts.find((item) => item.id === id)
        if (account === undefined) throw new ApiError(`没有这个账号：${id}`, { status: 404, code: 'ACCOUNT_NOT_FOUND' })
        return {
          ok: true,
          status: 200,
          latencyMs: 180 + ((id.length * 37) % 900),
          model: account.models?.[0] ?? null,
          protocol: account.protocol ?? null,
          error: null,
          testedAt: stamp(),
        }
      },
      /** @param {import('../../src/contracts.ts').AccountImportSourceInput} input */
      async previewImportSource(input) {
        await wait()
        const count = input.source === 'plain-keys' ? Math.max(input.payload.split('\n').filter((line) => line.trim() !== '').length, 1) : 1
        return {
          source: input.source === 'auto' ? 'new-api' : input.source,
          total: count,
          items: Array.from({ length: count }, (_, index) => ({
            index,
            ok: true,
            label: `导入账号 #${index + 1}`,
            provider: input.defaults?.provider ?? 'openai',
            kind: input.defaults?.kind ?? 'api_key',
            baseUrl: input.defaults?.baseUrl ?? null,
            models: null,
            error: null,
          })),
        }
      },
      /** @param {import('../../src/contracts.ts').AccountImportSourceInput} input */
      async importSource(input) {
        await wait()
        const count = input.source === 'plain-keys' ? Math.max(input.payload.split('\n').filter((line) => line.trim() !== '').length, 1) : 1
        return {
          total: count,
          created: count,
          failed: 0,
          items: Array.from({ length: count }, (_, index) => ({
            index,
            ok: true,
            account: null,
            error: null,
          })),
        }
      },
    },
    catalog: {
      async list() {
        await wait()
        return { generatedAt: stamp(), modules: clone(state.modules) }
      },
    },
    settings: {
      async describe() {
        await wait()
        return { namespaces: clone(state.settings) }
      },
      async update(ns, patch, expectedRevision) {
        await wait()
        const view = state.settings.find((item) => item.ns === ns)
        if (view === undefined) throw new ApiError(`没有这个设置命名空间：${ns}`, { status: 404, code: 'SETTINGS_NS_UNKNOWN' })
        if (expectedRevision !== undefined && view.revision !== expectedRevision) {
          throw new ApiError('设置已被别人改过，请重新读取', { status: 409, code: 'SETTINGS_CONFLICT' })
        }
        for (const [path, value] of flattenPatch(patch)) {
          const field = findField(view.fields, path)
          if (field === undefined) {
            throw new ApiError(`未知设置项：${path}`, { status: 400, code: 'SETTINGS_FIELD_UNKNOWN' })
          }
          if (field.writable !== true) {
            throw new ApiError(`设置项不可写：${path}`, { status: 400, code: 'SETTINGS_FIELD_NOT_WRITABLE' })
          }
          /** @type {{ value?: unknown }} */
          const mutableField = field
          mutableField.value = value === null ? undefined : value
        }
        /** @type {{ overridden: boolean, revision: string | null, updatedAt: string | null }} */
        const mutableView = view
        mutableView.overridden = true
        mutableView.revision = `mock-${state.revision++}`
        mutableView.updatedAt = stamp()
        return clone(view)
      },
      async reset(ns) {
        await wait()
        const index = state.settings.findIndex((item) => item.ns === ns)
        if (index < 0) throw new ApiError(`没有这个设置命名空间：${ns}`, { status: 404, code: 'SETTINGS_NS_UNKNOWN' })
        const fresh = state.initialSettings[index]
        state.settings[index] = clone(fresh)
        return clone(state.settings[index])
      },
    },
    usage: {
      /** @param {UsageQuery} query */
      async get(query) {
        await wait()
        const days = query.range === '7d' ? 7 : query.range === '90d' ? 90 : 30
        const factor = query.apiKeyId === undefined ? 1 : 0.35
        const daily = state.usage.daily.slice(-days).map((point) => scaleUsagePoint(point, factor))
        const totals = sumUsage(daily)
        const models = (query.apiKeyId === undefined ? state.usage.models : state.usage.models.slice(0, 2)).map(
          (model) => ({
            ...model,
            requests: Math.round(model.requests * factor),
            tokens: Math.round(model.tokens * factor),
            costCents: Math.round(model.costCents * factor),
            costMicros: String(Math.round(Number(model.costMicros) * factor)),
          }),
        )
        const rows = state.usage.records.filter(
          (row) =>
            (query.apiKeyId === undefined || row.apiKeyId === query.apiKeyId) &&
            (query.model === undefined || row.model === query.model),
        )
        const limit = Math.min(Math.max(query.limit ?? 20, 1), 200)
        const page = rows.filter((row) => query.cursor === undefined || row.id < query.cursor).slice(0, limit)
        return {
          range: query.range,
          from: daily[0]?.date ?? '',
          to: daily[daily.length - 1]?.date ?? '',
          apiKeyId: query.apiKeyId ?? null,
          balances: clone(state.usage.balances),
          totals,
          daily,
          models,
          records: { items: clone(page), nextCursor: page.length === limit ? page[page.length - 1].id : null },
          pricingAvailable: true,
          generatedAt: stamp(),
        }
      },
      /** @param {UsageQuery} query */
      async exportCsv(query) {
        await wait()
        const rows = state.usage.records.slice(0, 50)
        return { filename: `usage-${query.range}.csv`, content: usageCsv(rows) }
      },
    },
    adminUsage: {
      /** @param {import('../../src/contracts.ts').AdminUsageQuery} query */
      async list(query) {
        await wait()
        const days = query.range === '7d' ? 7 : query.range === '90d' ? 90 : 30
        const daily = state.usage.daily.slice(-days).map((point) => scaleUsagePoint(point, 1))
        const rows = state.usage.records.filter(
          (row) =>
            (query.userId === undefined || row.userId === query.userId) &&
            (query.apiKeyId === undefined || row.apiKeyId === query.apiKeyId) &&
            (query.model === undefined || row.model === query.model) &&
            (query.status === undefined || row.status === query.status),
        )
        const limit = Math.min(Math.max(query.limit ?? 20, 1), 200)
        const page = rows.filter((row) => query.cursor === undefined || row.id < query.cursor).slice(0, limit)
        return {
          range: query.range,
          from: daily[0]?.date ?? '',
          to: daily[daily.length - 1]?.date ?? '',
          totals: sumUsage(daily),
          daily,
          models: state.usage.models.map((model) => ({ ...model })),
          records: { items: clone(page), nextCursor: page.length === limit ? page[page.length - 1].id : null },
          pricingAvailable: true,
          generatedAt: stamp(),
        }
      },
      /** @param {import('../../src/contracts.ts').AdminUsageQuery} query */
      async exportCsv(query) {
        await wait()
        return { filename: `admin-usage-${query.range}.csv`, content: usageCsv(state.usage.records) }
      },
    },
    stats: {
      async get() {
        await wait()
        const totals = sumUsage(state.usage.daily.slice(-30))
        return {
          generatedAt: stamp(),
          users: { total: state.users.length, admins: 1, enabled: state.users.filter((user) => user.status === 'enabled').length, banned: state.users.filter((user) => user.status === 'banned').length },
          accounts: { total: state.accounts.length, enabled: state.accounts.filter((account) => account.enabled).length, disabled: state.accounts.filter((account) => !account.enabled).length, needsReauth: state.accounts.filter((account) => account.status === 'needs_reauth').length },
          keys: { total: state.keys.length, enabled: state.keys.filter((key) => key.enabled).length, disabled: state.keys.filter((key) => !key.enabled).length },
          usage: {
            today: sumUsage(state.usage.daily.slice(-1)),
            total: totals,
            series: state.usage.daily.slice(-30).map((point) => ({ ...point })),
            models: state.usage.models.map((model) => ({ ...model })),
            topUsers: [
              { userId: 1, name: 'Dzy', requests: 6_420, tokens: 1_284_550, inputTokens: 796_421, outputTokens: 385_365, cacheReadTokens: 77_073, cacheWriteTokens: 25_691, costCents: 9_860, costMicros: '98600000' },
              { userId: 2, name: 'tester', requests: 2_180, tokens: 968_400, inputTokens: 600_408, outputTokens: 290_520, cacheReadTokens: 58_104, cacheWriteTokens: 19_368, costCents: 7_240, costMicros: '72400000' },
            ],
          },
        }
      },
    },
    pricing: {
      async list() {
        await wait()
        return { items: clone(state.pricing) }
      },
      /** @param {string} model */
      async get(model) {
        await wait()
        const found = state.pricing.find((item) => item.model === model)
        if (found === undefined) throw new ApiError('没有这个模型的价格', { status: 404, code: 'PRICING_NOT_FOUND' })
        return clone(found)
      },
      /**
       * @param {string} model
       * @param {import('../../src/contracts.ts').ModelPriceInput} input
       */
      async set(model, input) {
        await wait()
        const entry = {
          model,
          inputPerMillion: String(input.inputPerMillion),
          outputPerMillion: String(input.outputPerMillion),
          cacheReadPerMillion: String(input.cacheReadPerMillion ?? '0'),
          cacheWritePerMillion: String(input.cacheWritePerMillion ?? '0'),
          currency: /** @type {const} */ ('CNY'),
          updatedAt: stamp(),
        }
        const index = state.pricing.findIndex((item) => item.model === model)
        if (index < 0) state.pricing.push(entry)
        else state.pricing[index] = entry
        return clone(entry)
      },
      /** @param {string} model */
      async remove(model) {
        await wait()
        const index = state.pricing.findIndex((item) => item.model === model)
        if (index < 0) return { removed: false }
        state.pricing.splice(index, 1)
        return { removed: true }
      },
    },
    keys: {
      async list() {
        await wait()
        return { items: clone(state.keys) }
      },
      /** @param {{ name: string }} input */
      async create(input) {
        await wait()
        const name = input.name.trim()
        if (name === '') throw new ApiError('名称不能为空', { status: 400, code: 'KEY_NAME_INVALID' })
        if (state.keys.length >= 200) throw new ApiError('API key 数量已达上限', { status: 409, code: 'KEY_LIMIT_REACHED' })
        const sequence = state.keySequence++
        const id = `key_mock_${String(sequence).padStart(3, '0')}`
        const trackingId = `mock-${String(sequence).padStart(4, '0')}-4f2a-9c1e-${String(10_000 + sequence)}`
        const secret = `sk-dizzy-mock-${String(sequence).padStart(4, '0')}-${trackingId}`
        const summary = {
          id,
          name,
          trackingId,
          secret,
          maskedKey: `sk-dizzy-****${String(sequence).padStart(4, '0')}`,
          createdAt: stamp(),
          lastUsedAt: null,
          appManaged: false,
          enabled: true,
        }
        state.keys.unshift(summary)
        return clone(summary)
      },
      /**
       * @param {string} id
       * @param {{ name?: string, enabled?: boolean }} input
       */
      async update(id, input) {
        await wait()
        const key = state.keys.find((item) => item.id === id)
        if (key === undefined) throw new ApiError(`没有这个 API key：${id}`, { status: 404, code: 'KEY_NOT_FOUND' })
        if (key.appManaged) throw new ApiError('App-managed key 不能在控制台修改', { status: 409, code: 'KEY_APP_MANAGED' })
        if (input.name === undefined && input.enabled === undefined) {
          throw new ApiError('没有可修改的字段', { status: 400, code: 'KEY_INPUT_INVALID' })
        }
        if (input.name !== undefined) {
          const name = input.name.trim()
          if (name === '') throw new ApiError('名称不能为空', { status: 400, code: 'KEY_NAME_INVALID' })
          key.name = name
        }
        if (input.enabled !== undefined) key.enabled = input.enabled
        return clone(key)
      },
      /** @param {string} id */
      async remove(id) {
        await wait()
        const index = state.keys.findIndex((item) => item.id === id)
        if (index < 0) throw new ApiError(`没有这个 API key：${id}`, { status: 404, code: 'KEY_NOT_FOUND' })
        if (state.keys[index].appManaged) {
          throw new ApiError('App-managed key 不能在控制台删除', { status: 409, code: 'KEY_APP_MANAGED' })
        }
        state.keys.splice(index, 1)
        return { removed: true }
      },
      /** @param {string} id */
      async rotate(id) {
        await wait()
        const key = state.keys.find((item) => item.id === id)
        if (key === undefined) throw new ApiError(`没有这个 API key：${id}`, { status: 404, code: 'KEY_NOT_FOUND' })
        if (key.appManaged) {
          throw new ApiError('App-managed key 不能在控制台轮换', { status: 409, code: 'KEY_APP_MANAGED' })
        }
        const sequence = state.keySequence++
        const secret = `sk-dizzy-mock-rotated-${String(sequence).padStart(4, '0')}`
        key.maskedKey = `sk-dizzy-****${String(sequence).padStart(4, '0')}`
        key.secret = secret
        return { ...clone(key), secret }
      },
    },
    topup: {
      async options() {
        await wait()
        return clone(state.topup)
      },
      /** @param {TopupOrderInput} input */
      async createOrder(input) {
        await wait()
        const method = state.topup.methods.find((item) => item.id === input.method)
        if (method === undefined || !method.enabled) {
          throw new ApiError('支付方式不可用', { status: 400, code: 'TOPUP_METHOD_UNAVAILABLE' })
        }
        if (!Number.isSafeInteger(input.amountCents)) {
          throw new ApiError('金额必须是整数分', { status: 400, code: 'TOPUP_AMOUNT_INVALID' })
        }
        if (input.amountCents < state.topup.minCents || input.amountCents > state.topup.maxCents) {
          throw new ApiError('金额超出允许范围', { status: 400, code: 'TOPUP_AMOUNT_OUT_OF_RANGE' })
        }
        return {
          orderId: `mock-order-${state.orderSequence++}`,
          status: 'pending',
          amountCents: input.amountCents,
          method: input.method,
          payUrl: null,
          expiresAt: new Date(now().getTime() + 15 * 60_000).toISOString(),
          message: 'mock 模式不会真的发起支付；真实订单由 Go 的支付模块创建。',
        }
      },
    },
    health: {
      async get() {
        await wait()
        return { ...clone(state.health), at: stamp() }
      },
    },
    console: {
      async manifest() {
        await wait()
        return clone(state.manifest)
      },
    },
  }
}

/** @param {() => Date} now */
function createMockState(now) {
  const at = now().toISOString()
  /** @type {AccountSummary[]} */
  const accounts = [
    {
      id: 'acc_claude_01',
      provider: 'claude',
      kind: 'oauth',
      label: 'Claude · personal',
      enabled: true,
      status: 'active',
      email: 'owner@example.com',
      subject: 'claude-user-01',
      baseUrl: null,
      protocol: 'anthropic',
      models: ['claude-sonnet-4-5', 'claude-opus-4-1'],
      modelMap: null,
      priority: 0,
      accessExpiresAt: new Date(Date.parse(at) + 42 * 60_000).toISOString(),
      refreshDueAt: new Date(Date.parse(at) + 12 * 60_000).toISOString(),
      lastRefreshAt: at,
      lastError: null,
      failureCount: 0,
      backoffUntil: null,
      createdAt: '2026-10-01T08:00:00.000Z',
      updatedAt: at,
    },
    {
      id: 'acc_openai_02',
      provider: 'openai',
      kind: 'oauth',
      label: 'Codex · team',
      enabled: true,
      status: 'active',
      email: 'team@example.com',
      subject: 'org-02',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-chat',
      models: ['gpt-5', 'gpt-5-codex'],
      modelMap: { 'gpt-5-codex': 'gpt-5-codex-2025-01-01' },
      priority: 5,
      accessExpiresAt: new Date(Date.parse(at) + 51 * 60_000).toISOString(),
      refreshDueAt: new Date(Date.parse(at) + 21 * 60_000).toISOString(),
      lastRefreshAt: at,
      lastError: null,
      failureCount: 1,
      backoffUntil: null,
      createdAt: '2026-10-02T09:10:00.000Z',
      updatedAt: at,
    },
    {
      id: 'acc_custom_03',
      provider: 'custom',
      kind: 'api_key',
      label: '兼容上游 · backup',
      enabled: false,
      status: 'needs_reauth',
      email: null,
      subject: null,
      baseUrl: 'https://example.invalid/v1',
      protocol: null,
      models: null,
      modelMap: null,
      priority: 0,
      accessExpiresAt: null,
      refreshDueAt: null,
      lastRefreshAt: null,
      lastError: 'invalid_grant',
      failureCount: 3,
      backoffUntil: null,
      createdAt: '2026-10-03T11:30:00.000Z',
      updatedAt: at,
    },
  ]

  /** @type {SettingsNamespaceView[]} */
  const settings = [
    {
      ns: 'mailer',
      plugin: '@dizzyapi/plugin-mailer',
      active: true,
      disabled: false,
      writable: true,
      overridden: false,
      revision: null,
      updatedAt: null,
      pending: false,
      fields: [
        {
          path: 'transport',
          label: '传输',
          kind: 'enum',
          writable: true,
          secret: false,
          credentialRef: false,
          values: ['log', 'smtp'],
          value: 'log',
        },
        {
          path: 'from',
          label: '发件人',
          kind: 'string',
          writable: true,
          secret: false,
          credentialRef: false,
          value: 'robot@example.com',
        },
        {
          path: 'smtp',
          label: 'SMTP',
          kind: 'object',
          writable: false,
          secret: false,
          credentialRef: false,
          children: [
            {
              path: 'smtp.host',
              label: '主机',
              kind: 'string',
              writable: true,
              secret: false,
              credentialRef: false,
              value: 'smtp.example.com',
            },
            {
              path: 'smtp.passRef',
              label: '授权码引用',
              kind: 'string',
              writable: false,
              secret: false,
              credentialRef: true,
              value: 'dizzyapi/smtp',
            },
          ],
        },
      ],
    },
    {
      ns: 'identity',
      plugin: '@dizzyapi/plugin-identity',
      active: true,
      disabled: false,
      writable: true,
      overridden: true,
      revision: 'mock-0',
      updatedAt: at,
      pending: false,
      fields: [
        {
          path: 'refreshLeadMs',
          label: '提前刷新窗口',
          kind: 'integer',
          writable: true,
          secret: false,
          credentialRef: false,
          min: 60_000,
          max: 86_400_000,
          unit: '毫秒',
          value: 1_800_000,
        },
        {
          path: 'pollIntervalMs',
          label: '轮询间隔',
          kind: 'integer',
          writable: true,
          secret: false,
          credentialRef: false,
          min: 10_000,
          max: 3_600_000,
          unit: '毫秒',
          value: 60_000,
        },
      ],
    },
    {
      ns: 'account-priority',
      plugin: '@dizzyapi/plugin-account-priority',
      active: true,
      disabled: false,
      writable: true,
      overridden: false,
      revision: null,
      updatedAt: null,
      pending: false,
      fields: [
        {
          path: 'autoStart',
          label: '自动拉起 gatewayd',
          kind: 'boolean',
          writable: true,
          secret: false,
          credentialRef: false,
          value: true,
        },
      ],
    },
  ]

  /** 可变的本地形状；列表响应返回的是 clone，不会把可变对象漏给调用方。 */
  /** @type {{ id: string, name: string, trackingId: string, secret: string | null, maskedKey: string, createdAt: string, lastUsedAt: string | null, appManaged: boolean, enabled: boolean }[]} */
  const keys = [
    {
      id: 'key_local_dev',
      name: 'local-dev',
      trackingId: 'mock-0001-4f2a-9c1e-10001',
      secret: 'sk-dizzy-mock-local-dev-0001',
      maskedKey: 'sk-dizzy-****0001',
      createdAt: '2026-09-21T09:20:00.000Z',
      lastUsedAt: '2026-10-18T16:42:00.000Z',
      appManaged: false,
      enabled: true,
    },
    {
      id: 'key_ci_runner',
      name: 'ci-runner',
      trackingId: 'mock-0002-4f2a-9c1e-10002',
      secret: 'sk-dizzy-mock-ci-runner-0002',
      maskedKey: 'sk-dizzy-****0002',
      createdAt: '2026-09-30T14:05:00.000Z',
      lastUsedAt: '2026-10-19T07:10:00.000Z',
      appManaged: false,
      enabled: false,
    },
    {
      id: 'key_mock_003',
      name: 'playground',
      trackingId: 'mock-0003-4f2a-9c1e-10003',
      secret: null,
      maskedKey: '由 App 管理',
      createdAt: '2026-08-08T03:15:00.000Z',
      lastUsedAt: null,
      appManaged: true,
      enabled: true,
    },
  ]

  const usage = createMockUsage(at)
  /** @type {{ model: string, inputPerMillion: string, outputPerMillion: string, cacheReadPerMillion: string, cacheWritePerMillion: string, currency: 'CNY', updatedAt: string }[]} */
  const pricing = [
    { model: 'dizzy-flash', inputPerMillion: '1', outputPerMillion: '4', cacheReadPerMillion: '0.1', cacheWritePerMillion: '1.25', currency: 'CNY', updatedAt: at },
    { model: 'dizzy-reasoner', inputPerMillion: '4', outputPerMillion: '16', cacheReadPerMillion: '0.4', cacheWritePerMillion: '5', currency: 'CNY', updatedAt: at },
    { model: 'dizzy-vision', inputPerMillion: '2', outputPerMillion: '8', cacheReadPerMillion: '0.2', cacheWritePerMillion: '2.5', currency: 'CNY', updatedAt: at },
    { model: '*', inputPerMillion: '0', outputPerMillion: '0', cacheReadPerMillion: '0', cacheWritePerMillion: '0', currency: 'CNY', updatedAt: at },
  ]
  const topup = {
    currency: 'CNY',
    amountsCents: [1_000, 2_000, 5_000, 10_000, 30_000, 50_000],
    minCents: 100,
    maxCents: 5_000_000,
    methods: [
      { id: 'alipay', label: '支付宝', enabled: true, note: '跳转支付宝收银台' },
      { id: 'wechat', label: '微信支付', enabled: true, note: '扫码支付' },
    ],
    notice: '充值到账与发票由 Go 的支付模块负责；前端只创建订单，不接触支付凭据。',
  }

  const manifest = createMockManifest(at)
  /** @type {{ id: number, name: string, status: 'enabled' | 'banned', role: 'admin' | 'user', balanceEnabled: boolean, balanceMinor: string, createdAt: string, updatedAt: string }[]} */
  const users = [
    {
      id: 1,
      name: 'owner',
      status: 'enabled',
      role: 'admin',
      balanceEnabled: true,
      balanceMinor: '42000000',
      createdAt: '2026-09-01T08:00:00.000Z',
      updatedAt: at,
    },
    {
      id: 2,
      name: 'alice',
      status: 'enabled',
      role: 'user',
      balanceEnabled: false,
      balanceMinor: '500000',
      createdAt: '2026-09-10T08:00:00.000Z',
      updatedAt: at,
    },
    {
      id: 3,
      name: 'bob',
      status: 'banned',
      role: 'user',
      balanceEnabled: true,
      balanceMinor: '0',
      createdAt: '2026-09-12T08:00:00.000Z',
      updatedAt: at,
    },
  ]
  /** @type {import('../../src/contracts.ts').SessionUser} */
  const sessionUser = {
    id: 1,
    name: 'owner',
    status: 'enabled',
    role: 'admin',
    balanceEnabled: true,
    balanceCents: 4200,
    avatar: null,
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: at,
  }
  return {
    accounts,
    users,
    sessionUser,
    sessionEmail: 'owner@example.com',
    authenticated: true,
    pendingCode: '123456',
    pendingEmail: 'owner@example.com',
    settings,
    initialSettings: clone(settings),
    keys,
    keySequence: 4,
    usage,
    pricing,
    topup,
    orderSequence: 1,
    modules: [
      {
        id: 'frontend',
        package: '@dizzyapi/plugin-frontend',
        kind: 'plugin',
        state: 'active',
        version: '0.1.0',
        description: '前端宿主：静态资源版本与清单',
        provides: ['frontend'],
        pages: ['/console', '/console/usage', '/admin', '/admin/catalog'],
      },
      {
        id: 'identity',
        package: '@dizzyapi/plugin-identity',
        kind: 'plugin',
        state: 'active',
        version: '0.1.0',
        description: '上游账号保管与 RT 刷新',
        provides: ['identity'],
        pages: ['/admin/accounts'],
      },
      {
        id: 'settings',
        package: '@dizzyapi/plugin-settings',
        kind: 'plugin',
        state: 'active',
        version: '0.1.0',
        description: '运行期配置覆盖',
        provides: ['settings'],
        pages: ['/admin/settings'],
      },
      {
        id: 'account-priority',
        package: '@dizzyapi/plugin-account-priority',
        kind: 'plugin',
        state: 'active',
        version: '0.1.0',
        description: '账号优先级与 gatewayd 监管',
        provides: ['accountPriority'],
        pages: ['/admin/strategies'],
      },
      {
        id: 'gatewayd',
        package: 'github.com/Acidmoon/DizzyAPI/cmd/gatewayd',
        kind: 'module',
        state: 'active',
        version: '0.1.0',
        description: '数据面进程与账号打分阶段',
        provides: ['account-priority'],
        pages: [],
      },
      {
        id: 'mailer-off',
        package: '@dizzyapi/plugin-mailer',
        kind: 'plugin',
        state: 'disabled',
        version: '0.1.0',
        description: '邮件投递（示例：禁用项）',
        provides: ['mailer'],
        pages: [],
      },
    ],
    health: {
      state: 'ok',
      at,
      version: '0.1.0',
      uptimeSec: 3_721,
      descriptorRevision: 'mock-descriptor-1',
      bridge: { connected: true, transport: 'tcp', address: '127.0.0.1:59321' },
      components: [
        { name: 'gatewayd', state: 'ok', detail: 'control bridge connected' },
        { name: 'account-priority', state: 'ok', detail: 'revision mock-1' },
        { name: 'database', state: 'degraded', detail: 'not wired yet' },
      ],
    },
    manifest,
    revision: 1,
  }
}

/**
 * 90 天确定性 mock 用量。数字刻意与参考截图不同，避免把真实账户数据带进 UI。
 * @param {string} at
 */
function createMockUsage(at) {
  const end = Date.parse(at)
  /** @type {UsageDailyPoint[]} */
  const daily = []
  for (let index = 0; index < 90; index++) {
    const date = new Date(end - (89 - index) * 86_400_000)
    const base = (index * 37) % 11
    const costCents =
      base * 45 +
      (index % 9 === 0 ? 520 : 0) +
      (index % 13 === 4 ? 240 : 0) +
      (index % 17 === 11 ? 90 : 0)
    const requests = 40 + ((index * 53) % 170) + (costCents > 400 ? 120 : 0)
    const tokens = requests * (140 + ((index * 29) % 220))
    daily.push({
      date: date.toISOString().slice(0, 10),
      costCents,
      costMicros: String(costCents * 10_000),
      requests,
      tokens,
      ...splitTokens(tokens),
    })
  }
  return {
    balances: { paidCents: 42_000, grantedCents: 5_000, spentCents: 18_673 },
    daily,
    models: [
      { model: 'dizzy-flash', requests: 6_420, tokens: 1_284_550, costCents: 9_860, costMicros: '98600000', ...splitTokens(1_284_550) },
      { model: 'dizzy-reasoner', requests: 2_180, tokens: 968_400, costCents: 7_240, costMicros: '72400000', ...splitTokens(968_400) },
      { model: 'dizzy-vision', requests: 640, tokens: 312_900, costCents: 1_573, costMicros: '15730000', ...splitTokens(312_900) },
    ],
    records: createMockUsageRecords(end),
  }
}

/**
 * 把总 token 拆成四个互不重叠的桶（mock 用）。
 * @param {number} tokens
 */
function splitTokens(tokens) {
  const inputTokens = Math.round(tokens * 0.62)
  const outputTokens = Math.round(tokens * 0.3)
  const cacheReadTokens = Math.round(tokens * 0.06)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: Math.max(tokens - inputTokens - outputTokens - cacheReadTokens, 0),
  }
}

/**
 * @param {number} end
 */
function createMockUsageRecords(end) {
  const models = ['dizzy-flash', 'dizzy-reasoner', 'dizzy-vision', 'dizzy-embed']
  const keys = ['生产 Key', '本地开发', 'CI 流水线']
  const records = []
  for (let index = 0; index < 24; index++) {
    const tokens = 180 + ((index * 137) % 2_600)
    const buckets = splitTokens(tokens)
    const costCents = 3 + ((index * 7) % 40)
    records.push({
      id: 10_000 - index,
      reqId: `req-mock-${String(index + 1).padStart(3, '0')}`,
      userId: 1,
      apiKeyId: `key_mock_${String((index % 3) + 1).padStart(3, '0')}`,
      apiKeyName: keys[index % keys.length],
      model: models[index % models.length],
      upstreamModel: index % 5 === 0 ? `${models[index % models.length]}-upstream` : null,
      protocol: index % 3 === 0 ? 'anthropic' : 'openai-chat',
      upstreamProtocol: index % 4 === 0 ? 'anthropic' : 'openai-chat',
      stream: index % 2 === 0,
      status: index % 11 === 7 ? 429 : 200,
      errorCode: index % 11 === 7 ? 'UPSTREAM_RATE_LIMITED' : null,
      ...buckets,
      totalTokens: tokens,
      durationMs: 420 + ((index * 211) % 4_800),
      clientIp: `203.0.113.${(index % 200) + 10}`,
      startedAt: new Date(end - index * 3_600_000).toISOString(),
      costMicros: String(costCents * 10_000),
      userName: index % 2 === 0 ? 'Dzy' : 'tester',
      accountId: index % 3 === 0 ? 'acct_claude_main' : 'acct_openai_pool',
      attempts: index % 7 === 0 ? 2 : 1,
    })
  }
  return records
}

/**
 * @param {UsageDailyPoint} point
 * @param {number} factor
 * @returns {UsageDailyPoint}
 */
function scaleUsagePoint(point, factor) {
  return {
    ...point,
    costCents: Math.round(point.costCents * factor),
    costMicros: String(Math.round(Number(point.costMicros) * factor)),
    requests: Math.round(point.requests * factor),
    tokens: Math.round(point.tokens * factor),
    inputTokens: Math.round(point.inputTokens * factor),
    outputTokens: Math.round(point.outputTokens * factor),
    cacheReadTokens: Math.round(point.cacheReadTokens * factor),
    cacheWriteTokens: Math.round(point.cacheWriteTokens * factor),
  }
}

/**
 * 把一串用量点累加成总数（mock 用）。
 * @param {readonly UsageTotals[]} points
 * @returns {UsageTotals}
 */
function sumUsage(points) {
  let requests = 0
  let tokens = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let costCents = 0
  let micros = 0n
  for (const point of points) {
    requests += point.requests
    tokens += point.tokens
    inputTokens += point.inputTokens
    outputTokens += point.outputTokens
    cacheReadTokens += point.cacheReadTokens
    cacheWriteTokens += point.cacheWriteTokens
    costCents += point.costCents
    micros += BigInt(point.costMicros)
  }
  return {
    requests,
    tokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costCents,
    costMicros: micros.toString(),
  }
}

/**
 * mock 的 CSV 导出。
 * @param {readonly Record<string, any>[]} rows
 */
function usageCsv(rows) {
  const header =
    'time,api_key,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_micros,status,duration_ms,client_ip'
  const lines = rows.map((row) =>
    [
      row.startedAt,
      row.apiKeyName,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      row.totalTokens,
      row.costMicros,
      row.status,
      row.durationMs,
      row.clientIp ?? '',
    ].join(','),
  )
  return `${header}\n${lines.join('\n')}\n`
}

/** @param {string} at */
function createMockManifest(at) {
  return {
    schemaVersion: 1,
    revision: 'mock-manifest-1',
    generatedAt: at,
    areas: {
      console: { label: '用户站', root: '/console', description: '密钥、用量、额度与充值' },
      admin: { label: '管理台', root: '/admin', description: '账号池、模块与运行期设置' },
    },
    enabledPlugins: [
      '@dizzyapi/plugin-frontend',
      '@dizzyapi/plugin-identity',
      '@dizzyapi/plugin-settings',
      '@dizzyapi/plugin-account-priority',
      '@dizzyapi/plugin-mailer',
    ],
    pages: [
      {
        id: 'mock.console.root',
        owner: '@dizzyapi/plugin-frontend',
        area: 'console',
        path: '/console',
        title: '用量信息',
        nav: '用量信息',
        hidden: true,
        order: -1,
        view: { kind: 'redirect', to: '/console/usage' },
      },
      {
        id: 'mock.console.usage',
        owner: '@dizzyapi/plugin-frontend',
        area: 'console',
        path: '/console/usage',
        title: '用量信息',
        nav: '用量信息',
        icon: 'usage',
        description: '余额、消费与令牌用量；所有金额由整数分换算显示。',
        order: 0,
        view: { kind: 'usage' },
      },
      {
        id: 'mock.console.keys',
        owner: '@dizzyapi/plugin-frontend',
        area: 'console',
        path: '/console/api_keys',
        title: 'API keys',
        nav: 'API keys',
        icon: 'keys',
        description: '签发、改名与吊销 API key；完整 key 只在创建时显示一次。',
        order: 10,
        view: { kind: 'keys' },
      },
      {
        id: 'mock.console.topup',
        owner: '@dizzyapi/plugin-frontend',
        area: 'console',
        path: '/console/top_up',
        title: '充值',
        nav: '充值',
        icon: 'topup',
        description: '在线充值；到账由 Go 的支付模块负责。',
        order: 20,
        view: { kind: 'topup' },
      },
      {
        id: 'mock.console.transactions',
        owner: '@dizzyapi/plugin-frontend',
        area: 'console',
        path: '/console/transactions',
        title: '账单',
        nav: '账单',
        icon: 'billing',
        description: '账单与发票页面等待参考设计。',
        order: 30,
        view: { kind: 'placeholder', note: '参考源码里有 /transactions 路由，但账单页 DOM 尚未提供。' },
      },
      {
        id: 'mock.console.profile',
        owner: '@dizzyapi/plugin-frontend',
        area: 'console',
        path: '/console/profile',
        title: '个人资料',
        nav: '个人资料',
        hidden: true,
        order: 40,
        view: { kind: 'profile' },
      },
      {
        id: 'mock.admin.overview',
        owner: '@dizzyapi/plugin-frontend',
        area: 'admin',
        path: '/admin',
        title: '概览',
        nav: '概览',
        icon: 'overview',
        description: '网关健康、模块目录与已启用插件的管理入口。',
        order: 0,
        view: { kind: 'overview', flavor: 'admin' },
      },
      {
        id: 'mock.admin.users',
        owner: '@dizzyapi/plugin-frontend',
        area: 'admin',
        path: '/admin/users',
        title: '用户',
        nav: '用户',
        icon: 'user',
        description: '用户状态、角色、余额显示与余额调整；余额按最小单位整数运算。',
        order: 15,
        view: { kind: 'users' },
      },
      {
        id: 'mock.admin.accounts',
        owner: '@dizzyapi/plugin-identity',
        area: 'admin',
        path: '/admin/accounts',
        title: '账号池',
        nav: '账号池',
        icon: 'accounts',
        description: '只显示元数据，不显示任何令牌。',
        order: 20,
        view: { kind: 'accounts' },
      },
      {
        id: 'mock.admin.catalog',
        owner: '@dizzyapi/plugin-frontend',
        area: 'admin',
        path: '/admin/catalog',
        title: '模块目录',
        nav: '模块目录',
        icon: 'catalog',
        order: 10,
        view: { kind: 'catalog' },
      },
      {
        id: 'mock.admin.settings',
        owner: '@dizzyapi/plugin-settings',
        area: 'admin',
        path: '/admin/settings',
        title: '运行期设置',
        nav: '设置',
        icon: 'settings',
        order: 40,
        view: { kind: 'settings' },
      },
    ],
    settingsCards: [
      {
        id: 'mock.mailer.settings',
        owner: '@dizzyapi/plugin-mailer',
        title: '邮件投递',
        description: 'SMTP 传输与发件人。',
        namespace: 'mailer',
        order: 10,
      },
      {
        id: 'mock.identity.settings',
        owner: '@dizzyapi/plugin-identity',
        title: '账号刷新策略',
        description: '刷新窗口与轮询间隔。',
        namespace: 'identity',
        order: 20,
      },
      {
        id: 'mock.account-priority.settings',
        owner: '@dizzyapi/plugin-account-priority',
        title: '账号优先级',
        description: 'gatewayd 拉起与监管。',
        namespace: 'account-priority',
        order: 30,
      },
    ],
    slots: [
      {
        id: 'mock.admin.note',
        owner: '@dizzyapi/plugin-frontend',
        slot: 'admin.overview.after',
        title: '参考设计待补',
        body: '版式与字段密度会在 owner 提供参考页面后替换。',
        order: 100,
      },
      {
        id: 'mock.console.usage-link',
        owner: '@dizzyapi/plugin-frontend',
        slot: 'console.overview.after',
        title: '用量与计费',
        body: '页面仍是占位。',
        href: '/console/usage',
        order: 100,
      },
    ],
  }
}

/** 最小单位 → 整数分（1 分 = 10_000 个最小单位）。 */
/** @param {string} minor @returns {number} */
function centsOfMinor(minor) {
  const cents = BigInt(minor) / 10_000n
  return Number(cents)
}

/** @param {unknown} value @returns {any} */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** @param {string} content @returns {string | undefined} */
function bodyOf(content) {
  return content === '' ? undefined : content
}

/**
 * @param {string} text
 * @param {string | null} contentType
 * @returns {any}
 */
function parseBody(text, contentType) {
  const content = bodyOf(text)
  if (content === undefined) return undefined
  const looksJson = (contentType ?? '').includes('json') || content.trim().startsWith('{') || content.trim().startsWith('[')
  if (!looksJson) return content
  try {
    return JSON.parse(content)
  } catch {
    throw new ApiError('响应不是合法 JSON', { status: 502, code: 'INVALID_RESPONSE' })
  }
}

/** @param {unknown} value @returns {Record<string, any> | undefined} */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : undefined
}

/**
 * @param {string} path
 * @param {Readonly<Record<string, string | number | boolean | null | undefined>> | undefined} query
 */
function withQuery(path, query) {
  if (query === undefined) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    params.append(key, String(value))
  }
  const text = params.toString()
  if (text === '') return path
  return `${path}${path.includes('?') ? '&' : '?'}${text}`
}

/**
 * 把 patch 摊成 [点分路径, 值]；普通对象递归，数组与标量算叶子。
 * @param {Record<string, unknown>} patch
 * @param {string} [prefix]
 * @returns {[string, unknown][]}
 */
function flattenPatch(patch, prefix = '') {
  /** @type {[string, unknown][]} */
  const out = []
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...flattenPatch(/** @type {Record<string, unknown>} */ (value), path))
    } else {
      out.push([path, value])
    }
  }
  return out
}

/**
 * @param {readonly SettingsFieldView[]} fields
 * @param {string} path
 * @returns {SettingsFieldView | undefined}
 */
function findField(fields, path) {
  for (const field of fields) {
    if (field.path === path) return field
    if (field.children !== undefined) {
      const found = findField(field.children, path)
      if (found !== undefined) return found
    }
  }
  return undefined
}
