/** HTML 转义：模板里所有动态文本都必须经过它。 */

export function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function escapeAttr(value: string): string {
  return escapeText(value).replaceAll("'", '&#39;')
}
