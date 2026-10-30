/**
 * 静态文件的 `Content-Type` 映射。
 *
 * 只列静态导出产物里真实会出现的类型（`.js` / `.css` / `.html` / 字体 / 图片 /
 * `.json`）。没列到的一律 `application/octet-stream`：宁可让浏览器下载，也不用
 * 猜错的类型让浏览器按脚本或 HTML 解释一个未知后缀的文件。
 */

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

const FALLBACK = 'application/octet-stream'

/** 取小写扩展名（含点）；没有扩展名时返回空串。 */
export function extensionOf(pathname: string): string {
  const slash = pathname.lastIndexOf('/')
  const dot = pathname.lastIndexOf('.')
  if (dot <= slash + 1) return ''
  return pathname.slice(dot).toLowerCase()
}

/** 按扩展名给 `Content-Type`。 */
export function contentTypeOf(pathname: string): string {
  return TYPES[extensionOf(pathname)] ?? FALLBACK
}

/** 这个路径是否「看起来像一个文件」——页面路由不会带扩展名。 */
export function looksLikeFile(pathname: string): boolean {
  return extensionOf(pathname) !== ''
}
