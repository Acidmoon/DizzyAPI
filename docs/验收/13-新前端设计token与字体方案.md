# 09 · 新前端（next-shadcn-admin-dashboard）设计与字体方案

> 本文件是阶段 1 辅助线的**方案书**，不是实现记录：**本批次没有改任何代码**。
> 上游基线 = `E:\vibecoding\.dizzyapi-wt\_upstream-next-shadcn`，HEAD `feba542 chore: update deps`。
> 旧前端基线 = 本 worktree 的 `origin/main`（`0b82a54`）。
> 结论按「上游实况 → 我们的旧 token → 怎么落地 → 字体三选项 → 中文排版 → 未验证」排列。
> **每条事实后括号里的 `文件:行号` 都是实际读过的**，凭印象写的会明写「未验证」。

---

## 0. 结论速览

1. **上游主题体系**：Tailwind v4，`globals.css` 用 `@theme inline`（不是 `@theme`）把 shadcn 的语义色
   映射成 Tailwind 工具类；配色变量本身写在 `:root` / `.dark` / `:root[data-theme-preset="…"]` 三处。
   **主题预设 3 套**（Brutalist / Soft Pop / Tangerine）+ `default`（没有 `default.css`，default 就是
   `globals.css` 里的 `:root`）。`components.json` 的 style 是 **`radix-nova`**，没有 `base` 字段。
2. **深/浅色不是 `next-themes` 管的**：是 class 策略 + `<head>` 里的 `ThemeBootScript`（内联脚本）
   在 hydration 前把 cookie 读成 `data-*` 属性并给 `<html>` 加 `.dark`。`next-themes` 只被
   `components/ui/sonner.tsx` 用来取当前主题色。
3. **布局偏好**（侧栏变体 / 折叠方式 / 内容布局 / 导航栏样式 / 字体）走同一张 `PREFERENCE_REGISTRY`，
   持久化方式四种（`none` / `client-cookie` / `server-cookie` / `localStorage`），默认全是
   `client-cookie`。**关键约束：静态导出下 `server-cookie` 模式不可用**（`server-actions.ts` 依赖
   `next/headers`，`output: "export"` 没有 server runtime）。
4. **旧 token 必须由新前端重新实现**（旧的 `packages/page-template` 整套删掉，没人继承它）：
   九档字号 + 无单位行高、按角色分的字距、用户字号档位（0.875/1/1.25/1.5）、深色配色、焦点环。
   Tailwind v4 的 `--text-*` / `--text-*--line-height` / `--tracking-*` / `--leading-*` **都能覆盖**，
   所以「九档字号」不需要自造变量名，直接覆盖 Tailwind 的档位即可（见 §2.3 的 CSS 草案）。
5. **「用户可自选字号」在静态 SPA 里能保住**，但**必须补一个 JSON 端点**：现在这份数据只由
   `user` 插件持有、只有一个 SSR 表单写入路径（`packages/web/src/pages/profile.ts:72,98-102`
   → `packages/user/src/service.ts:369`），`/api/*` **没有任何** ui-preferences 路由（全仓 grep
   `ui-prefs|uiPreferences|ui_preferences|fontScale` 无 api 包命中）。这是 `交互` 线的活。
6. **字体三选项**（详见 §3）：(a) 插件注入 `@font-face`、(b) 字体进 `public/fonts/` 由插件托管字节、
   (c) 系统字体栈。**我推荐 (b)**，两条硬要求：文件名必须带内容哈希（Next 对 `public/` 的默认缓存是
   `max-age=0`，见 §3.4）、`font-family` 名必须与 woff2 name 表里的名字**逐字一致**。
   **这条要 owner 拍板**，我不自己定。
7. **中文排版现在没有人管**：`--font-sans` 指向 Geist，而 Geist 在 `subsets: ["latin"]`，
   中文靠浏览器逐字回退到 `system-ui`（Win = 雅黑系、mac = 苹方、Linux = Noto CJK），
   全站**没有** `font-feature-settings` / `line-break` / `text-wrap` 的 CJK 处理。
   同时上游标题普遍带 `tracking-tight`（`-0.025em`），中文标题会挤（§4）。

---

## 1. 上游主题体系实况

### 1.1 主题预设：3 套 + default

| 文件 | label / value | 行数 | 圆角 | 干什么 |
|---|---|---|---|---|
| `src/app/globals.css` | （无预设 / `default`） | 302 | `--radius: 0.625rem` | default 的 `:root` + `.dark` 就在这里，**没有 `default.css`**（`:55-56` 的注释明说） |
| `src/styles/presets/brutalist.css` | Brutalist / `brutalist` | 89 | `0px` | 全部色板 + 全部阴影换成 4px 硬投影（`:7`、`:39-46`） |
| `src/styles/presets/soft-pop.css` | Soft Pop / `soft-pop` | 89 | `1rem` | 全部色板 + 极淡阴影（`:7`、`:39-46`） |
| `src/styles/presets/tangerine.css` | Tangerine / `tangerine` | 89 | `0.625rem` | 全部色板 + 常规阴影（`:7`、`:39-46`） |

- 三份预设的**结构完全相同**：`:root[data-theme-preset="<value>"]` 一段浅色、`.dark:root[data-theme-preset="<value>"]`
  一段深色；每段改的是**同一套 ~30 个变量**（`--card` / `--primary` / `--chart-1..5` / `--sidebar*` /
  `--shadow-*`）+ `--radius`。
