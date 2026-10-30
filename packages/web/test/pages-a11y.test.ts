/**
 * 页面层的可访问性护栏（跨页面，不是某一页的功能测试）。
 *
 * 模板层的规范在 `packages/page-template/test/a11y.test.ts`（焦点环、跳过链接、
 * 表单字段、提示条…）。这里只盯**页面自己写的那部分 HTML**：
 * 页面作者容易忘的事（内联事件、div 冒充按钮、用三连点代替「…」）。
 *
 * 另外两条是「错误就地显示」的**行为**护栏：出错字段要能传到页面上，
 * 页面渲染出来的提示条要带 `data-field`（客户端据此把它搬到字段下方）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loginPage } from '../src/pages/login.ts'
import { registerPage } from '../src/pages/register.ts'
import { keysPage } from '../src/pages/keys.ts'
import { WebError } from '../src/forms.ts'
import { emptyServices, renderPage, runAction } from './helpers/page-fixture.ts'
import type { ApiKeyLike } from '../src/runtime.ts'
import type { WebRuntime } from '../src/runtime.ts'

const PAGES_DIR = join(import.meta.dirname, '..', 'src', 'pages')

/** 页面源码（去掉注释：注释里写反例是正常的）。 */
function pageSources(): { readonly name: string; readonly code: string }[] {
  return readdirSync(PAGES_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({
      name,
      code: readFileSync(join(PAGES_DIR, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, ''),
    }))
}

// ─────────────────────── 语义优先（页面源码）───────────────────────

test('护栏：页面里不许出现内联事件属性（CSP 拦 + 语义该走 <button>/<a>）', () => {
  // 站点 CSP 是 script-src 'self'，`onclick="…"` 这类内联处理器本来就被拦；
  // 就算放开，也应该用 <button> 而不是给 <div> 挂点击。
  const offenders: string[] = []
  for (const { name, code } of pageSources()) {
    if (/\son(click|change|input|submit|keydown|keyup|focus|blur)=/i.test(code)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `这些页面还有内联事件属性：${offenders.join('、')}`)
})

test('护栏：文案用「…」不用三连点', () => {
  // 中文排版规范：省略号是单个字符「…」，`...` 在通知 / 按钮里会被拉成奇怪的间距。
  // 注意排除**展开语法**（`...name` / `...(x)` / `...{}`）：那不是文案。
  const offenders: string[] = []
  for (const { name, code } of pageSources()) {
    if (/\.\.\.(?![\w$([{])/.test(code)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `这些页面用了三连点：${offenders.join('、')}`)
})

// ─────────────────────── 表单语义（渲染结果）───────────────────────

test('登录页：邮箱字段 label / id 对得上，关拼写检查，给示例占位符', async () => {
  const html = await renderPage(loginPage, emptyServices())
  assert.ok(html.includes('<label for="f-email">邮箱</label>'))
  assert.ok(html.includes('id="f-email"'))
  assert.ok(html.includes('spellcheck="false"'))
  assert.ok(html.includes('inputmode="email"'))
  assert.ok(html.includes('autocomplete="username"'))
  assert.ok(html.includes('placeholder="you@example.com…"'))
  // 密码字段不该有 placeholder（别把密码规则写在能被截图的地方）
  assert.ok(html.includes('autocomplete="current-password"'))
})

test('注册页：验证码走数字键盘、关拼写检查，用户名有示例占位符', async () => {
  // 第一步：邮箱 / 用户名 / 密码
  const request = await renderPage(registerPage, emptyServices())
  assert.ok(request.includes('placeholder="you@example.com…"'))
  assert.ok(request.includes('placeholder="例如：张三…"'))
  // 第二步（?step=confirm）：验证码
  const confirm = await renderPage(registerPage, emptyServices(), 'step=confirm&email=a%40b.c')
  assert.ok(confirm.includes('id="f-code"'))
  assert.ok(confirm.includes('inputmode="numeric"'))
  assert.ok(confirm.includes('autocomplete="one-time-code"'))
  assert.ok(confirm.includes('spellcheck="false"'))
})

// ─────────────────────── 错误就地显示（行为）───────────────────────

/** 最小 API key 桩：列表给一条，写操作不该被调到。 */
function apiKeyStub(): ApiKeyLike {
  return {
    async list() {
      return [{
        id: 'k1',
        userId: 7,
        name: '本地开发',
        trackingId: 'trk-1',
        secret: null,
        maskedKey: 'sk-…abcd',
        enabled: true,
        appManaged: false,
        createdAt: '2026-10-01T00:00:00.000Z',
        lastUsedAt: null,
        rotatedAt: null,
        expiresAt: null,
        spendingLimitMicros: null,
        concurrencyLimit: null,
      }]
    },
    async listAll() {
      return []
    },
    async create() {
      throw new Error('不该到这里')
    },
    async update() {
      throw new Error('不该到这里')
    },
    async rotate() {
      throw new Error('不该到这里')
    },
    async remove() {
      throw new Error('不该到这里')
    },
  }
}

function servicesWithKeys(): WebRuntime {
  return { ...emptyServices(), apiKey: apiKeyStub() }
}

test('错误：必填字段为空时抛出的错误带着字段名（失败回跳才知道往哪儿写）', async () => {
  await assert.rejects(
    () => runAction(keysPage, servicesWithKeys(), 'edit', 'id=k1&name='),
    (error: unknown) => {
      assert.ok(error instanceof WebError)
      assert.equal(error.code, 'WEB_FIELD_REQUIRED')
      assert.equal(error.field, 'name', '错误必须标明是哪个字段的错')
      return true
    },
  )
})

test('错误：隐藏的技术字段（id）不挂 field——它没有可见控件可以抬头', async () => {
  await assert.rejects(
    () => runAction(keysPage, servicesWithKeys(), 'edit', 'id=&name=x'),
    (error: unknown) => {
      assert.ok(error instanceof WebError)
      assert.equal(error.field, undefined)
      return true
    },
  )
})

test('错误：页面把出错字段交给提示条（data-field），客户端据此就地显示', async () => {
  const html = await renderPage(
    keysPage,
    servicesWithKeys(),
    `err=${encodeURIComponent('名称不能为空')}&field=name`,
  )
  assert.ok(html.includes('role="alert"'), '失败提示必须是 role="alert"')
  assert.ok(html.includes('data-field="name"'), '提示条必须带上出错字段')
  // 就地那条由客户端脚本搬过去；没有脚本时页顶这条就是唯一入口，信息不能丢。
  assert.ok(html.includes('名称不能为空'))
})

test('错误：与字段无关的失败不写 data-field（否则脚本会去找一个不存在的字段）', async () => {
  const html = await renderPage(
    keysPage,
    servicesWithKeys(),
    `err=${encodeURIComponent('操作失败，请稍后再试')}`,
  )
  assert.ok(html.includes('role="alert"'))
  assert.ok(!html.includes('data-field='))
})
