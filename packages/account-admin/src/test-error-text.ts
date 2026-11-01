/**
 * 连通性测试的**错误文本**工具：摘要截断、首行、网络错误人话。
 *
 * 从 `test-connection.ts` 搬出来（§5.6：那个文件已经顶到 400 行软上限）。
 * 这里只做文本加工，**不碰请求、不碰凭据**：`redact` 在调用点做，
 * 因为只有调用方知道这次的 token 是什么。
 */

/** 错误摘要上限：够看清原因，又不会把上游报错整段抄进账号记录。 */
export const ERROR_DETAIL_LIMIT = 300

/** 取第一行非空文本（上游报错经常带一堆堆栈，第一行通常是人话）。 */
export function firstLine(text: string): string | undefined {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  return line === '' ? undefined : line
}

/** 压成单行并截断到 `ERROR_DETAIL_LIMIT`。 */
export function truncate(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length <= ERROR_DETAIL_LIMIT ? single : `${single.slice(0, ERROR_DETAIL_LIMIT)}…`
}

/**
 * 网络错误 → 短原因。**绝不拼接请求 URL**（尤其 query）：有的上游把 key 放查询串里，
 * 把 URL 拼进错误信息等于把秘密写进账号记录与页面。
 */
export function networkErrorText(error: unknown, timeoutMs: number): string {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name
    if (name === 'TimeoutError' || name === 'AbortError') return `请求超时（${timeoutMs}ms）`
  }
  if (error instanceof TypeError) {
    const cause = (error as { cause?: unknown }).cause
    const code =
      typeof cause === 'object' && cause !== null && typeof (cause as { code?: unknown }).code === 'string'
        ? (cause as { code: string }).code
        : undefined
    return code === undefined ? '网络请求失败' : `网络请求失败：${code}`
  }
  if (error instanceof Error) {
    const message = firstLine(error.message)
    return message === undefined ? '网络请求失败' : `网络请求失败：${message}`
  }
  return '网络请求失败'
}