- 预设文件被 `globals.css:6-8` 三条 `@import` 静态引入，所以**新增一套预设 = 加一个 CSS 文件 + 跑生成脚本**。
- `src/scripts/generate-theme-presets.ts` 会扫 `src/styles/presets/*.css`，用正则抓 `label:` / `value:` /
  `--primary`（`:41-55`），把结果写进 `src/lib/preferences/theme.ts` 的
  `// --- generated:themePresets:start ---` 段（`:93-108`）。上游用 Husky pre-push 跑（`:14`）。
  **这就是我们加「DizzyAPI」品牌预设的入口**——但注意它只生成「预设清单与预览色」，配色真值在 CSS 里。
- `theme.ts:13-46` 现在是 4 项（Default / Brutalist / Soft Pop / Tangerine）。

### 1.2 变量清单：`@theme inline` 只是「翻译层」

`globals.css:12-53` 的 `@theme inline` 里**没有真值**，全是映射：

```css
--radius-sm: calc(var(--radius) - 4px);   /* …到 --radius-4xl，共 7 档，:13-19 */
--color-background: var(--background);    /* 语义色 27 个，:20-50 */
--color-sidebar-ring: var(--sidebar-ring);
--font-heading: var(--font-sans);         /* :51 */
--font-sans: var(--font-sans);            /* :52 —— 自引用，见 §1.4 的注意点 */
```

真值分三处：

| 位置 | 内容 |
|---|---|
| `globals.css:57-94` `:root` | `--radius`、27 个语义色（oklch）、`--chart-1..5`、`--sidebar*`、`--font-sans` / `--font-mono`、`--background` / `--foreground` |
| `globals.css:96-128` `.dark` | 同名变量深色值 |
| 各预设 CSS | 覆盖上面两段同名变量 |

`@layer base` 只做三件事（`globals.css:130-142`）：`* { @apply border-border outline-ring/50 }`、
`body { @apply bg-background text-foreground; font-family: var(--font-sans), system-ui, sans-serif }`、
`html { @apply font-sans }`。

`@layer utilities` 里还有一段**预设专用**的阴影覆盖（`:144-175`）：只有
`[data-theme-preset]:not([data-theme-preset="default"])` 时才让 `.shadow-*` 用预设的 `--shadow-*`，
default 预设继续用 Tailwind 自带的阴影。

### 1.3 为什么是 `@theme inline` 而不是 `@theme`

`inline` 的效果是「**把变量的值就地展开进工具类**」：`.bg-background` 生成的是
`background-color: var(--background)`，而不是 `background-color: var(--color-background)`。

上游必须这么写，因为它的深色变体允许落在**任意子树**上：
`globals.css:10` 是 `@custom-variant dark (&:is(.dark *))`，不是全局 `.dark`。
只有把 `var(--background)` 留在使用处，子树上的 `.dark { --background: … }` 才能生效。

> 这条是**规范推导**（没构建过），但方向明确：我们的 token 层照抄 `inline` 的写法就与上游同构，
> 不会出现「工具类读不到 `:root` 覆盖值」这类问题。

### 1.4 `components.json` 与两个 shadcn 包

`components.json`（25 行）关键字段：

- `"style": "radix-nova"`（`:3`）——**不是**老的 `new-york` / `default`。
- `"tailwind": { "config": "", "css": "src/app/globals.css", "baseColor": "neutral", "cssVariables": true }`
  （`:6-12`）—— Tailwind v4 无 config 文件，`cssVariables: true` 表示所有颜色都走 CSS 变量。
- `"iconLibrary": "lucide"`（`:13`），`aliases.*` 都是 `@/…`（`:15-21`）。
- **没有 `base` 字段**；`registries: {}`（`:24`）。

两个包的分工（都进了 `dependencies`，`package.json:27,47`）：

| 包 | 版本 | 实际用途（实测 import 点） |
|---|---|---|
| `shadcn` | `^4.23.0` | 只被 CSS 用到：`globals.css:3` 的 `@import "shadcn/tailwind.css"`（提供上游自定义工具类/变体）。**没有 TS 侧 import**。 |
| `@shadcn/react` | `^0.3.1` | 运行时组件，只有 **2 处**：`components/ui/questionnaire.tsx:4`、`components/ui/message-scroller.tsx:9`。 |

对照组：`radix-ui`（统一包，不是 `@radix-ui/*` 一堆子包）被 **36** 个 `components/ui/*.tsx` import；
`@base-ui/react` 只有 **1** 个文件用：`components/ui/combobox.tsx:4`。
`next-themes` 只有 **1** 个文件用：`components/ui/sonner.tsx:3`（`useTheme()` 取主题名给 Toaster）。
→ **去掉 `@shadcn/react` / `next-themes` 的成本很低**，去掉 `radix-ui` 才是大手术（不是我们的活，
许可证审计在 `太子` 那条线）。

### 1.5 深浅色怎么切

- **机制**：class 策略 + `data-*` 属性，**不是** `data-theme` 单属性、**也不是** `next-themes` 的
  `ThemeProvider`（全仓只有 `sonner.tsx:3` 用 `next-themes`）。
- `src/app/layout.tsx:33-46` 把 `PREFERENCE_DEFAULTS` 的 7 个 key 写成 `<html>` 上的属性：
  `data-theme-mode` / `data-theme-preset` / `data-content-layout` / `data-navbar-style` /
  `data-sidebar-variant` / `data-sidebar-collapsible` / `data-font`，并 `suppressHydrationWarning`。
