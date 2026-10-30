/**
 * 可访问性与交互反馈的护栏。
 *
 * 这些断言守的是 **Vercel Web Interface Guidelines** 里最容易被改回去的几条：
 * 键盘焦点看得见、表单控件说得出名字、点击立刻有反馈、动效尊重系统偏好。
 *
 * 为什么单独一个文件：它们不是某个组件的功能测试，而是「这一批规范有哪几条、
 * 有没有被悄悄退回去」的清单。看这一个文件就知道底线在哪。
 *
 * `style="…"` 那条不在这里：页面级护栏在 `packages/web/test/pages-guards.test.ts`，
 * 而且 2026-10-30 已实测清零（全仓 `style="` 只剩 layout-classes.ts 的注释文字）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { A11Y_CSS } from '../src/a11y.ts'
import { CLIENT_JS } from '../src/assets.ts'
import { renderDocument } from '../src/document.ts'
import { FEEDBACK_JS } from '../src/client-feedback.ts'
import { MAIN_COLUMN_ID, MAIN_COLUMN_OPEN, renderMainColumn } from '../src/main-column.ts'
import { renderModal } from '../src/modal.ts'
import { renderShell } from '../src/sidebar.ts'
import {
  renderAuthPage,
  renderField,
  renderNotice,
  renderPageHeader,
  renderTable,
} from '../src/shell.ts'

const TEMPLATE_DIR = join(import.meta.dirname, '..', 'src')

/** 模板 CSS / TS 源码（去掉注释，避免「注释里提到某个反模式」被当成违规）。 */
function templateSources(): { readonly name: string; readonly code: string }[] {
  return readdirSync(TEMPLATE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({
      name,
      code: readFileSync(join(TEMPLATE_DIR, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, ''),
    }))
}

// ─────────────────────── 焦点可见 ───────────────────────

test('焦点：必须有 :focus-visible 环，且模板里不许出现裸的 outline: none', () => {
  // 裸的 `outline: none` 会把原生焦点环摘掉却不给替代 —— 键盘用户彻底看不见
  // 焦点在哪（WCAG 2.4.7）。这是本项目踩过的坑：`.input` 上就有一处。
  assert.match(A11Y_CSS, /:focus-visible/)
  for (const { name, code } of templateSources()) {
    // `.input:focus-visible { ... }` 这类带伪类的写法是允许的（它正是「替代环」）。
    const bare = code.match(/outline:\s*none/g) ?? []
    assert.deepEqual(bare, [], `${name} 还有裸的 outline: none`)
  }
})

test('焦点：焦点环画在不被裁掉的位置（面板 / 表格内改用内描边）', () => {
  // `.panel` 与 `.table` 都是 overflow: hidden（为了圆角），外侧环会被裁成半圈。
  assert.match(A11Y_CSS, /\.panel :focus-visible/)
  assert.match(A11Y_CSS, /outline-offset:\s*-2px/)
})

// ─────────────────────── 跳过链接与地标 ───────────────────────

test('跳过链接：外壳第一个可聚焦元素是「跳到主内容」，落点带 id 且可聚焦', () => {
  const html = renderShell({ brand: { word: 'D', href: '/' }, nav: [], content: '' })
  const shellStart = html.indexOf('<div class="shell">')
  const skipAt = html.indexOf('class="skip-link"')
  assert.ok(skipAt > shellStart, '跳过链接必须在 shell 里')
  assert.ok(skipAt < html.indexOf('<aside'), '跳过链接必须在侧栏之前（否则 Tab 还得走侧栏）')
  assert.ok(html.includes('href="#main-content"'))
  // 落点必须自己可聚焦（tabindex="-1"），否则只是滚了一下、焦点没跟过去。
  assert.ok(html.includes(`id="${MAIN_COLUMN_ID}" tabindex="-1"`))
  // 主列的开始标记不能变（htmx 片段切割靠它逐字匹配）。
  assert.ok(html.includes(MAIN_COLUMN_OPEN))
})

test('地标：登录 / 注册卡用 <main>（没有侧栏时也得有正文地标）', () => {
  const html = renderAuthPage({ title: '登录', content: '' })
  assert.match(html, /^<main class="auth-wrap">/)
  assert.ok(html.includes('</main>'))
})

test('层级：<h1> 不再重复声明 role="heading" aria-level', () => {
  const html = renderPageHeader({ title: '用量信息' })
  assert.ok(html.startsWith('<h1 class="page-title">'))
  assert.ok(!html.includes('role="heading"'))
})

test('表格：表头带 scope="col"（读屏念单元格时才带列名）', () => {
  const html = renderTable({ columns: [{ label: '金额', align: 'right' }], rows: [['¥1.00']] })
  assert.ok(html.includes('<th scope="col" class="num">金额</th>'))
})

// ─────────────────────── 视口与缩放 ───────────────────────

test('视口：不许禁缩放（user-scalable=no / maximum-scale 是明确的 anti-pattern）', () => {
  const html = renderDocument({ title: 't', body: '' })
  assert.ok(html.includes('content="width=device-width,initial-scale=1"'))
  assert.ok(!html.includes('user-scalable'), 'user-scalable 会挡住用户放大文字')
  assert.ok(!html.includes('maximum-scale'), 'maximum-scale=1 同样等于禁缩放')
})

// ─────────────────────── 表单 ───────────────────────

test('表单：label 指向真实控件；邮箱关拼写检查、给 inputmode 与正确 autocomplete', () => {
  const html = renderField({
    label: '邮箱',
    name: 'email',
    type: 'email',
    required: true,
    autocomplete: 'username',
    placeholder: 'you@example.com',
  })
  assert.ok(html.includes('<label for="f-email">邮箱</label>'))
  assert.ok(html.includes('id="f-email"'))
  assert.ok(html.includes('spellcheck="false"'))
  assert.ok(html.includes('inputmode="email"'))
  assert.ok(html.includes('autocomplete="username"'))
  assert.ok(html.includes(' required'))
})

test('表单：占位符以「…」结尾，且已是「…」的不重复加', () => {
  assert.ok(renderField({ label: '名称', name: 'name', placeholder: '例如：本地开发' })
    .includes('placeholder="例如：本地开发…"'))
  assert.ok(renderField({ label: '头像', name: 'avatar', placeholder: 'https://…' })
    .includes('placeholder="https://…"'))
})

test('表单：非认证字段默认 autocomplete="off"（别让密码管理器乱弹）', () => {
  assert.ok(renderField({ label: '模型', name: 'model' }).includes('autocomplete="off"'))
})

test('表单：同名字段出现多次时必须能指定唯一 id（否则 label 全部指向第一个）', () => {
  const html = renderField({ label: '名称', name: 'name', id: 'f-name-7' })
  assert.ok(html.includes('<label for="f-name-7">'))
  assert.ok(html.includes('id="f-name-7"'))
})

test('表单：说明与错误都要进 aria-describedby，错误就地渲染并标 aria-invalid', () => {
  const hintOnly = renderField({ label: '新密码', name: 'newPassword', type: 'password', hint: '至少 8 位' })
  assert.ok(hintOnly.includes('id="f-newPassword-hint"'))
  assert.ok(hintOnly.includes('aria-describedby="f-newPassword-hint"'))
  assert.ok(!hintOnly.includes('aria-invalid'))

  const both = renderField({
    label: '名称',
    name: 'name',
    hint: '1..20 个字符',
    error: '名称不能为空',
  })
  assert.ok(both.includes('aria-describedby="f-name-hint f-name-error"'))
  assert.ok(both.includes('aria-invalid="true"'))
  assert.ok(both.includes('<p class="field-error" id="f-name-error" role="alert">名称不能为空</p>'))
})

// ─────────────────────── 提示条 ───────────────────────

test('提示条：失败用 role="alert" 并可聚焦，成功用 status + aria-live', () => {
  const err = renderNotice({ kind: 'err', text: '名称不能为空', field: 'name' })
  assert.ok(err.includes('role="alert"'))
  assert.ok(err.includes('tabindex="-1"'))
  assert.ok(err.includes('data-field="name"'))

  const ok = renderNotice({ kind: 'ok', text: '已保存' })
  assert.ok(ok.includes('role="status"'))
  assert.ok(ok.includes('aria-live="polite"'))
  assert.ok(!ok.includes('data-field'))
})

// ─────────────────────── 图标 ───────────────────────

test('图标：装饰性 SVG 不进无障碍树；关闭按钮有 aria-label', () => {
  const modal = renderModal({ id: 'm', title: '编辑', bodyHtml: '' })
  assert.ok(modal.includes('aria-label="关闭"'))
  assert.ok(modal.includes('aria-labelledby="m-title"'))
  // 图标本身的 aria-hidden 在 icons.ts，这里抽查外壳用到的那个。
  const header = renderPageHeader({ title: 'T', note: '说明' })
  assert.ok(header.includes('aria-hidden="true"'))
})

// ─────────────────────── 动效与触控 ───────────────────────

test('动效：尊重 prefers-reduced-motion，且模板里没有 transition: all', () => {
  assert.match(A11Y_CSS, /prefers-reduced-motion:\s*reduce/)
  assert.match(A11Y_CSS, /transition-duration:\s*\.01ms !important/)
  for (const { name, code } of templateSources()) {
    assert.ok(!/transition:\s*all/.test(code), `${name} 里出现了 transition: all（要显式列属性）`)
  }
})

test('触控：touch-action / tap-highlight / 浮层滚动链都显式设置', () => {
  assert.match(A11Y_CSS, /touch-action:\s*manipulation/)
  assert.match(A11Y_CSS, /-webkit-tap-highlight-color/)
  assert.match(A11Y_CSS, /overscroll-behavior:\s*contain/)
})

// ─────────────────────── 交互反馈（点了没反应）───────────────────────

test('反馈：提交瞬间就有待定态（按钮文案 + aria-busy + 只放行一次提交）', () => {
  // 站点是表单 POST + 303 整页刷新；点下去到新页面之间浏览器是静默的，
  // 没有这段脚本用户就只能猜「是不是没点上」。
  assert.match(FEEDBACK_JS, /window\.dizzyPending = markPending/)
  assert.ok(FEEDBACK_JS.includes("setAttribute('data-pending', 'done')"))
  assert.ok(FEEDBACK_JS.includes("setAttribute('aria-busy', 'true')"))
  assert.ok(FEEDBACK_JS.includes('is-pending'))
  // 文案带省略号（指南：加载态一律以「…」结尾）
  assert.ok(FEEDBACK_JS.includes("label + '…'"))
  // 不用 disabled 属性：按钮的 name / value 必须照常进表单数据
  assert.ok(!/button\.disabled\s*=/.test(FEEDBACK_JS))
  // bfcache 恢复要还原，否则后退回来按钮永远是「保存…」
  assert.match(FEEDBACK_JS, /addEventListener\('pageshow', restore\)/)
})

test('反馈：失败错误就地显示在字段下方并聚焦，原生校验不用浏览器气泡', () => {
  assert.ok(FEEDBACK_JS.includes("'.notice.err[data-field]'"))
  assert.ok(FEEDBACK_JS.includes('setFieldError'))
  assert.ok(FEEDBACK_JS.includes('aria-describedby'))
  assert.match(FEEDBACK_JS, /addEventListener\('invalid'/)
  assert.ok(FEEDBACK_JS.includes('event.preventDefault()'), '原生校验气泡要取消，改成就地文字')
})

test('反馈：待定态与错误定位脚本真的进了 /assets/app.js', () => {
  assert.ok(CLIENT_JS.includes('window.dizzyPending'))
  assert.ok(CLIENT_JS.includes('data-field'))
  assert.ok(CLIENT_JS.includes("classList.add('is-pending')"))
})

test('反馈：确认框走程序化 submit 时也会点亮待定态', () => {
  // form.submit() 不触发 submit 事件，漏了这一句就会出现「确认之后毫无反应」。
  assert.match(CLIENT_JS, /window\.dizzyPending\(form\)/)
})
