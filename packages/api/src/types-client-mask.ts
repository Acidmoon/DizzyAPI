/**
 * 客户端指纹档案（`packages/client-mask`）在 HTTP 层的接口形状。
 *
 * **只有形状，没有逻辑**：校验（受保护头 / 占位符 / 头值安全）在插件里，
 * 这里只描述「页面能读到什么、能写什么」。
 *
 * 秘密纪律：档案里只有头名与头值模板，**不含任何秘密**；`credentials` 仍是唯一去处。
 */
export interface ClientHeaderLike {
  readonly name: string
  readonly value: string
}

/** 一套档案（页面左侧列表 + 右侧表单都吃它）。 */
export interface ClientProfileLike {
  readonly id: string
  readonly label: string
  readonly description: string | null
  readonly enabled: boolean
  readonly userAgent: string | null
  readonly headers: readonly ClientHeaderLike[]
  /** 内置预置：可改、可停用、可 `reset`，但**不能删**。 */
  readonly builtin: boolean
}

/** `status()` 的排障视图（页面顶部那几个数字）。 */
export interface ClientMaskStatusLike {
  readonly enabled: boolean
  readonly profiles: number
  readonly enabledProfiles: number
  readonly builtin: number
  readonly custom: number
  /** 存储描述（路径或 memory），不含内容。 */
  readonly storage: string
}

/**
 * 客户端档案服务端口。
 *
 * 读面**不需要权限、不抛错**（账号挂了个已删档案是正常状态）；写面要 actor 在
 * `adminPlugins` 白名单里，由插件的 `assertActor` 判。写方法全是可选的：
 * 老版本插件没有它们时，路由返回 503，而不是把「没法保存」伪装成 500。
 */
export interface ClientMaskPort {
  list(): readonly ClientProfileLike[]
  get(id: string): ClientProfileLike | undefined
  status(): ClientMaskStatusLike
  upsert?(actor: string, input: unknown): Promise<unknown>
  update?(actor: string, id: string, patch: unknown): Promise<unknown>
  remove?(actor: string, id: string): Promise<unknown>
  reset?(actor: string, id: string): Promise<unknown>
}