- `src/scripts/theme-boot.tsx:10-78` 是**内联 `<script>`**：把 registry 序列化进脚本（`:11`），
  在 `<head>` 里同步读 cookie（`client-cookie` / `server-cookie`）或 localStorage（`:34-47`），
  校验值在允许集合内（`:46`），逐个 `root.setAttribute(definition.attribute, value)`（`:56`），
  最后按 `theme_mode`（含 `system` → `matchMedia`）切 `.dark` 并设 `style.colorScheme`（`:59-68`）。
  注释写明目的：**避免 flicker、并让 RootLayout 保持静态**（`:5-6`）。
- 切换时 `lib/preferences/theme-utils.ts:11-22` 的 `applyThemeMode`：设 `data-theme-mode`、
  加 `.disable-transitions` 一帧（`globals.css:255-257`）再切 `.dark`，同样写 `style.colorScheme`。
- 其它偏好切换走 `lib/preferences/preference-runtime.ts:15` 的 `documentElement.setAttribute(attribute, value)`。

> **对我们的直接影响**：`theme-boot.tsx` 是内联脚本，而我们的 CSP 是 `script-src 'self'`。
> 这条必须由 `界面` 的 nonce 改写方案覆盖（他们已把 CSP nonce 列进 next.config 的注释里）。
> 若 nonce 走不通，**这块不是可以降级成 `unsafe-inline` 的理由**，得停下来报错。

### 1.6 布局偏好怎么存（`src/lib/preferences/` 6 个文件）

`PREFERENCE_REGISTRY`（`preferences-config.ts:55-104`）7 个 key，每个四元组 `values / defaultValue /
persistence / attribute`：

| key | 默认 | persistence | `<html>` 属性 |
|---|---|---|---|
| `theme_mode` | `light` | client-cookie | `data-theme-mode` |
| `theme_preset` | `default` | client-cookie | `data-theme-preset` |
| `font` | `geist` | client-cookie | `data-font` |
| `content_layout` | `centered` | client-cookie | `data-content-layout` |
| `navbar_style` | `sticky` | client-cookie | `data-navbar-style` |
| `sidebar_variant` | `sidebar` | client-cookie（`defineSSRPreference`，`:91-96`） | `data-sidebar-variant` |
| `sidebar_collapsible` | `icon` | client-cookie（`defineSSRPreference`，`:98-103`） | `data-sidebar-collapsible` |

- **四种持久化**（`preferences-config.ts:1-12,24`）：`client-cookie` / `server-cookie` / `localStorage` / `none`。
  注释规定：**布局关键项（`sidebar_variant` / `sidebar_collapsible`）不能存 localStorage**，否则 SSR 与
  客户端不一致（`:9-11`）。
- 写入：`preferences-storage.ts:14-31` 的 `persistByMode` —— `client-cookie` 走 `setClientCookie`
  （`lib/cookie.client.ts`），`server-cookie` 走 Server Action `setValueToCookie`（`server/server-actions.ts:18-28`），
  `localStorage` 走 `lib/local-storage.client.ts`。
- 读取（服务端）：`server-actions.ts:30-40` 的 `getPreference(key)` —— 用 `next/headers` 的 `cookies()`；
  `:34-36` 明确：**persistence 不是 cookie 的直接返回默认值**。
- 侧栏变体的三档值在 `lib/preferences/layout.ts:2-8`（`sidebar` / `inset` / `floating`），
  折叠两档 `:11-16`（`icon` / `offcanvas`），内容布局两档 `:19-24`，导航栏两档 `:27-32`。
  **没有「密度（density）」这个偏好**，圆角来自各预设的 `--radius`，不是用户偏好。

> **`output: "export"` 下必须知道的两条**：
> ① `server-cookie` 模式与 `getPreference()` **在新前端不可用**（没有 server runtime，`next/headers` 用不了）；
> ② `界面` 的骨架里 `app/src/server/server-actions.ts` 还在（69 行，上游 40 行），**实现阶段要么删掉、
> 要么改成纯客户端读取**，留着会在构建期或运行期炸。

---

## 2. 旧 token 要不要保留 / 在新前端怎么落地

### 2.1 旧 token 实况（`packages/page-template`，即将整套删除）

| 资产 | 位置 | 内容 |
|---|---|---|
| 九档字号 + 无单位行高 | `src/tokens.ts:110-129`（`FONT_ROLES`） | `micro 12/1.4`、`chip 13/1.27`、`caption 14/1.5`、`label 15/1.54`、`body 16/1.57`、`emphasis 18/1.5`、`brand 26/1.09`、`title 28/1.33`、`metric 34/1.24` |
| 字号档位来源 | `src/tokens.ts:106-108` 注释 | 这是 **2026-10-29 owner 要求「加大两号」** 的结果：原值 10/11/12/13/14/16/22/24/29 → 现在这九档 |
| CSS 变量派生 | `src/assets.ts:59-68` | `--fs-<role>: calc(<n>px * var(--font-scale))`、`--lh-<role>: <无单位倍数>`；**用例盯着「表里的 size」与「CSS 里的值」逐条相等**（`assets.ts:49-51` 注释） |
| 字距（按角色） | `src/tokens.ts:141-146`、`assets.ts:72-73` | `--ls-normal: 0.01em`（owner 要求「字间距放宽」）、`--ls-tight: -0.02em`（品牌字刻意收紧） |
| 用户字号档位 | `src/theme.ts:16,43` | `0.875 / 1 / 1.25 / 1.5` 四档，`renderThemeCss` 只覆盖 `--font-scale` 与 `--ls-normal` 两个变量（`:53-66`） |
| 字距档位 | `src/theme.ts:33-37` | `tight 0em` / `normal 0.01em` / `wide 0.025em`（`normal` 与默认值逐字相同，所以「恢复默认」不跳） |
| 深色配色 | `src/tokens.ts:12-46`（`DARK_TOKENS`）+ `assets.ts:23-47` | `--bg-base #151517`、`--bg-layer-1..3`、`--label-primary..caption`、`--chart-1 #FD8D3C` / `--chart-2 #FED976`、`--accent #FD8D3C`、`--success #22C55E` … |
| 尺寸节奏 | `src/tokens.ts:49-92`（`METRICS`） | 侧栏 260 / 主列内边距 40·32 / 内容最大宽 936 / 卡片圆角 16 / 卡片内距 20·16 … |
| 焦点环 | `src/a11y.ts:19` | `--focus-ring: #4D93F8`，`outline: 2px solid var(--focus-ring)` + `outline-offset: 2px`（`:37-51`） |
| 字体栈 | `src/tokens.ts:149-150`、`assets.ts:90-91` | `Inter, system-ui, …, "PingFang SC", "Microsoft YaHei", sans-serif` |
| 数据层 | `packages/user/src/uiprefs.ts`、`src/db.ts:36,325-332,447` | 存 `users.ui_preferences`（TEXT/JSON），字段 `fontScale` / `letterSpacing` / `navOrder`；`user` 是唯一写者 |
| CSS 下发 | `packages/web/src/preferences.ts:64-67` + `src/theme.ts:69` | 按用户生成 `/assets/theme.css`（`private, no-store`，地址带内容哈希） |

