/**
 * CSP 头的护栏。
 *
 * 起因（真浏览器实测发现）：`style-src 'self'` 会把 **sonner 运行时注入的那段
 * `<style>`** 一起拦掉 —— 五个页面每个都报 2 条 `style-src-elem` 违规，轻提示
 * 因此掉样式。修法不是放开 `unsafe-inline`，而是给那一段算 sha256 写进 `style-src`。
 *
 * 这里的断言钉三件事：
 * 1. `style-src` 里**只有两个 sha256**（空字符串 + sonner 那段正文），**不许出现 `unsafe-inline`**；
 * 2. `style-src-attr` 仍是 `'unsafe-inline'`（Radix 浮层定位 / 侧栏宽度 / recharts 尺寸
 *    靠 React 的 `style` 属性，owner 2026-10-31 拍板按上游模版走）；
 * 3. `script-src` 仍是 `'self' + nonce`，没有 `unsafe-inline` / `unsafe-eval`。
 *
 * **升级 sonner 之后这里会红吗**：不会 —— 它只钉「形状」，不钉具体 hash 值。
 * 具体 hash 的真实校验在 `npm run verify` 的真浏览器实测里（页面 console 零 CSP 报错）。
 * 升级 sonner 时重量的方法见 `packages/dashboard/README.md` 的「CSP」一节。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { contentSecurityPolicy, injectScriptNonce, newNonce } from '../src/csp.ts'

function directives(header: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const space = trimmed.indexOf(' ')
    const name = space < 0 ? trimmed : trimmed.slice(0, space)
    const value = space < 0 ? '' : trimmed.slice(space + 1)
    map.set(name, value)
  }
  return map
}

test('CSP：style-src 只放行一个 sha256，且不含 unsafe-inline', () => {
  const header = contentSecurityPolicy(newNonce())
  const dirs = directives(header)
  const styleSrc = dirs.get('style-src')
  assert.ok(styleSrc !== undefined, 'CSP 必须有 style-src')

  const hashes = styleSrc.match(/'sha256-[A-Za-z0-9+/]+=*'/g) ?? []
  assert.equal(hashes.length, 2, `style-src 应有 2 个 sha256（空串 + sonner 正文），实际：${hashes.join(', ')}`)
  assert.match(styleSrc, /'self'/)
  assert.doesNotMatch(styleSrc, /unsafe-inline/)
  assert.doesNotMatch(styleSrc, /unsafe-eval/)
})

test('CSP：style-src-attr 仍是 unsafe-inline（只放开 style 属性）', () => {
  const dirs = directives(contentSecurityPolicy(newNonce()))
  assert.equal(dirs.get('style-src-attr'), "'unsafe-inline'")
})

test('CSP：script-src 是 self + nonce，没有 unsafe-inline / unsafe-eval', () => {
  const nonce = newNonce()
  const dirs = directives(contentSecurityPolicy(nonce))
  const scriptSrc = dirs.get('script-src')
  assert.ok(scriptSrc !== undefined)
  assert.match(scriptSrc, /'self'/)
  assert.ok(scriptSrc.includes(`'nonce-${nonce}'`), 'script-src 必须带上本次的 nonce')
  assert.doesNotMatch(scriptSrc, /unsafe-inline/)
  assert.doesNotMatch(scriptSrc, /unsafe-eval/)
})

test('CSP：每次调的 nonce 都不同（不能固定成常量）', () => {
  assert.notEqual(newNonce(), newNonce())
  assert.notEqual(contentSecurityPolicy(newNonce()), contentSecurityPolicy(newNonce()))
})

test('CSP：其余指令保持收紧', () => {
  const dirs = directives(contentSecurityPolicy(newNonce()))
  assert.equal(dirs.get('default-src'), "'self'")
  assert.equal(dirs.get('object-src'), "'none'")
  assert.equal(dirs.get('base-uri'), "'self'")
  assert.equal(dirs.get('form-action'), "'self'")
  assert.equal(dirs.get('frame-ancestors'), "'none'")
})

test('CSP：内联 script 补 nonce，外部脚本不补', () => {
  const nonce = newNonce()
  const html = '<script>self.x=1</script><script src="/a.js"></script>'
  const out = injectScriptNonce(html, nonce)
  assert.match(out, new RegExp(`<script nonce="${nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">self.x=1</script>`))
  assert.match(out, /<script src="\/a.js"><\/script>/)
})
