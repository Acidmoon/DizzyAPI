import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import {
  FONT_FAMILY,
  FONT_FILE_NAME,
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

test('CSS：@font-face 指向自托管文件（带版本串），headings 不换正文', () => {
  const css = renderFontCss('headings', 'abcd1234')
  assert.ok(css.includes(`@font-face`))
  assert.ok(css.includes(`font-family: '${FONT_FAMILY}'`))
  // 版本串必须有：字体走 immutable 一年缓存，路径固定的话换了字体回访浏览器拿不到新版。
  assert.ok(css.includes(`url('${FONT_URL}?v=abcd1234') format('woff2')`))
  assert.ok(css.includes('font-display: swap'))
  assert.ok(css.includes('h1, h2'))
  assert.ok(!css.startsWith('body {'))
})

test('CSS：scope=all 时正文一起换，但模型名保留原字体', () => {
  const css = renderFontCss('all', 'abcd1234')
  assert.ok(css.includes('body { font-family:'))
  assert.ok(css.includes('.model-name { font-family: Inter'))
  // 标题不再单独列规则（body 已覆盖）
  assert.ok(!css.includes('h1, h2 {'))
})

test('字体文件：woff2 魔数与非空字节', () => {
  const bytes = readFontFile()
  // 子集化之后约 508 KB；这条下限只挡「不小心把空文件 / 占位文件提交上去」。
  assert.ok(bytes.length > 100_000)
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2')
})

test('子集：明显小于上游全量，且字体内部的名字不含 OFL 保留名', () => {
  // 上游全量 1_150_924 B（9497 个字形）。**这条守的是首屏体积**：`scope: all` 时
  // 字体是每页都要下的最大单笔资源，退回全量就等于把「公网 2.2～5.3 秒」装回来。
  const bytes = readFontFile()
  assert.ok(bytes.length < 600_000, `字体子集应 < 600 KB，实际 ${bytes.length} B`)

  // OFL-1.1 条件 3：删字形 = Modified Version，不得使用保留字体名
  //（上游声明的是 <Smiley> 与 <得意黑>）。改名必须发生在**字体内部**——
  // 只改 CSS 里的 font-family 不算数，拿到字体文件的人看到的仍是保留名。
  assert.ok(!/smiley/i.test(FONT_FAMILY), `字体家族名不得含保留名 Smiley：${FONT_FAMILY}`)
  assert.ok(!FONT_FAMILY.includes('得意黑'), `字体家族名不得含保留名 得意黑：${FONT_FAMILY}`)
  assert.equal(FONT_URL, `/assets/fonts/${FONT_FILE_NAME}`)
})

test('服务：默认配置下 css() 与 file() 可用', async () => {
  const ctx = new Context()
  await ctx.plugin(FontSmileyService)
  const font = ctx.get('fontSmiley') as FontSmileyService
  assert.equal(font.family, FONT_FAMILY)
  assert.equal(font.scope, 'headings')
  assert.ok(font.css().includes('@font-face'))
  const file = font.file()
  assert.equal(file.name, FONT_FILE_NAME)
  assert.equal(file.contentType, 'font/woff2')
  assert.ok(file.body.length > 0)
})
