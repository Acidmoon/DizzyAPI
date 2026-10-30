/**
 * htmx 局部刷新：**这一条请求要不要回片段**（第 4 批）。
 *
 * 单独一个文件的理由：`service.ts` 早已超过 400 行软上限（AGENTS.md §5.6 只许缩短），
 * 而这条判断有三处容易写错的地方，值得集中注释：
 *
 * 1. **只看 `HX-Request` 头**，不看路径清单——htmx 自己加这个头，服务端不需要知道
 *    哪些链接是 boost 的（那是渲染层的事）。
 * 2. **必须在鉴权之后判断**。`dispatch` 的顺序是 Host → 会话 → 鉴权 → 最后才这里；
 *    未登录 / 权限不足的 HX 请求照样 302 / 403，不会拿到片段。
 * 3. **片段从整页 HTML 里切**（`extractMainColumn`），不重新渲染一遍：整页 =
 *    外壳 + 同一份 main，两者逐字一致，护栏用例直接比对。
 *
 * 切不出来（页面不是外壳页，例如登录卡）就返回 `undefined`，调用方回整页——
 * htmx 拿到整页会按 `hx-select` 逻辑处理；但更常见的是根本没这种请求（登录页没有 boost 链接）。
 */
import type { IncomingMessage } from 'node:http'
import { extractMainColumn } from '@dizzyapi/plugin-page-template'

/** 这一条请求是不是 htmx 发起的局部刷新。 */
export function isHxRequest(req: IncomingMessage): boolean {
  return req.headers['hx-request'] === 'true'
}

/**
 * 给出「该回给 htmx 的片段」；不是局部刷新 / 切不出来时返回 `undefined`。
 *
 * @param req 原始请求（只看头）
 * @param html 整页渲染结果（`page.render()` 的返回值）
 */
export function fragmentResponse(req: IncomingMessage, html: string): string | undefined {
  if (!isHxRequest(req)) return undefined
  return extractMainColumn(html)
}
