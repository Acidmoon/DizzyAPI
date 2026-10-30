/**
 * 界面偏好 → CSS（`/assets/theme.css` 的正文）。
 *
 * 这层只做两件事：把**档位 token** 翻成 CSS 变量、并且**再挡一次注入**。
 * 值虽然来自 `user` 插件校验过的 JSON，但这些数字会直接拼进样式表，
 * 所以 `renderThemeCss` 自己也必须能扛住脏值——否则「一处漏校验」就变成样式注入。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_THEME_PREFERENCES,
  FONT_SCALE_VALUES,
  LETTER_SPACING_EM,
  THEME_CSS_PATH,
  renderThemeCss,
} from '../src/theme.ts'

test('主题 CSS：只覆盖两个变量，且落在 :root 上', () => {
  const css = renderThemeCss({ fontScale: 1.25, letterSpacing: 'wide' })
  assert.match(css, /:root\s*\{/)
  assert.ok(css.includes('--font-scale: 1.25;'))
  assert.ok(css.includes(`--ls-normal: ${LETTER_SPACING_EM.wide};`))
  // 只碰这两个变量：包装细节（如 --fs-* / --lh-*）在 PAGE_CSS 里，由 --font-scale 派生。
  assert.equal(css.match(/--[a-z-]+:/g)?.length, 2)
})

test('主题 CSS：四个字号档位都能原样写进变量', () => {
  for (const scale of FONT_SCALE_VALUES) {
    assert.ok(renderThemeCss({ fontScale: scale, letterSpacing: 'normal' }).includes(`--font-scale: ${scale};`))
  }
})

test('主题 CSS：默认档位与不动主题等价（--ls-normal 等于 PAGE_CSS 的默认 0.01em）', () => {
  const css = renderThemeCss(DEFAULT_THEME_PREFERENCES)
  assert.ok(css.includes('--font-scale: 1;'))
  assert.ok(css.includes('--ls-normal: 0.01em;'))
})

test('主题 CSS：脏值一律回落默认，不做部分信任（注入面）', () => {
  // 这些值不应该出现在样式表里：能写出分号就等于能结束声明、开新规则。
  for (const bad of [
    { fontScale: 99, letterSpacing: 'normal' },
    { fontScale: Number.NaN, letterSpacing: 'normal' },
    { fontScale: 1, letterSpacing: 'wide; } body { display: none' },
    { fontScale: 1, letterSpacing: 'nope' },
  ]) {
    const css = renderThemeCss(bad)
    assert.ok(!css.includes('99'), '非法字号被写进去了')
    assert.ok(!css.includes('NaN'), 'NaN 被写进去了')
    assert.ok(!css.includes('display: none'), '非法字距被写进去了')
    // 回落成默认值
    assert.ok(css.includes('--font-scale: 1;'))
    assert.ok(css.includes('--ls-normal: 0.01em;'))
  }
})

test('主题 CSS：路径常量与 web 路由一致', () => {
  assert.equal(THEME_CSS_PATH, '/assets/theme.css')
})
