/**
 * Next 静态导出配置（DizzyAPI 定制）。
 *
 * 与上游的差别只有三处，每处都有理由：
 *
 * 1. `output: "export"` —— owner 拍板「静态 SPA」。产物落在 `dist/`，由
 *    `@dizzyapi/plugin-dashboard` 插件托管字节（见 `packages/dashboard/src/`）。
 *    上游是 Vercel 部署（`vercel.json` + `opennextjs-cloudflare` 脚本），那些都不带过来。
 *
 * 2. `images.unoptimized` —— 静态导出没有图片优化服务，不开这个 `next/image`
 *    会直接报错。
 *
 * 3. `trailingSlash: true` —— 静态导出按目录产出 `dist/<route>/index.html`，
 *    开这个开关后路由 URL 与目录结构一致，插件的回退规则才简单（见 static-server.ts）。
 *
 * 另外去掉了上游的 `redirects()`：`output: "export"` 下 redirect 不会被写进产物，
 * 留着只是误导（插件不解析重定向表）。`/dashboard` 的落点由插件的回退规则兜住。
 *
 * **CSP nonce 不在这里做**：静态导出没有 middleware，发不了 nonce。
 * nonce 由插件在返回 HTML 时改写字节时注入（见 `packages/dashboard/src/csp.ts`）。
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  reactCompiler: true,
  images: {
    unoptimized: true,
  },
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
  },
  // 上游在 layout.tsx 里挂了 Google Analytics（gtag.js）。那是站点作者的统计，
  // 不是 DizzyAPI 的；而且它会引入第三方脚本，与「CSP 只放行 'self'」冲突。
  // 外链脚本一律不留。
};

export default nextConfig;