**结论：唯一值得继承的是「九档字号 + 无单位行高 + 按角色字距 + 用户档位」这套设计判断，代码一行都不继承**
（旧 `page-template` 整套删，`web` 插件删，SSR 的 `/assets/theme.css` 路径不存在了）。

### 2.2 Tailwind v4 能直接改什么

Tailwind v4 的默认主题变量（权威来源：`tailwindcss/packages/tailwindcss/theme.css`，
<https://raw.githubusercontent.com/tailwindlabs/tailwindcss/main/packages/tailwindcss/theme.css>）里，
我们要的四类**全都有现成变量名**：

| 我们要的 | Tailwind v4 变量 | 默认值（节选） |
|---|---|---|
| 字号档位 | `--text-xs … --text-9xl` | `--text-sm: 0.875rem`、`--text-base: 1rem`、`--text-3xl: 1.875rem` |
| 字号对应行高 | `--text-*--line-height` | `--text-base--line-height: calc(1.5 / 1)` |
| 字距 | `--tracking-tighter/tight/normal/wide/wider/widest` | `-0.05 / -0.025 / 0 / 0.025 / 0.05 / 0.1em` |
| 行高（独立用） | `--leading-tight/snug/normal/relaxed/loose` | `1.25 / 1.375 / 1.5 / 1.625 / 2` |
| 字体族 | `--font-sans` / `--font-serif` / `--font-mono` | 系统栈 |
| 圆角 | `--radius-xs … --radius-4xl` | `0.125rem … 2rem` |

> 版本口径：上游 `package.json:69` 锁 `tailwindcss ^4.1.5`，我读的是 main 分支（docs 标 v4.3）。
> `--text-*` / `--tracking-*` 这套命名空间在 4.0 就有，不是 4.3 新增；但**具体默认值以锁定版本为准**，
> 装完依赖后应重核一遍（未验证项 §6-2）。

### 2.3 推荐落地：一层 `dizzy` token（覆盖档位，不自造变量）

**思路**：不发明 `--fs-body` 这类新名字，直接把 Tailwind 的档位改成我们的九档（含 `var(--font-scale)`），
让所有页面**照常写 `text-sm` / `text-base` / `text-3xl`** 就自动拿到放大后的字号。
这样新页面不需要记新 token 名，`用量` / `管理台` 两条线也不会各写一套。

映射（旧九档 → Tailwind 档位，**按序号一一对应，不合并**）：

| Tailwind 档位 | 覆盖成（= 旧 role） | 行高 |
|---|---|---|
| `--text-xs` | `calc(12px * var(--font-scale))`（`micro`） | `1.4` |
| `--text-sm` | `calc(13px * var(--font-scale))`（`chip`） | `1.27` |
| `--text-base` | `calc(14px * var(--font-scale))`（`caption`） | `1.5` |
| `--text-lg` | `calc(15px * var(--font-scale))`（`label`） | `1.54` |
| `--text-xl` | `calc(16px * var(--font-scale))`（`body`） | `1.57` |
| `--text-2xl` | `calc(18px * var(--font-scale))`（`emphasis`） | `1.5` |
| `--text-3xl` | `calc(26px * var(--font-scale))`（`brand`） | `1.09` |
| `--text-4xl` | `calc(28px * var(--font-scale))`（`title`） | `1.33` |
| `--text-5xl` | `calc(34px * var(--font-scale))`（`metric`） | `1.24` |

字距：`--tracking-normal: 0.01em`（= 旧 `--ls-normal`，「放宽」那条要求的落点）；
`--tracking-tight` 建议提到 `-0.01em`（见 §4 的中文理由，**属设计判断，需 owner/总工 点头**）。

CSS 草案（放 `app/src/styles/dizzy/tokens.css`，由 `globals.css` `@import` 到**最前面**）：

