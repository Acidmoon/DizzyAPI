/**
 * 页面源码的**结构性护栏**：不是测某个页面的行为，而是守住几条「以后不许退回去」的规矩。
 *
 * 为什么单独一个文件：这些断言跨页面、跨主题（内联样式 / 原生控件 / 类名存在性），
 * 塞进某个页面自己的测试文件里会被误当成那个页面的用例。放在一起，
 * 一眼能看出「这批规矩」有哪几条、哪些还没做。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 页面源码目录（`packages/web/src/pages`，一页一个文件）。 */
const PAGES_DIR = join(import.meta.dirname, '..', 'src', 'pages')
/** 页面模板的 CSS 源码目录。 */
const TEMPLATE_DIR = join(import.meta.dirname, '..', '..', 'page-template', 'src')

function pageFiles(): { readonly name: string; readonly text: string }[] {
  return readdirSync(PAGES_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(join(PAGES_DIR, name), 'utf8') }))
}

// ─────────────────────── 内联样式 ───────────────────────

test('护栏：页面里不许再出现内联 style="…"（CSP 会静默丢弃它）', () => {
  // 为什么是硬规矩：站点 CSP 是 `style-src 'self'`，HTML 里的 style 属性
  // **会被浏览器静默丢弃**——`getAttribute('style')` 读得到值，
  // 但 `getComputedStyle` 拿到的还是旧值。写了等于没写，还让人以为改过了。
  // 2026-10-29 实测：全站原有 27 处内联样式，全部从未生效。
  const offenders: string[] = []
  for (const { name, text } of pageFiles()) {
    const matches = text.match(/style="/g) ?? []
    if (matches.length > 0) offenders.push(`${name} ×${matches.length}`)
  }
  assert.deepEqual(offenders, [], `这些文件还有内联样式：${offenders.join('、')}`)
})

test('护栏：模板 CSS 里不许有硬编码 px 字号 / 行高', () => {
  // 字号只有 FONT_ROLES 一个源；行高必须是无单位倍数，否则用户调大字号时文字重叠。
  const files = readdirSync(TEMPLATE_DIR).filter((n) => n.endsWith('.ts'))
  for (const name of files) {
    const text = readFileSync(join(TEMPLATE_DIR, name), 'utf8')
    if (!text.includes('font-size:')) continue
    const pxSize = text.match(/font-size:\s*[0-9.]+px/g) ?? []
    const pxLine = text.match(/line-height:\s*[0-9.]+px/g) ?? []
    assert.deepEqual(pxSize, [], `${name} 还有硬编码 px 字号`)
    assert.deepEqual(pxLine, [], `${name} 还有硬编码 px 行高`)
  }
})

// ─────────────────────── 原生控件 ───────────────────────

test('护栏：页面里不许再出现原生下拉控件', () => {
  // 原生 <select> 的下拉浮层由浏览器绘制，CSS 碰不到，样式完全不可控。
  // 第 3 条要求换成 Tom Select。2026-10-29 实测全站原有 6 处 / 4 个文件。
  const offenders: string[] = []
  for (const { name, text } of pageFiles()) {
    if (/<select[\s>]/.test(text)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `这些文件还有原生 select：${offenders.join('、')}`)
})

test('护栏：页面里不许再出现原生日期输入', () => {
  // 同理：日期选择器的日历浮层由浏览器绘制，CSS 碰不到。
  const offenders: string[] = []
  for (const { name, text } of pageFiles()) {
    if (/type="date"/.test(text)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `这些文件还有原生 date 输入：${offenders.join('、')}`)
})

test('护栏：不用 window.confirm（原生模态框不可样式化）', () => {
  // window.confirm 是浏览器画的模态框，样式完全不可控，且阻塞整个页面。
  const offenders: string[] = []
  for (const { name, text } of pageFiles()) {
    if (text.includes('window.confirm')) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `这些文件还有 window.confirm：${offenders.join('、')}`)
})

/** 去掉注释再扫：注释里写 `<dialog>` 解释降级方案是正常的，不该被当成裸标签。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('护栏：不用 alert / prompt，也不手写裸 <dialog>（弹窗一律走 t.renderModal）', () => {
  // 第 3 条要求所有弹窗与浮层都是自研控件：alert / prompt 是浏览器画的，
  // 手写 <dialog> 会绕过模板里那套 class 与 `data-dialog-backdrop`，视觉与行为都会飘。
  const offenders: string[] = []
  for (const { name, text } of pageFiles()) {
    const code = stripComments(text)
    const hits = [
      code.includes('alert(') ? 'alert(' : '',
      code.includes('prompt(') ? 'prompt(' : '',
      /<dialog[\s>]/.test(code) ? '<dialog>' : '',
    ].filter((item) => item !== '')
    if (hits.length > 0) offenders.push(`${name}（${hits.join('、')}）`)
  }
  assert.deepEqual(offenders, [], `这些文件用了浏览器默认弹窗：${offenders.join('、')}`)
})

// ─────────────────────── 类名存在性 ───────────────────────

test('护栏：页面用到的修饰类都必须在模板 CSS 里有定义', () => {
  // 防止「class 写了但样式没写」——那和内联样式被丢弃一样，是无声的失败。
  const templateCss = readFileSync(join(TEMPLATE_DIR, 'layout-classes.ts'), 'utf8')
    + readFileSync(join(TEMPLATE_DIR, 'extra-styles.ts'), 'utf8')
    + readFileSync(join(TEMPLATE_DIR, 'assets.ts'), 'utf8')

  const known = new Set<string>()
  for (const m of templateCss.matchAll(/\.([a-z][a-z0-9-]*)/gi)) known.add(m[1])

  const missing = new Set<string>()
  for (const { name, text } of pageFiles()) {
    for (const m of text.matchAll(/class="([^"]+)"/g)) {
      for (const cls of m[1].split(/\s+/)) {
        if (cls === '') continue
        // 只查我们自己的修饰类（带 --），普通组件类由各自的组件文件定义
        if (!cls.includes('--')) continue
        if (!known.has(cls)) missing.add(`${name}: ${cls}`)
      }
    }
  }
  assert.deepEqual([...missing], [], `页面用了模板里没定义的修饰类：${[...missing].join('、')}`)
})
