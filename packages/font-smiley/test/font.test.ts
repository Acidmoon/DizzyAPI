import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import {
  FONT_FAMILY,
  FONT_SMILEY_DEFAULTS,
  FONT_URL,
  FontSmileyService,
  readFontFile,
  renderFontCss,
  validateFontSmileyConfig,
} from '../src/index.ts'

test('配置：默认只作用于标题，非法值被拒', () => {
  const resolved = validateFontSmileyConfig({}) as { scope: string; enabled: boolean }
  assert.equal(resolved.scope, FONT_SMILEY_DEFAULTS.scope)
  assert.equal(resolved.enabled, true)
  assert.ok(Array.isArray(validateFontSmileyConfig({ scope: 'body' })))
  assert.ok(Array.isArray(validateFontSmileyConfig({ nope: 1 })))
})

test('CSS：@font-face 指向自托管文件，headings 不换正文', () => {
  const css = renderFontCss('headings')
  assert.ok(css.includes(`@font-face`))
  assert.ok(css.includes(`font-family: '${FONT_FAMILY}'`))
  assert.ok(css.includes(`url('${FONT_URL}') format('woff2')`))
  assert.ok(css.includes('font-display: swap'))
  assert.ok(css.includes('h1, h2'))
  assert.ok(!css.startsWith('body {'))
})

test('CSS：scope=all 时正文一起换，但模型名保留原字体', () => {
  const css = renderFontCss('all')
  assert.ok(css.includes('body { font-family:'))
  assert.ok(css.includes('.model-name { font-family: Inter'))
  // 标题不再单独列规则（body 已覆盖）
  assert.ok(!css.includes('h1, h2 {'))
})

test('字体文件：woff2 魔数与非空字节', () => {
  const bytes = readFontFile()
  assert.ok(bytes.length > 100_000)
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2')
})

test('服务：默认配置下 css() 与 file() 可用', async () => {
  const ctx = new Context()
  await ctx.plugin(FontSmileyService)
  const font = ctx.get('fontSmiley') as FontSmileyService
  assert.equal(font.family, FONT_FAMILY)
  assert.equal(font.scope, 'headings')
  assert.ok(font.css().includes('@font-face'))
  const file = font.file()
  assert.equal(file.name, 'smiley-sans.woff2')
  assert.equal(file.contentType, 'font/woff2')
  assert.ok(file.body.length > 0)
})