```css
/* DizzyAPI 设计 token：只覆盖档位，不新增语义色。
   --font-scale 由 ThemeBootScript / boot script 按用户偏好写到 <html>。 */
@theme inline {
  --font-sans: var(--font-sans-stack);          /* 见 §4 的中文栈 */
  --text-xs: calc(12px * var(--font-scale, 1));
  --text-xs--line-height: 1.4;
  /* …sm/base/lg/xl/2xl/3xl/4xl/5xl 同上表… */
  --tracking-normal: 0.01em;
  --tracking-tight: -0.01em;
  --radius-lg: 16px;                            /* = 旧 METRICS.cardRadius */
}

:root { --font-scale: 1; }                      /* 站默认；用户档位覆盖它 */
```

**两个必须说清的细节**：

1. `--font-scale` 的兜底要写 `var(--font-scale, 1)`：boot script 万一没跑（或 CSP 挡了），
   字号退回 1 倍而不是整站 `font-size` 变成非法值。旧前端也是这个思路（`assets.ts:59` 的 `--font-scale: 1`）。
2. **行高用无单位倍数**这条是旧代码踩过的坑，必须原样继承：旧注释写明「若写成 px，用户选『特大』时
   正文 16→24px 会压在 22px 行高上 → 文字重叠」（`tokens.ts:103-104`）。Tailwind 的
   `--text-*--line-height` 天然接受无单位值，所以照抄即可。

### 2.4 「用户可自选字号」在静态 SPA 里的两种方案

前提事实：**静态导出没有服务端渲染，也没有 Server Action 写 cookie**；而我们的字号偏好真源在
`users.ui_preferences`（`packages/user/src/db.ts:36`），现在只有 SSR 表单一条写入路径。

| | 方案 A：cookie 镜像 + boot script（**推荐**） | 方案 B：localStorage + boot script |
|---|---|---|
| 存哪 | 浏览器 cookie（`client-cookie`，与上游同构）+ 服务端真源 | 浏览器 localStorage |
| 首屏不闪 | 能：`ThemeBootScript` 在 `<head>` 同步读 cookie 并写 `data-*` | 能：同样同步读 localStorage |
| 换设备同步 | **能**（真源在服务端，登录后 GET 回来覆盖 cookie） | 不能（纯本机） |
| 与上游代码的关系 | 直接复用 `PREFERENCE_REGISTRY` + `preferences-storage`（只需把 `server-cookie` 那条删掉） | 要新增一个 `localStorage` 项（上游 registry 已支持，但样式侧要自己接） |
| 我们的旧行为 | 保住（旧前端就是服务端按用户生成 `theme.css`，跨设备一致） | **退化**（换浏览器就回到默认字号） |
| 成本 | 需要 `交互` 补一个 JSON 端点（下条） | 不需要后端 |

**推荐 A**，落地形态：

1. `<html data-font-scale="1|0.875|1.25|1.5" data-letter-spacing="tight|normal|wide">`，
   boot script 在 `<head>` 里把 cookie 值写上去；CSS 里
   `:root { --font-scale: attr(data-font-scale type(<number>), 1) }` —— **属性选值在主流浏览器支持度参差，
   所以更稳的做法是 boot script 直接写 CSSOM**：`document.documentElement.style.setProperty('--font-scale', v)`
   （CSSOM 赋值不受 `style-src 'self'` 限制，这条我们在旧前端 B 段已实测过）。
2. 切换时：**先写 cookie + 改 CSSOM（立即生效）**，再 `PUT /api/user/ui-preferences` 落库；
   失败只弹 toast、不回滚视觉（字号是弱一致数据，回滚反而更吓人）。
3. 登录 / 刷新后：`GET /api/user/ui-preferences` → 把服务端值写回 cookie，供下次首屏用。

> **需要 `交互` 补的端点（这是依赖，不是我这条线的活）**：
> `GET /api/user/ui-preferences` 与 `PUT /api/user/ui-preferences`，字段与 `packages/user/src/uiprefs.ts:29-49`
> 对齐（`fontScale` / `letterSpacing` / `navOrder`），写者仍是 `user` 服务（`setUiPreferences`，`service.ts:369`）。
> 现在**完全没有**这条路（全仓 grep 无 api 包命中），不补就只能在浏览器本地存，跨设备同步会丢。

### 2.5 旧 token 里必须一起搬过来的非字号项

| 项 | 旧值 | 新前端落点 | 备注 |
|---|---|---|---|
| 深色站配色 | `--bg-base #151517`、`--label-primary #F9FAFB`… （`assets.ts:23-47`） | 一套 `dizzy` 主题预设（`src/styles/presets/dizzy.css`）或直接改 `globals.css` 的 `:root` / `.dark` | 走预设更干净：以后想回 default 只改 cookie |
| 图表色 | `--chart-1 #FD8D3C`、`--chart-2 #FED976`、网格 `rgba(255,255,255,.12)`、轴字 `rgb(150,150,150)` | 预设里覆盖 `--chart-1..5` + 一份 recharts 主题映射 | recharts 不吃 CSS 变量，颜色要单独注入（`用量` 线） |
| 卡片圆角 16 | `METRICS.cardRadius` | `--radius-lg: 16px`（Tailwind `rounded-lg`） | 预设的 `--radius` 是基准，7 档由 `calc` 派生（`globals.css:13-19`） |
| 侧栏 260 / 内容最大宽 936 | `METRICS.sidebarWidth` / `contentMaxWidth` | `components/ui/sidebar` 的 `--sidebar-width` + 容器 max-width | `界面` 的侧栏活；数值进一份常量表 |
| 焦点环 `#4D93F8` | `a11y.ts:19` | `--ring`（shadcn 语义色）与 `:focus-visible` 的 outline | 上游 `* { @apply … outline-ring/50 }`（`globals.css:132`）；建议 `--ring: #4D93F8` |
| 中文可读性：`letter-spacing: 0.01em` | `assets.ts:96` | `body { letter-spacing: var(--tracking-normal) }` | 见 §4 |

