# @dizzyapi/plugin-dashboard · DizzyAPI 控制台

DizzyAPI 的控制面前端。它是**一个 cordis 插件**（`src/`）加一份**整份 vendor 的上游 Next.js 工程**（`app/`）。

```
packages/dashboard/
├── app/                # vendor 自上游的 Next.js 工程（静态导出 SPA）
│   ├── src/            # 页面、组件、样式（我们改过，改动见下）
│   ├── package.json    # 独立的 npm 工程（用 npm，不进 pnpm workspace）
│   └── scripts/export-dist.mjs   # next build 的 out/ → ../dist
├── src/                # 插件本体：发静态字节 + 页面路由回退 + CSP nonce
├── test/               # 插件测试（Node 直连 HTTP，不用浏览器）
├── dist/               # 构建产物（.gitignore 忽略；插件读它）
├── UPSTREAM-LICENSE    # 上游 MIT LICENSE 原文
└── README.md           # 本文件
```

## 上游出处

| 项 | 值 |
|---|---|
| 仓库 | <https://github.com/arhamkhnz/next-shadcn-admin-dashboard> |
| commit | `feba54237fe1a477ae42c437b7dd0bed41a4e5eb`（`chore: update deps`） |
| 许可证 | **MIT**，Copyright (c) 2024 Mohammed Arham Khan |
| 许可证原文 | 上游 `LICENSE` 原样保留为 `UPSTREAM-LICENSE`；`app/LICENSE` 是同一份 |

MIT 允许整份 vendor 与修改后分发，前提是**保留版权声明与许可正文**。本目录同时保留了
`UPSTREAM-LICENSE` 与 `app/LICENSE`，`app/package.json` 里 `license` 仍写在上游工程内。

Next.js 的商标条款（不得用 "Next.js" 作产品名、不得用其 logo）与本项目无关：产品名是
DizzyAPI，页面里不出现 Next.js 品牌。

## 插件职责（只管两件事）

1. **发静态字节**：`dist/` 里真实存在的文件按扩展名给 `Content-Type` 发出去。
   `/_next/static/**` 是内容寻址的，发 `public, max-age=31536000, immutable`；
   HTML 与其余文件一律 `no-store`。
2. **页面路由回退**：命中 `<dist>/<route>/index.html` 就发那一页，否则回退
   `<dist>/index.html`（SPA 兜底）。

**不做的**：不渲染、不取数、不代理 `/api/*`。业务数据由 `api` 插件（`127.0.0.1:7791`）
提供，nginx 把 `/api/*` 直接反代到那边。

判定顺序与「找不到的静态文件必须 404」的细节见 `src/static-server.ts` 顶部注释。

端口默认 `127.0.0.1:7792`（沿用旧 `web` 插件的端口，nginx 不用改）。
**旧 `web` 插件必须先禁用/移除**，否则两个插件抢同一个端口。

### 禁用即回收

`src/service.ts` 的 `Service.init` 里 `start()`，把 `stop()` 作为 disposer yield 出去：
禁用 / 卸载时监听关闭、连接断开、端口释放。`start()` / `stop()` 是显式的，测试直接驱动。

本插件**没有**后台任务与桥命令，因此这两类入口是「明确不注册」，不是漏写。

## CSP

全站 CSP 仍是 `'self'`，`script-src` 走**每响应一个随机 nonce**：

- 静态导出没有 middleware，构建期发不了 nonce；因此插件在**发 HTML 的那一刻**改写字节：
  给没有 `src` 的 `<script>` 加 `nonce="…"`，响应头写 `script-src 'self' 'nonce-…'`；
- 带 `src` 的同源外部脚本不加 nonce（它靠 `'self'` 过）；
- **不放开** `script-src 'unsafe-inline'` / `'unsafe-eval'`；nonce 不固定成常量。

一处**必须说明的最小放开**：`style-src-attr 'unsafe-inline'`，而 `style-src` 仍是 `'self'`。

理由（实测证据，不是图省事）：shadcn / Radix 的浮层定位（`DropdownMenu`、`Command`、
`Tooltip`、`Dialog`）与侧栏宽度是靠 React 的 `style` 属性写进内联 style 属性的
（`components/ui/sidebar.tsx` 里 `--sidebar-width` 就在 `style` 上；`recharts` 的 svg 同理）。
`style-src 'self'` 会把内联 style 属性全部丢弃 —— 表现是侧栏宽度塌陷、弹窗定位错乱、
图表尺寸为 0。只放开 **属性**、不放开 `<style>` 元素，是能做到的最小放开；
要彻底去掉它，得把上游所有组件的 `style` 用法改成 CSS 变量 + 类，那是重写组件库，不在本批次。

## 对上游做了哪些改动

### 构建与部署形态

1. `next.config.mjs`：`output: "export"`、`trailingSlash: true`、`images.unoptimized: true`，
   去掉上游的 `redirects()`（静态导出下不生效，落点由插件回退兜住）与 Vercel 相关配置。
2. `app/package.json`：改名 `dizzyapi-dashboard`、版本 `0.1.0`，删掉 `deploy`（opennextjs-cloudflare）、
   `prepare: husky`、`generate:presets` 与 `lint-staged`；`build` 后面接 `scripts/export-dist.mjs`。
3. 删 `vercel.json`、`media/`（上游截图）、`AGENTS.md`、`CONTRIBUTING.md`。
4. `src/server/server-actions.ts`：上游是 Server Action（`"use server"` + `next/headers` `cookies()`），
   静态导出没有服务端运行时，改成纯客户端实现（读 `document.cookie` / 写 cookie，默认 7 天）。
   上游 `preferences-config.ts` 里所有偏好都是 `client-cookie`，语义不变。

