/**
 * /api/pricing 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { assertOnlyKeys } from '../params.ts'
import { auditActorOf, audited } from '../audit.ts'
import { API_ACTOR } from '../constants.ts'
import { ApiError, notFound } from '../errors.ts'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import type { ModelPriceInputLike, ModelPriceLike, PricingPort } from '../types.ts'

/**
 * `/api/pricing`：读价格表（会话）与改价格（管理员）。
 *
 * - `GET /api/pricing` → `{ items }`；
 * - `GET /api/pricing/:model` → 单个价格，没有就 404；
 * - `PUT /api/pricing/:model` → 写入并返回新价格；
 * - `DELETE /api/pricing/:model` → `{ removed }`。
 *
 * 模型名可能含 `/`，由 `encodeURIComponent` 编成 `%2F` 留在同一路径段里。
 */
export async function routePricing(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
parts: readonly string[],
): Promise<void> {
  const requirePricing = (): PricingPort => {
    const pricing = host.runtime.pricing()
    if (pricing === undefined) {
      throw new ApiError('API_PRICING_UNAVAILABLE', 503, '价格表插件不在运行')
    }
    return pricing
  }
  const viewOf = (price: ModelPriceLike) => ({
    model: price.model,
    inputPerMillion: price.inputPerMillion,
    outputPerMillion: price.outputPerMillion,
    cacheReadPerMillion: price.cacheReadPerMillion,
    cacheWritePerMillion: price.cacheWritePerMillion,
    currency: 'CNY' as const,
    updatedAt: price.updatedAt,
  })
  /** 价格字段只接受字符串或数字；其余在 HTTP 层就拒绝，不把脏值交给服务。 */
  const priceField = (
    body: Record<string, unknown>,
    key: keyof ModelPriceInputLike,
    required: boolean,
  ): string | number | undefined => {
    const value = body[key]
    if (value === undefined) {
      if (!required) return undefined
      throw new ApiError('PRICING_PRICE_INVALID', 400, `${key} 必须是字符串或数字`)
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new ApiError('PRICING_PRICE_INVALID', 400, `${key} 必须是字符串或数字`)
    }
    return value
  }

  if (parts.length === 1) {
    if (!host.allowRead(req, res)) return
    await host.requireSession(req)
    const pricing = requirePricing()
    host.sendJson(req, res, 200, { items: pricing.list().map(viewOf) })
    return
  }
  if (parts.length > 2) throw notFound('没有这个价格接口')

  const model = parts[1] as string

  if (req.method === 'GET' || req.method === 'HEAD') {
    await host.requireSession(req)
    const pricing = requirePricing()
    const price = pricing.get(model)
    if (price === null) throw new ApiError('PRICING_NOT_FOUND', 404, `没有模型 ${model} 的价格`)
    host.sendJson(req, res, 200, viewOf(price))
    return
  }

  if (req.method === 'PUT') {
    const { view } = await host.requireAdmin(req)
    const pricing = requirePricing()
    const body = await host.jsonBody(req)
    assertOnlyKeys(body, [
      'inputPerMillion',
      'outputPerMillion',
      'cacheReadPerMillion',
      'cacheWritePerMillion',
    ])
    const cacheRead = priceField(body, 'cacheReadPerMillion', false)
    const cacheWrite = priceField(body, 'cacheWritePerMillion', false)
    const input: ModelPriceInputLike = {
      inputPerMillion: priceField(body, 'inputPerMillion', true) as string | number,
      outputPerMillion: priceField(body, 'outputPerMillion', true) as string | number,
      ...(cacheRead === undefined ? {} : { cacheReadPerMillion: cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWritePerMillion: cacheWrite }),
    }
    const written = await audited(
      host.runtime,
      { actor: auditActorOf(view), actorPlugin: API_ACTOR },
      {
        action: 'pricing.write',
        targetType: 'pricing',
        targetId: model,
        summary: `写入模型 ${model} 的价格`,
        metadata: {
          inputPerMillion: String(input.inputPerMillion),
          outputPerMillion: String(input.outputPerMillion),
        },
      },
      () => pricing.set(API_ACTOR, model, input),
    )
    host.sendJson(req, res, 200, viewOf(written))
    return
  }

  if (req.method === 'DELETE') {
    const { view } = await host.requireAdmin(req)
    const pricing = requirePricing()
    const removed = await audited(
      host.runtime,
      { actor: auditActorOf(view), actorPlugin: API_ACTOR },
      {
        action: 'pricing.remove',
        targetType: 'pricing',
        targetId: model,
        summary: `删除模型 ${model} 的价格`,
        metadataOf: (result) => ({ removed: result }),
      },
      () => pricing.remove(API_ACTOR, model),
    )
    host.sendJson(req, res, 200, { removed })
    return
  }

  host.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'PUT', 'DELETE'])
}

/**
 * `/api/models`：模型广场（只读目录）。
 *
 * 与 `GET /v1/models` 的区别：后者是 LLM 入口、只给名字并集、由 Go 服务；
 * 这里是**产品面**的目录，给价格、可用性与覆盖度，**不改动 `/v1/models` 的任何字节**
 * （那条路由归 Go，契约由 `internal/httpapi` 的用例守着）。
 *
 * 查询参数：
 * - `search`：按模型名子串过滤（不区分大小写）；
 * - `availability`：`all` / `available` / `unavailable`（默认 all）；
 * - `priced`：`all` / `priced` / `unpriced`（默认 all）。
 *
 * 金额一律十进制字符串（元 / 百万 token），响应里不出现裸 bigint 或浮点。
 */