---

## 3. 字体策略：三个选项 + 推荐（**owner 已拍板：按模版走，即 (c) 系统字体栈 + `geist`**）

> **2026-10-31 拍板记录**：owner 对「CSP 与字体」两条待定项的原话是「**都按照模版来**」。
> 因此**本节以下内容是决策记录，不是待定项** —— 结论是：
> - 新前端字体 = **模版自带的 `geist`（拉丁）+ 中文系统字体栈**（`--font-cjk`，已接）；
> - **`packages/font-smiley` 整个包删除**（含 1.15 MB 原字体、508 KB 子集、`LICENSE`、`NOTICE.md`、
>   `build-subset.py`、6 条用例与 `app.yml` 的 `font-smiley` 段）；
> - **合规上不再有新义务**：不再分发字体文件 → 不再触发 OFL 的随分发义务 → `LICENSE` 不必带走。
> - 另：`--tracking-tight` **保留模版原值不改**（那个值是配 Geist 的拉丁字距；「按模版来」即不自创。
>   中文标题是否偏挤，留待真浏览器收尾时**只记录、不擅自调**）。
>
> 下面的 (a)/(b) 两个选项与「推荐 (b)」**已作废**，保留仅为决策过程可追溯。

### 3.1 现状事实（这些数字都是实测）

- 字体：得意黑（Smiley Sans）v2.0.1 **子集**。上游全量 `packages/font-smiley/assets/smiley-sans.woff2`
  = **1,150,924 B / 9497 字形**；站点用 `dizzy-sans.woff2` = **507,880 B / 4156 字形**（`NOTICE.md` §本站做的改动）。
- 生成脚本 `packages/font-smiley/tools/build-subset.py`（可重跑）；产物**要提交**，因为部署机没有
  Python/fontTools（`NOTICE.md` §重新生成）。
- 家族名 `Dizzy Sans`（`packages/font-smiley/src/config.ts:23`），**因为 OFL-1.1 条件 3 禁止
  Modified Version 使用保留字体名 `<Smiley>` / `<得意黑>`**（`config.ts:11-15` 注释 + `assets/LICENSE` 首行）。
- name 表里 **ID 0/9/13/14（版权 / 设计者 / 许可说明 / 许可 URL）与 ID 8（厂商）原样保留**，
  只改了 ID 1/3/4/6/16（`NOTICE.md` §原样保留的义务、§本站做的改动 2）。
- `LICENSE` 全文 **4,422 B** 在 `packages/font-smiley/assets/LICENSE`（未改一字节）；另有 `NOTICE.md` 1,796 B。
- 运行时：`scope` 配置项二选一（`config.ts:29`），`app.yml:311-314` 现在是 **`scope: all`（全站）**；
  `renderFontCss` 产出 `@font-face` + 作用范围覆盖（`config.ts:68-84`），字体 URL 带 `?v=<字节哈希>`
  （`service.ts:51-56`，sha256 前 8 位）。
- 接线：旧 `web` 把 `fontSmiley.css()` 追加进 `/assets/app.css`（`packages/web/src/layout.ts:180`、
  `service.ts:500`），并用 `file()` 的字节回 `/assets/fonts/dizzy-sans.woff2`。
  **这条路径在新前端不存在**（没有 SSR 拼 CSS 的地方）。

### 3.2 三个选项

| | (a) 插件注入 `@font-face` | (b) 字体进 `public/fonts/`（**推荐**） | (c) 系统字体栈 |
|---|---|---|---|
| 做法 | 保留 `font-smiley` 插件，由 `dashboard` 插件把 `@font-face` 拼进返回的 CSS / 发一个 `font.css`；`@theme` 里 `--font-sans` 指向它 | `build-subset.py` 产物复制进 `app/public/fonts/`，静态导出时随 `dist/` 发布；`@font-face` 写在构建期 CSS 里（`src/styles/dizzy/font.css`） | 删掉得意黑，`--font-sans` 换成中文系统栈（苹方/雅黑/Noto） |
| 字体字节谁发 | 插件（`/assets/fonts/…`），可自己定 `Cache-Control` | `dashboard` 插件发 `dist/` 里的静态文件（和别的静态资源同一条路径），也可自己定 header | 不发 |
| 内容哈希 + `immutable` | 插件在响应里加 `?v=<hash>`（现状做法） | **必须**让文件名带哈希（`dizzy-sans.<sha8>.woff2`）——原因见 §3.4 | 不适用 |
| `scope`（标题 / 正文）怎么切 | 插件运行期决定（现状 `scope: all`） | **构建期决定**：`--font-heading` 用它、`--font-sans` 不用（= `headings`）；或两者都用（= `all`）。改 scope 要重新构建 | 不适用 |
| 对构建产物的影响 | `dist/` 里没有字体，字节在插件 assets 里（**产物不变大**） | `dist/` 多 **508 KB**（字体随构建输出走，部署包变大） | 少 508 KB |
| 构建机网络/工具依赖 | 不新增（字体字节已在仓库） | 不新增（只是复制文件）；**若改用 `next/font/local` 则由 Next 处理产物** | 不新增 |
| OFL 义务 | 照旧：随分发带 `LICENSE` + 保留 name 表 ID 0/9/13/14（我们已经在做） | 同 (a)，**额外要确保 `LICENSE` 也进 `dist/`**（否则等于「分发字体不带许可」） | **若不再分发字体文件**则无义务；但仓库里的 `smiley-sans.woff2`（上游原版）不能再进任何产物 |
| 与我们现有代码的关系 | 保留 `font-smiley` 插件（少删一个包） | `font-smiley` 插件降级成「构建期资产来源 + 合规文书持有者」，运行期不再被 `web` 调用；`app.yml` 的 `font-smiley` 段可摘 | 删 `font-smiley` 插件 + 删 `app.yml:311-314` |
| 风险 | 静态导出没有「运行时拼 CSS」的位置，要额外发一个 CSS 文件并在 `<head>` 引（多一个请求、多一处版本串要管） | 字体名必须与 woff2 name 表**逐字一致**（把 `Dizzy Sans` 写进 CSS 时不能改字）；`public/` 默认 `max-age=0`，必须自己接管缓存 | 丢掉品牌观感（owner 当初特意要得意黑）；大字号标题观感差异明显 |

