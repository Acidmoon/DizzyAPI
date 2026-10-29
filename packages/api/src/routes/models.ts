/**
 * /api/models 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { queryStringOf } from '../params.ts'
import { modelCatalogOf } from '../views/catalog.ts'
import { ApiError, badRequest } from '../errors.ts'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { allowRead, sendJson } from '../http_respond.ts'
import { requireSession } from '../http_session.ts'

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
export async function routeModels(host: ApiServer, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!allowRead(host, req, res)) return
  await requireSession(host, req)
  const modelhub = host.runtime.modelhub()
  if (modelhub === undefined) {
    throw new ApiError('MODELHUB_UNAVAILABLE', 503, '模型广场服务不在运行：暂时不能查询模型目录')
  }

  const query: {
    search?: string
    availability?: 'all' | 'available' | 'unavailable'
    priced?: 'all' | 'priced' | 'unpriced'
  } = {}
  const search = queryStringOf(url, 'search')
  if (search !== undefined) query.search = search
  const availability = queryStringOf(url, 'availability')
  if (availability !== undefined) {
    if (availability !== 'all' && availability !== 'available' && availability !== 'unavailable') {
      throw badRequest('availability 只能是 all / available / unavailable')
    }
    query.availability = availability
  }
  const priced = queryStringOf(url, 'priced')
  if (priced !== undefined) {
    if (priced !== 'all' && priced !== 'priced' && priced !== 'unpriced') {
      throw badRequest('priced 只能是 all / priced / unpriced')
    }
    query.priced = priced
  }

  sendJson(host, req, res, 200, modelCatalogOf(modelhub.catalog(query)))
}
