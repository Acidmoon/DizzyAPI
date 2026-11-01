/**
 * 客户端指纹档案的 DTO 归一（只做形状挑选，不做语义校验）。
 *
 * 语义校验（受保护头 / 占位符 / 头值安全 / id 规则）在 `packages/client-mask` 里，
 * 那里抛的稳定码由 `toApiError` 映射成状态码；本文件只负责两件事：
 *
 * 1. **响应侧逐字段挑选**：与 `accountOf` 同一口径 —— 插件内部多返回什么，都不该直接透出去；
 * 2. **请求侧只认白名单键**：页面现在能写 `label / description / enabled / userAgent / headers`，
 *    别的键一律不往下传（多传的键如果被插件忽略，会让人以为「改了没生效」）。
 */
import { isPlainObject } from '../params.ts'
import { badRequest } from '../errors.ts'
import type { ClientHeaderLike, ClientMaskStatusLike, ClientProfileLike } from '../types-client-mask.ts'

/** 一套档案 → HTTP DTO。 */
export function clientProfileOf(value: unknown): ClientProfileLike {
  const record = isPlainObject(value) ? value : {}
  return {
    id: typeof record.id === 'string' ? record.id : '',
    label: typeof record.label === 'string' ? record.label : '',
    description: typeof record.description === 'string' ? record.description : null,
    enabled: record.enabled !== false,
    userAgent: typeof record.userAgent === 'string' ? record.userAgent : null,
    headers: clientHeadersOf(record.headers),
    builtin: record.builtin === true,
  }
}

/**
 * 头数组 → 只留 `{ name, value }`（两个都是字符串）。**读路径专用**：脏数据过滤掉就好，
 * 不该因为插件里混进一行畸形数据就整页 502。
 *
 * 写路径**必须**用 `requiredClientHeadersOf()` —— 见那里的说明。
 */
export function clientHeadersOf(value: unknown): ClientHeaderLike[] {
  if (!Array.isArray(value)) return []
  const headers: ClientHeaderLike[] = []
  for (const item of value) {
    if (!isPlainObject(item)) continue
    if (typeof item.name !== 'string' || typeof item.value !== 'string') continue
    headers.push({ name: item.name, value: item.value })
  }
  return headers
}

/**
 * 头数组 → `{ name, value }[]`。**写路径专用：形状不对就 400，绝不静默丢弃。**
 *
 * 为什么不复用上面那个宽松版：写路径的入参来自管理页，「静默过滤」的后果是
 * **把已有配置改坏还不报错** —— `PATCH {"headers":[{"name":"x-opencode-session"}]}`
 * （漏了 `value`）会被过滤成 `[]`，于是「保存成功」但该档案的请求头被清空，
 * 而这条档案挂着的账号当场变回裸请求。这违反「配置非法时明确失败，不静默降级」，
 * 而且是最坏的一种：静默地把能通的配置改坏。
 */
export function requiredClientHeadersOf(value: unknown): ClientHeaderLike[] {
  if (!Array.isArray(value)) throw badRequest('headers 必须是数组')
  return value.map((item, index) => {
    const row = index + 1
    if (!isPlainObject(item)) throw badRequest(`请求头第 ${String(row)} 行必须是对象`)
    if (typeof item.name !== 'string' || item.name.trim() === '') {
      throw badRequest(`请求头第 ${String(row)} 行缺少 name 或 value`)
    }
    if (typeof item.value !== 'string') {
      throw badRequest(`请求头第 ${String(row)} 行缺少 name 或 value`)
    }
    return { name: item.name, value: item.value }
  })
}

/** `status()` → HTTP DTO（数字与布尔原样，`storage` 是路径描述，不含内容）。 */
export function clientMaskStatusOf(value: unknown): ClientMaskStatusLike {
  const record = isPlainObject(value) ? value : {}
  const number = (key: string): number => (typeof record[key] === 'number' ? record[key] : 0)
  return {
    enabled: record.enabled === true,
    profiles: number('profiles'),
    enabledProfiles: number('enabledProfiles'),
    builtin: number('builtin'),
    custom: number('custom'),
    storage: typeof record.storage === 'string' ? record.storage : '',
  }
}

/** 新建 / 全量替换的入参（`id` 必填，其余可省）。 */
export function clientMaskInputOf(body: Record<string, unknown>): unknown {
  return {
    id: body.id,
    ...(Object.hasOwn(body, 'label') ? { label: body.label } : {}),
    ...(Object.hasOwn(body, 'description') ? { description: body.description } : {}),
    ...(Object.hasOwn(body, 'enabled') ? { enabled: body.enabled } : {}),
    ...(Object.hasOwn(body, 'userAgent') ? { userAgent: body.userAgent } : {}),
    // 写路径：严格解析（畸形的行 400，不静默丢）。
    ...(Object.hasOwn(body, 'headers') ? { headers: requiredClientHeadersOf(body.headers) } : {}),
  }
}

/** 局部修改的入参：只把**给了的键**往下传（省略 = 不改，`null` = 清空）。 */
export function clientMaskPatchOf(body: Record<string, unknown>): unknown {
  const patch: Record<string, unknown> = {}
  if (Object.hasOwn(body, 'label')) patch.label = body.label
  if (Object.hasOwn(body, 'description')) patch.description = body.description
  if (Object.hasOwn(body, 'enabled')) patch.enabled = body.enabled
  if (Object.hasOwn(body, 'userAgent')) patch.userAgent = body.userAgent
  // 写路径：严格解析 —— 漏一个 value 就等于「清空所有头」，必须报错而不是过滤。
  if (Object.hasOwn(body, 'headers')) patch.headers = requiredClientHeadersOf(body.headers)
  return patch
}