### 3.3 推荐 (b)，理由三条

1. **少一个运行期依赖**：字体是「静态字节」，进 `dist/` 后与 `_next/static/*` 同一条发布路径，
   插件只负责「读文件 + 定 header」，不需要再维护 `@font-face` 拼装与独立的 `/assets/fonts` 路由。
2. **`scope` 变成构建期常量**：`--font-heading` / `--font-sans` 在 CSS 里写死，
   Tailwind 工具类直接生效；再也不用「运行期改 scope → URL 要带新的 `?v=`」这套（旧前端为此专门
   写了一段注释解释为什么地址不能是常量，`packages/web/src/layout.ts:153`）。
3. **合规文书天然跟产物走**：`public/fonts/LICENSE.smiley-sans.txt` 会被静态导出一起带进 `dist/`，
   「分发字体必须带许可」自动满足，不靠人工记得。

### 3.4 选 (b) 的两条硬要求（不满足就是 bug）

1. **文件名必须带内容哈希**。Next 对 `public/` 的默认响应头是 `Cache-Control: public, max-age=0`
   （官方文档 <https://nextjs.org/docs/app/api-reference/file-conventions/public-folder> §Caching），
   而且 `public/` 里的文件**不会被 Next 改名加哈希**。所以：
   - 若我们把字体当普通静态文件发，一年 `immutable` 不成立（换字体后回访用户拿旧字节，
     这正是旧前端踩过并修掉的洞，见 `packages/font-smiley/src/config.ts:63-67` 的注释）；
   - 正确做法：`build-subset.py` 输出后追加一步，复制成 `dizzy-sans.<sha8>.woff2`，
     `@font-face` 里写这个带哈希的名字 → 文件名即版本串，`immutable` 才成立。
2. **`font-family` 名必须与字体内部家族名逐字一致**。woff2 里的家族名是 `Dizzy Sans`
   （`font-smiley/src/config.ts:23` 是唯一真源），CSS 里写错一个字符浏览器就**不会**用这个字体，
   而会静默回退到系统字体——这类 bug 不报错、只看截图才会发现。落地时把家族名抽成一个常量文件，
   CSS 里 `@theme --font-heading: 'Dizzy Sans', ...`，并在护栏测试里断言「CSS 里的家族名 ===
   woff2 里的 name ID 1」（旧前端有类似护栏，`packages/font-smiley/test/font.test.ts`）。

### 3.5 无论选哪个都必须做的 OFL 动作（一条都不能丢）

- `LICENSE` 全文（4,422 B，含版权行与保留字体名声明）**原样**随分发走。
- 字体 name 表 **ID 0（版权）/ 8（厂商）/ 9（设计者）/ 13（许可说明）/ 14（许可 URL）不动**；
  改过的只有主名字段 1/3/4/6/16（`NOTICE.md` §本站做的改动 2、§原样保留的义务）。
- 家族名与 PostScript 名继续用改名后的值（`Dizzy Sans` / `DizzySans-Regular`），
  **不得**使用保留名 `<Smiley>` / `<得意黑>`。
- 派生物仍以 OFL-1.1 发布、不得单独售卖、不得用原作者名义推广（`NOTICE.md` §原样保留的义务）。
- 若最终选 (c) 且**不再分发**字体文件：上游原版 `assets/smiley-sans.woff2`（1.15 MB）与子集都不许进 `dist/`。

---

## 4. 中文排版现状

**事实链**（全部实测）：

1. `globals.css:90` → `--font-sans: var(--font-geist)`；`--font-geist` 来自
   `next/font/google` 的 `Geist({ subsets: ["latin"], variable: "--font-geist" })`（`lib/fonts/registry.ts:39-42`）。
   **只加载 latin 子集**（另外 16 个备选字体也是同一个写法，`registry.ts:23-108`）。
2. `globals.css:135-138` → `body { font-family: var(--font-sans), system-ui, sans-serif }`；
   `globals.css:139-141` → `html { @apply font-sans }`。`--font-heading` 也指向 `--font-sans`（`:51`）。
3. 所以中文的落点：Geist 没有 CJK 字形 → 浏览器**逐字回退**到 `system-ui` → 再回退系统 CJK 字体
   （Windows 走微软雅黑、macOS 走苹方、Linux/Android 走 Noto Sans CJK）。**这三者的字重/字面差别不小**，
   同一个页面在不同系统上中文观感会不一样。
4. **没有任何 CJK 专门处理**：在 `src/` 里 grep `font-feature-settings` / `line-break` / `word-break` /
   `text-wrap` **零命中**；只有 Tailwind 的 `text-pretty` / `text-balance` **9 处**
   （`app/(external)/_components/intro.tsx:42`、`components/ui/alert-dialog.tsx:142`、
   `components/ui/alert.tsx:57`、`components/ui/empty.tsx:9,88`、`components/ui/field.tsx:136`、
   `components/ui/questionnaire.tsx:63,78` 等）——那是防孤行的排版属性，不是 CJK 处理。