### 去演示屏与去上游痕迹

5. 删掉上游 25 个演示屏及其假数据（`crm` / `logistics` / `patient-monitoring` / `invoice` /
   `kanban` / `calendar` / `file-manager` / `mail` / `chat` / `academy` / `infrastructure` /
   `finance` / `ecommerce` / `productivity` / `analytics` / `products` / `profile` / `roles` /
   `tasks` / `users` / `coming-soon` / `(legacy)` / `(main)/chat` / `(main)/mail` /
   `(main)/unauthorized` / `auth/v1`，以及 `src/data/`）。
6. 删 `src/components/simple-icon.tsx`、`src/components/calendar/`（只被上面删掉的东西引用）、
   页脚的 `support-card.tsx`（上游作者的推广卡）、`github-repositories-menu.tsx`（上游仓库版本菜单）、
   `account-switcher.tsx`（演示多账号切换）、`auth/_components/social-auth/google-button.tsx`。
7. 删 `src/app/sitemap.ts`（内容全是已删路由）、`opengraph-image*` / `twitter-image*`（上游品牌图）、
   `(main)/dashboard/[...not-found]` 与 `default/` 演示页。
8. `src/app/layout.tsx`：去掉 Google Analytics（gtag 外链脚本 + 内联初始化，既不是我们的统计、
   也与 CSP `'self'` 冲突）、`lang="zh-CN"`、中文 metadata、去掉 twitter/authors 等上游身份信息。
9. `src/config/app-config.ts`：产品名 `DizzyAPI`、`url` 指向生产入口、中文标题与描述；
   `repository` 仍指上游（出处声明）。

### 中文化（不引 i18n 框架）

10. `(external)/page.tsx` 整份换成 DizzyAPI 的中文落地页（登录 / 注册入口 + 三条能力说明），
    不再用上游营销页的 `landing.module.css` 与 `_components`。
11. `(main)/auth/v2/layout.tsx`、`v2/login/page.tsx`、`v2/register/page.tsx`、
    `auth/_components/login-form.tsx`、`register-form.tsx`：全中文；去掉 Google 登录入口与
    `ENG` 语言标签；表单是**骨架**（`onSubmit` 只有 `TODO` 与 toast），真实提交由数据层接线。
12. `sidebar-items.ts`、`app-sidebar.tsx`、`nav-user.tsx`、`search-dialog.tsx`、`not-found.tsx`：
    中文化 + 换成 DizzyAPI 的信息架构（见下）。

### 字体

13. `src/lib/fonts/registry.ts`：上游注册 17 个 `next/font/google` 字体（构建期要联网下载）。
    砍到 3 个**随包自带**的字体（`geist` 包的本地字体：Geist / Geist Mono / Geist Pixel Square），
    构建不联网、产物不变大。`globals.css` 的 `[data-font=…]` 规则同步砍到 3 条，
    并给 `--font-sans` 接上中文字体栈 `--font-cjk`（自带字体只有拉丁字形）。

### 外壳

14. `(main)/dashboard/layout.tsx`：去掉 `cookies()` / `getPreference()` / `users` 演示数据 /
    GitHub 菜单 / 账号切换；去掉 `SidebarProvider` 上的**内联 `style`**（`--sidebar-width`），
    改用组件默认宽度 —— 内联 style 在 `style-src 'self'` 下会被丢，而且它本来就是硬编码值。
15. `(main)/dashboard/page.tsx`：上游是 `permanentRedirect("/dashboard/default")`（静态导出下
    构建即失败），改成真正的「仪表盘」占位页；`/dashboard` 从此是落地页而不是跳转。

## 信息架构（侧栏唯一源）

`app/src/navigation/sidebar/sidebar-items.ts` 是侧栏、搜索弹窗、面包屑的**唯一源**。
新增页面先在这里登记。

路由前缀约定（别的批次写页面时按这个来）：

| 分组 | 前缀 | 页面 |
|---|---|---|
| 管理员 | `/dashboard` | 仪表盘（`/dashboard` 本身）、用户、角色、上游账号、模型价格、兑换码、充值订单、用量明细、结算、审计、内容审核、运维总览、设置 |
| 用户 | `/dashboard/me` | 概览（`/dashboard/me`）、用量、API 密钥、充值、兑换码、模型广场、价格表（只读）、API 文档、个人资料 |

## 构建

```bash
# 1) 装上游工程的依赖（独立 npm 工程，不进 pnpm workspace）
npm --prefix packages/dashboard/app install

# 2) 构建静态产物：next build 的 out/ 会被拷成 packages/dashboard/dist/
pnpm build:dashboard          # 等价 npm --prefix packages/dashboard/app run build

# 3) 只跑本插件（一层套一层的端口要空着：7792）
node --import tsx --test "packages/dashboard/test/*.test.ts"
```

`dist/` 是构建产物，**不进 git**（根 `.gitignore` 已忽略）。要让控制台跑起来，必须先构建。

## 已知限制（本批次收尾时仍然存在）

- 侧栏里除 `/dashboard` 之外的页面还没写（本批次只交付外壳），链接会落到 SPA 的
  「页面不存在」页。页面在后续批次按上表的路由前缀补齐。
- 登录 / 注册表单还没接 `/api/auth/*`，`NavUser` 的用户信息、登出也是占位。
- `robots.txt` 仍是上游那份（`app/src/app/robots.txt`）：只是爬虫指令，不影响运行；
  要不要改由 owner 定。
