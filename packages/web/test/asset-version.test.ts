/**
 * 静态资源的**装配与版本串**：`/assets/app.css` / `/assets/app.js` 的正文只有一处来源，
 * 页面里 `<link>` / `<script>` 的 `?v=` 必须是这份正文的哈希。
 *
 * 为什么值得单独测：这些字节用 `Cache-Control: immutable` 发出去（一年、不重新验证）。
 * 一旦「页面里的 URL」与「实际发出去的内容」之间没有哈希绑定，改完样式就等于没改——
 * 而且症状是「我这儿好好的、用户那儿是旧的」，排起来极慢。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VENDOR_THEME_CSS, vendorCss } from '@dizzyapi/plugin-page-template'
import { APP_CSS_BODY, APP_JS_BODY, APP_JS_HREF, appCssHref, shortHash, themeCssHref } from '../src/asset-version.ts'
import { documentAssets } from '../src/layout.ts'

test('版本串：href 里的哈希就是正文的哈希（含字体 CSS）', () => {
  const noFont = appCssHref('')
  assert.match(noFont, /^\/assets\/app\.css\?v=[0-9a-f]{8}$/)
  assert.match(APP_JS_HREF, /^\/assets\/app\.js\?v=[0-9a-f]{8}$/)
  assert.equal(noFont, `/assets/app.css?v=${shortHash(APP_CSS_BODY)}`)
  assert.equal(APP_JS_HREF, `/assets/app.js?v=${shortHash(APP_JS_BODY)}`)
  // 哈希只取前 8 位十六进制
  assert.equal(shortHash('x').length, 8)
  // 内容不同 → 哈希不同
  assert.notEqual(shortHash('a'), shortHash('b'))
})

test('版本串：字体 CSS 一变，app.css 的地址必须跟着变', () => {  // 这是「哈希洞」的回归用例：`/assets/app.css` 实际发的是 `APP_CSS_BODY + fontCss`，
  // 只哈希 APP_CSS_BODY 的话，改字体 scope / 换字体版本时地址不变 → immutable 缓存
  // 让回访浏览器一年内还在用旧 CSS。
  const a = appCssHref('@font-face { src: url(/f.woff2?v=11111111) }')
  const b = appCssHref('@font-face { src: url(/f.woff2?v=22222222) }')
  assert.notEqual(a, b)
  // 同一份字体 CSS 必须稳定（否则每页都换地址，缓存全失效）
  assert.equal(appCssHref('x'), appCssHref('x'))
  // 空字体与有字体也是两个地址
  assert.notEqual(appCssHref(''), a)
})

test('app.css 的装配顺序是契约：vendor 主题必须排在 vendorCss 之后', () => {
  // 同优先级下后者胜：主题覆盖排在前面就会被 vendor 的浅色主题盖回去
  // （表现为「下拉框又变白了」）。
  const vendorAt = APP_CSS_BODY.indexOf(vendorCss())
  const themeAt = APP_CSS_BODY.indexOf(VENDOR_THEME_CSS)
  assert.ok(vendorAt > 0, 'app.css 里没有 vendor 的 CSS')
  assert.ok(themeAt > 0, 'app.css 里没有 vendor 主题覆盖')
  assert.ok(themeAt > vendorAt, 'vendor 主题覆盖必须排在 vendorCss 之后')
})

test('app.js 的正文含控件脚本与复制按钮（两段都真的发出去了）', () => {
  // 控件升级：有钩子没脚本 = 控件永远升不上去（和「写了内联样式被 CSP 丢掉」同类）。
  assert.match(APP_JS_BODY, /upgradeControls/)
  assert.match(APP_JS_BODY, /data-tom-select/)
  // 复制按钮：一次性 key / 文档整页复制都靠它
  assert.match(APP_JS_BODY, /data-copy/)
  // 原生 confirm 已经彻底移除（改由自绘确认框承担）
  assert.ok(!/window\.confirm\s*\(/.test(APP_JS_BODY), 'app.js 里还在调 window.confirm')
})

test('版本串：主题表也带哈希，且同一份偏好稳定', () => {
  // 主题表是按用户生成的，但「地址带内容哈希」这条与 app.css 一样：
  // 没有版本串的 immutable/private 缓存会让改档位后刷新看不到变化。
  const a = themeCssHref(':root{--font-scale:1.25;}')
  const b = themeCssHref(':root{--font-scale:1.5;}')
  assert.match(a, /^\/assets\/theme\.css\?v=[0-9a-f]{8}$/)
  assert.notEqual(a, b)
  assert.equal(themeCssHref(':root{--font-scale:1.25;}'), a)
})

test('脚本：floating-ui 只挂在真的有提示的页面上，且 app.js 永远最后', () => {
  // 22 KB 的 floating-ui 不该出现在登录页（上一批驳回的就是「每页下载用不到的库」）。
  const plain = documentAssets('').jsHrefs
  const rich = documentAssets('', '', { tooltips: true }).jsHrefs

  const floating = (hrefs: readonly string[]): string[] => hrefs.filter((href) => href.includes('floating-ui'))
  assert.deepEqual(floating(plain), [], '没有提示的页面不该引 floating-ui')
  assert.equal(floating(rich).length, 2, '有提示的页面必须引 core + dom')
  // 顺序：core 在 dom 之前（dom 的 UMD 读全局 FloatingUICore）
  assert.match(rich[rich.indexOf(rich.find((h) => h.includes('floating-ui.core'))!) + 1] ?? '', /floating-ui\.dom/)

  // 两条路径都必须以 app.js 结尾（它在最后才能初始化控件）
  assert.equal(plain[plain.length - 1], APP_JS_HREF)
  assert.equal(rich[rich.length - 1], APP_JS_HREF)
  // 公共部分（tom-select / flatpickr）两条路径一致，说明过滤没有误伤
  const shared = (hrefs: readonly string[]): string[] => hrefs.filter((href) => href.includes('tom-select') || href.includes('flatpickr'))
  assert.deepEqual(shared(plain), shared(rich))
  // 每个 href 都带内容哈希（immutable 的前提）
  for (const href of [...plain, ...rich]) assert.match(href, /\?v=[0-9a-f]{8}$/)
})

test('样式：提示与轻提示的 CSS 都在 app.css 正文里（否则浮层是裸的）', () => {
  assert.ok(APP_CSS_BODY.includes('.tooltip {'), 'app.css 缺 tooltip 样式')
  assert.ok(APP_CSS_BODY.includes('.toasts {'), 'app.css 缺 toast 宿主样式')
  // 脚本侧：两段行为都真的发出去了
  assert.match(APP_JS_BODY, /dizzy-tooltip/)
  assert.match(APP_JS_BODY, /dizzyToast/)
})