5. **负字距遍布标题**：`tracking-tight`（`-0.025em`）在 `src/` 里 **73 处 / 47 个 .tsx 文件**
   （如 `dashboard/productivity/page.tsx:28`、`components/ui/empty.tsx:62`；
   全部 `tracking-*` 命中 84 处）。
   汉字是等宽方块，负字距会把笔画挤在一起；英文标题收紧是常规做法，中文不是。
6. Tailwind 默认 `--font-sans` 栈里**没有任何中文字体名**（见 §2.2 引用的 theme.css：`system-ui` 之后是
   `Roboto` / `Noto Sans` / `Arial` …），我们上游又把它整个替换成 `var(--font-geist)`，
   所以中文完全靠系统 fallback。

**建议（属设计判断，需 owner 认可后由 `界面`/`优化` 实现）**：

- `--font-sans` 显式写中文栈，不再依赖系统 linking：
  `Geist, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif`
  （顺序与旧前端 `tokens.ts:149-150` 一致，只是把 Inter 换成 Geist）。
- `--tracking-tight` 从 `-0.025em` 提到 **`-0.01em`**（或对中文标题直接不收紧）；
  `--tracking-normal` 提到 **`0.01em`**（= owner「字距放宽」那条要求的原值）。
- 中文行高建议略大：我们的九档里 `body 1.57` 已经比 Tailwind 默认 `1.5` 宽，照抄即可，不要为了「紧凑」
  把中文行高调回 1.5 以下。
- 可选（未实测）：`text-spacing-trim` / `font-feature-settings: "palt"` 对中文标点的效果因字体而异，
  得意黑子集里标点是否带 `palt` 特性未验证，**先不做**。

---

## 5. 落地步骤与依赖（下一批次照这个拆）

| # | 动作 | 谁做 | 落点 |
|---|---|---|---|
| 1 | 加 `app/src/styles/dizzy/tokens.css`（§2.3 草案）+ 在 `globals.css` 最前面 `@import` | 我（`优化`） | `packages/dashboard/app/src/styles/`、`globals.css:1-8` |
| 2 | 加 `dizzy` 主题预设（旧 `DARK_TOKENS` 配色）+ 跑 `generate:presets` 更新 `theme.ts` | 我 | `src/styles/presets/dizzy.css`、`src/lib/preferences/theme.ts` |
| 3 | boot script 增加 `--font-scale` / `--letter-spacing` 的 CSSOM 写入 | 我 + `界面` | `src/scripts/theme-boot.tsx` |
| 4 | **补 `/api/user/ui-preferences` GET/PUT**（跨设备同步的前提） | `交互` | `packages/api/src/routes/`（新增文件，不进 `http.ts`） |
| 5 | 字体按 (b) 落地：产物复制 + 带哈希文件名 + `@font-face` + `LICENSE` 进 `public/fonts/` | 我（待 owner 拍板） | `packages/dashboard/app/public/fonts/` |
| 6 | `font-smiley` 插件去留（(b) 下运行期不再需要，可降级或摘掉 `app.yml:311-314`） | `工具`（下线清单）/ 我 | `app.yml` |
| 7 | 各业务页用 `text-*` / `tracking-*` 工具类，不写死 px | `用量` / `管理台` | 各自页面 |
| 8 | 新前端的 CSP nonce 必须覆盖 `ThemeBootScript` 与 Next 的内联脚本 | `界面`（已列为头号风险） | `packages/dashboard/src/csp.ts` |

**与旧前端的口径衔接**：旧前端「字号进设置」的 UI 在 `packages/web/src/pages/profile.ts:72`（`renderSelect`），
新前端要做成 `components/ui` 的下拉；**存储格式不变**（`ui_preferences` JSON 三个字段），所以老用户的偏好
在新前端**天然继续生效**，不需要迁移脚本——这一点对 owner 很重要，别在新前端另起一套存储。

---

## 6. 未验证的部分（明写，别当已验证）

1. **本批次一行代码都没改**，四条命令的测试数字来自旧前端仓库（数字见提交信息），**不能代表新前端**。
2. **Tailwind 变量覆盖没有构建过**：`--text-*` / `--tracking-*` 的覆盖是否如预期生效、`calc(* var(--font-scale))`
   在 `--text-*` 里是否被 Tailwind 正常接受，都需要装依赖后构建一次、用 DevTools 看 computed `font-size` 才能确认。
3. **`@theme inline` 与「子树作用域」的关系**是规范推导（§1.3），没有构建验证。
4. **`next/font` 的产物命名**：文档只写了「self-hosting、同域」，没写产物文件名是否带内容哈希；
   §3.4 的方案**不依赖**这条（我们自己在文件名里带哈希），但若改用 `next/font/local` 需实测确认。
5. **字体在中文环境的实际观感**：没有起过新前端，所以「Geist + system-ui 回退」在 Windows / macOS
   上的具体差异、`tracking-tight` 对中文标题的影响，都**没有截图证据**（结论来自 CSS 事实 + 排版常识）。
6. **`ThemeBootScript` 在 CSP 下的可用性**：依赖 `界面` 的 nonce 改写方案，目前**未实现**。
7. **OFL 判断只做事实层**（保留了什么、改了什么），没有做法律意见；(c) 方案下「仓库内存着字体文件算不算分发」
   需要 owner 自己判断。
