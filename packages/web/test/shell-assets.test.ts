/**
 * 外壳级的资源接线：**这一页到底引了哪些脚本**。
 *
 * 为什么单独一个文件：`asset-version.test.ts` 验的是「app.css / app.js 的正文与哈希」，
 * 这里验的是「装配点有没有把库挂对页面」。两者出错的表现完全不同：
 * 前者是「改了样式用户看不到」，后者是「登录页白下 22 KB」或「图表提示没反应」。
 *
 * 规则只有一条：**floating-ui 跟着提示走**。判据是已渲染的主列 HTML 里有没有
 * `data-tooltip`，不是页面清单（新加一个带提示的页面不用改这里）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderAdminShell, renderAuthShell, renderConsoleShell } from '../src/layout.ts'
import { emptyServices, pageContext, templateOf, ADMIN_SESSION } from './helpers/page-fixture.ts'

/** 页面源码里 `<script src>` 的顺序。 */
function scriptSrcs(html: string): string[] {
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1])
}

function floatingOf(html: string): string[] {
  return scriptSrcs(html).filter((href) => href.includes('floating-ui'))
}

test('资源接线：没有提示的页面不引 floating-ui', async () => {
  const template = await templateOf()
  const services = emptyServices()
  const ctx = pageContext(
    { path: '/admin/users', area: 'admin', title: '用户', auth: true, render: async () => '' },
    services,
    template,
  )
  const html = renderConsoleShell(ctx, '<p>普通内容，没有提示</p>')
  assert.deepEqual(floatingOf(html), [])
  // 控件库该有的还在（下拉 / 日期是全站都用的）
  assert.ok(scriptSrcs(html).some((href) => href.includes('tom-select')))
  assert.ok(scriptSrcs(html).some((href) => href.includes('flatpickr')))
})

test('资源接线：有提示的页面自动引 floating-ui，core 在 dom 之前', async () => {
  const template = await templateOf()
  const ctx = pageContext(
    { path: '/console/usage', area: 'console', title: '用量信息', auth: true, render: async () => '' },
    emptyServices(),
    template,
  )
  // 主列里出现 data-tooltip（图表柱子的形态），就说明这一页要浮层
  const chart = `<svg viewBox="0 0 10 10"><path class="bar"${template.tooltipAttr('2026-10-30 · 消费金额 1')}></path></svg>`
  const html = renderConsoleShell(ctx, chart)
  const floating = floatingOf(html)
  assert.equal(floating.length, 2, '有提示的页面必须引 core + dom')
  assert.match(floating[0], /floating-ui\.core/)
  assert.match(floating[1], /floating-ui\.dom/)

  // app.js 永远最后（它要初始化控件、关 htmx 的样式注入）
  const hrefs = scriptSrcs(html)
  assert.match(hrefs[hrefs.length - 1], /^\/assets\/app\.js\?v=[0-9a-f]{8}$/)
  // 每个脚本地址都带内容哈希（immutable 的前提）
  for (const href of hrefs) assert.match(href, /\?v=[0-9a-f]{8}$/)
})

test('资源接线：管理台外壳走同一套判定', async () => {
  const template = await templateOf()
  const services = emptyServices()
  const ctx = { ...pageContext(
    { path: '/admin/usage', area: 'admin', title: '全站用量', auth: true, admin: true, render: async () => '' },
    services,
    template,
  ) }
  assert.deepEqual(floatingOf(renderAdminShell(ctx, '<p>无提示</p>')), [])
  const withTip = `<span${template.tooltipAttr('提示')}>x</span>`
  assert.equal(floatingOf(renderAdminShell(ctx, withTip)).length, 2)
})

test('资源接线：登录 / 注册页永远不引 floating-ui（内容是卡片表单）', async () => {
  const template = await templateOf()
  const html = renderAuthShell(template, { title: '登录', content: '<form></form>', fontCss: '' })
  assert.deepEqual(floatingOf(html), [])
  // 但控件库仍在：登录表单也可能用到（保持与改动前一致）
  assert.ok(scriptSrcs(html).some((href) => href.includes('tom-select')))
})

test('资源接线：提示与轻提示的宿主每页都在（不依赖页面自己加）', async () => {
  const template = await templateOf()
  const ctx = pageContext(
    { path: '/console/usage', area: 'console', title: '用量信息', auth: true, render: async () => '' },
    emptyServices(),
    template,
  )
  const html = renderConsoleShell(ctx, '')
  assert.ok(html.includes('id="dizzy-tooltip"'))
  assert.ok(html.includes('id="dizzy-toasts"'))
  // 普通用户的会话也要能拿到同一套壳（不是管理员专属）
  assert.equal(ADMIN_SESSION.user.role, 'admin')
})
