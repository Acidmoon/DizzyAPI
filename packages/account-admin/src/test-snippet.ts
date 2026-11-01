/**
 * 连通性测试详情里的**响应片段**：截断 + 打码。
 *
 * owner 2026-11-01 要求测试结果能看「上游到底回了什么」。这是**最容易变成凭据泄漏口子**的
 * 一屏，所以单独一个文件、单独一套测试：
 *
 * 1. **截断到 2000 字符**并如实标注 `truncated` —— 上游报错动辄几 KB，
 *    整段塞进弹窗既卡又把无关内容铺满屏幕；
 * 2. **本次测试用的 token 一定打码**（原形 / URL-encoded / `Bearer <token>` 三种写法）；
 * 3. **疑似密钥形状也打码**：`sk-…`、`Bearer …`、`ghp_…`、`AKIA…`、`xoxb-…`、长 base64。
 *    形状表与 `audit` 的 `redact.ts` 对齐（同一站的脱敏口径不该有两套）；
 * 4. **端点去掉 query 与 fragment**：有的上游把 key 放在 query 里，整条 URL 不能直出；
 * 5. **不采集任何请求 / 响应头** —— 鉴权头根本没有进这个文件的入口。
 *
 * 这是兜底，不是许可：调用方本来就不该把秘密往片段里塞。
 */

/** 响应片段上限（字符）。 */
export const TEST_SNIPPET_LIMIT = 2000

/** 打码后的占位符（页面会原样展示）。 */
export const REDACTED = '[REDACTED]'

/**
 * 值里的秘密形状。与 `packages/audit/src/redact.ts` 的 `SECRET_VALUE_PATTERNS` 对齐，
 * 另加一条「长 base64 / JWT 段」—— 上游回错时经常把整条 key 回显进报错。
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI / DeepSeek / Anthropic 风格
  /sk-[A-Za-z0-9_-]{6,}/g,
  // Authorization 头
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // GitHub token
  /gh[pousr]_[A-Za-z0-9]{10,}/g,
  // AWS access key id
  /AKIA[0-9A-Z]{12,}/g,
  // Slack token
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,
  // 长 base64 / base64url / JWT 段（40 字符起，避免误伤普通文本与模型名）
  /[-A-Za-z0-9+/=]{40,}/g,
]

/** 把已知的秘密形状替换掉。 */
export function maskSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    // 每个 pattern 单独建实例：带 g 的正则会跨调用携带 lastIndex。
    const flags = pattern.flags.includes('i') ? 'gi' : 'g'
    out = out.replace(new RegExp(pattern.source, flags), REDACTED)
  }
  return out
}

/**
 * 本次测试实际用的 token → `[已脱敏]`。
 *
 * 三种写法都要挡：原形、URL-encoded、`Bearer <token>`（`Bearer` 前缀那一版先替换，
 * 否则剩下 `Bearer [已脱敏]` 这种半截）。
 */
export function redactToken(text: string, token: string): string {
  if (token === '') return text
  let out = text.split(`Bearer ${token}`).join(REDACTED)
  out = out.split(token).join(REDACTED)
  let encoded = token
  try {
    encoded = encodeURIComponent(token)
  } catch {
    encoded = token
  }
  if (encoded !== token && encoded !== '') out = out.split(encoded).join(REDACTED)
  return out
}

/** 响应正文 → 可展示片段：先按 token 打码，再按形状打码，最后截断。 */
export function snippetOf(
  rawText: string,
  token: string,
): { readonly bodySnippet: string; readonly truncated: boolean } {
  const masked = maskSecrets(redactToken(rawText, token))
  // 截断标记看**原始长度**：打码可能把长串变短，不能拿打码后的长度当依据。
  const truncated = rawText.length > TEST_SNIPPET_LIMIT || masked.length > TEST_SNIPPET_LIMIT
  return {
    bodySnippet: truncated ? masked.slice(0, TEST_SNIPPET_LIMIT) : masked,
    truncated,
  }
}

/**
 * 请求端点 → 可直出的形式：**去掉 query 与 fragment**。
 *
 * 解析失败（不是合法 URL）时退化成「协议 + 主机」以外的原样，但不含 query 的那一段：
 * 保守做法是直接返回 `''` —— 展示不出端点比漏一条带 key 的 URL 好。
 */
export function endpointOf(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    const cut = url.split(/[?#]/)[0]
    return cut ?? ''
  }
}
