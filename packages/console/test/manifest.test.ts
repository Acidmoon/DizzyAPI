import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BUILT_IN_CONTRIBUTIONS,
  CORE_OWNER,
  ManifestRegistry,
  isFrontendManifestError,
  type FrontendPage,
} from '../src/manifest.ts'

const NOW = () => new Date('2026-10-19T00:00:00.000Z')

test('内置清单包含两块路由区，核心页面永远可见', () => {
  const registry = new ManifestRegistry({ now: NOW, enabledPlugins: [] })
  const manifest = registry.snapshot()
  assert.equal(manifest.schemaVersion, 1)
  assert.ok(manifest.pages.some((page) => page.path === '/console'))
  assert.ok(manifest.pages.some((page) => page.path === '/console/usage'))
  assert.ok(manifest.pages.some((page) => page.path === '/console/api_keys'))
  assert.ok(manifest.pages.some((page) => page.path === '/console/top_up'))
  assert.ok(manifest.pages.some((page) => page.path === '/console/transactions'))
  assert.ok(manifest.pages.find((page) => page.path === '/console')?.hidden)
  assert.equal(manifest.pages.find((page) => page.path === '/console')?.view.kind, 'redirect')
  assert.ok(manifest.pages.some((page) => page.path === '/admin'))
  assert.ok(manifest.pages.some((page) => page.path === '/admin/catalog'))
  assert.ok(manifest.pages.some((page) => page.path === '/admin/users'))
  assert.equal(manifest.pages.find((page) => page.path === '/console/profile')?.view.kind, 'profile')
  assert.equal(manifest.pages.find((page) => page.path === '/admin/users')?.view.kind, 'users')
  assert.ok(manifest.enabledPlugins.includes(CORE_OWNER))
  assert.equal(manifest.areas.admin.root, '/admin')
})

test('禁用插件时页面、设置卡与插槽一起消失', () => {
  const registry = new ManifestRegistry({
    now: NOW,
    enabledPlugins: ['identity', '@dizzyapi/plugin-settings', '@dizzyapi/plugin-mailer'],
  })
  let manifest = registry.snapshot()
  assert.ok(manifest.pages.some((page) => page.path === '/admin/accounts'))
  assert.ok(manifest.pages.some((page) => page.path === '/admin/settings'))
  assert.ok(manifest.settingsCards.some((card) => card.namespace === 'mailer'))

  registry.setEnabledPlugins(['@dizzyapi/plugin-settings'])
  manifest = registry.snapshot()
  assert.ok(!manifest.pages.some((page) => page.path === '/admin/accounts'), 'identity 禁用后账号页必须消失')
  assert.ok(!manifest.settingsCards.some((card) => card.namespace === 'mailer'), 'mailer 禁用后设置卡必须消失')
  assert.ok(!manifest.slots.some((slot) => slot.owner === '@dizzyapi/plugin-account-priority'))
  assert.ok(manifest.pages.some((page) => page.path === '/admin/settings'), '仍启用的设置页保留')

  registry.setEnabledPlugins(['identity'])
  assert.ok(registry.snapshot().pages.some((page) => page.path === '/admin/accounts'), '重新启用后页面回来')
})

test('owner 可以按 entry id 或包名匹配；核心 owner 不依赖启用集', () => {
  const registry = new ManifestRegistry({ now: NOW, enabledPlugins: [] })
  const onlyId = registry.snapshot()
  assert.ok(!onlyId.pages.some((page) => page.path === '/admin/accounts'))

  registry.setEnabledPlugins(['identity'])
  assert.ok(registry.snapshot().pages.some((page) => page.path === '/admin/accounts'))

  registry.setEnabledPlugins(['@dizzyapi/plugin-identity'])
  assert.ok(registry.snapshot().pages.some((page) => page.path === '/admin/accounts'))
  assert.ok(registry.snapshot().pages.some((page) => page.path === '/console'))
})

test('revision 对相同输入稳定，对启用集变化敏感', () => {
  const a = new ManifestRegistry({ now: NOW, enabledPlugins: ['identity'] }).snapshot()
  const b = new ManifestRegistry({ now: () => new Date('2030-01-01T00:00:00.000Z'), enabledPlugins: ['identity'] }).snapshot()
  assert.equal(a.revision, b.revision, 'generatedAt 不参与 revision')
  const c = new ManifestRegistry({ now: NOW, enabledPlugins: ['identity', 'settings'] }).snapshot()
  assert.notEqual(a.revision, c.revision)
})

test('运行期贡献：未启用的 owner 隐藏，启用后出现，disposer 移除', () => {
  const registry = new ManifestRegistry({ now: NOW, enabledPlugins: [] })
  const page: Omit<FrontendPage, 'owner'> = {
    id: 'custom.page',
    area: 'admin',
    path: '/admin/custom',
    title: '自定义',
    nav: '自定义',
    order: 5,
    view: { kind: 'placeholder', note: '等待参考设计' },
  }
  const dispose = registry.contribute('@dizzyapi/plugin-custom', { pages: [page] })
  assert.ok(!registry.snapshot().pages.some((item) => item.path === '/admin/custom'))

  registry.setEnabledPlugins(['@dizzyapi/plugin-custom'])
  const visible = registry.snapshot()
  assert.ok(visible.pages.some((item) => item.path === '/admin/custom'))
  assert.equal(visible.pages.find((item) => item.path === '/admin/custom')?.owner, '@dizzyapi/plugin-custom')

  dispose()
  assert.ok(!registry.snapshot().pages.some((item) => item.path === '/admin/custom'))
  dispose() // 幂等
})

test('清单校验：重复路径、越区路径、重复设置命名空间都拒绝', () => {
  const registry = new ManifestRegistry({ now: NOW, enabledPlugins: [] })
  assert.throws(
    () =>
      registry.contribute('@dizzyapi/plugin-bad', {
        pages: [
          {
            id: 'bad.duplicate',
            area: 'admin',
            path: '/admin',
            title: '重复',
            nav: '重复',
            order: 1,
            view: { kind: 'catalog' },
          },
        ],
      }),
    (error: unknown) => isFrontendManifestError(error),
  )
  assert.throws(
    () =>
      registry.contribute('@dizzyapi/plugin-bad', {
        pages: [
          {
            id: 'bad.area',
            area: 'admin',
            path: '/console/oops',
            title: '越区',
            nav: '越区',
            order: 1,
            view: { kind: 'catalog' },
          },
        ],
      }),
    /必须落在 \/admin 下/,
  )
  assert.throws(
    () =>
      registry.contribute('@dizzyapi/plugin-bad', {
        settingsCards: [
          { id: 'bad.card', title: '重复命名空间', namespace: 'identity', order: 1 },
        ],
      }),
    /namespace 重复/,
  )
})

test('内置贡献本身通过校验，页面路径都在自己的区域下', () => {
  const registry = new ManifestRegistry({ now: NOW, enabledPlugins: BUILT_IN_CONTRIBUTIONS.map((item) => item.owner) })
  for (const page of registry.snapshot().pages) {
    assert.ok(page.path === `/${page.area}` || page.path.startsWith(`/${page.area}/`))
  }
})
