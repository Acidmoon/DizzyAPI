import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from 'cordis'
import Loader, { type EntryOptions } from '@cordisjs/plugin-loader'
import { isIssueList } from '@dizzyapi/plugin-kit'
import FrontendService from '../src/index.ts'
import { validateFrontendConfig } from '../src/config.ts'
import { collectEnabledPlugins } from '../src/enabled.ts'

/** 与 admin / settings 测试相同的类型缺口补丁：`create` 的声明漏了 `id`。 */
function createEntry(ctx: Context, options: Omit<EntryOptions, 'id'> & { id?: string }): Promise<string> {
  return ctx.loader.create(options as Omit<EntryOptions, 'id'>)
}

function raw<T>(ctx: Context, name: string): T {
  const impl = ctx.root.reflect._getImpl(name, false)
  assert.ok(impl !== undefined, `服务 ${name} 不存在`)
  return impl.value as T
}

test('配置校验：默认值、挂载路径与未知键', () => {
  const defaults = validateFrontendConfig(undefined)
  assert.ok(!isIssueList(defaults))
  if (isIssueList(defaults)) return
  assert.equal(defaults.publicBase, '/assets/frontend')
  assert.equal(defaults.mode, 'rest')
  assert.equal(defaults.keepVersions, 2)

  assert.ok(isIssueList(validateFrontendConfig({ publicBase: 'assets' })))
  assert.ok(isIssueList(validateFrontendConfig({ mode: 'other' })))
  assert.ok(isIssueList(validateFrontendConfig({ keepVersions: 1 })))
  assert.ok(isIssueList(validateFrontendConfig({ unknown: true })))
  assert.ok(isIssueList(validateFrontendConfig({ publicBase: '/assets/../secret' })))

  const absolute = validateFrontendConfig({ apiBase: 'https://gw.example.com/api/' })
  assert.ok(!isIssueList(absolute))
  if (isIssueList(absolute)) return
  assert.equal(absolute.apiBase, 'https://gw.example.com/api')
})

test('启用集同时收集 entry id 与包名，跳过禁用项', () => {
  const enabled = collectEnabledPlugins([
    { options: { id: 'identity', name: '@dizzyapi/plugin-identity' } },
    { options: { id: 'off', name: '@dizzyapi/plugin-off' }, disabled: true },
    { options: { id: 'settings' } },
  ])
  assert.deepEqual(enabled, ['@dizzyapi/plugin-identity', 'identity', 'settings'])
})

test('插件集成：安装内置资源、写 manifest、按启用集过滤、停用状态落盘', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dizzy-frontend-service-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const ctx = new Context()
  await ctx.plugin(Loader)
  await createEntry(ctx, { id: 'identity-off', name: '@dizzyapi/plugin-identity', disabled: true })
  await createEntry(ctx, {
    id: 'frontend',
    name: '@dizzyapi/plugin-frontend',
    config: {
      dataPath: root,
      publicBase: '/assets/frontend',
      apiBase: '/api',
      mode: 'rest',
      autoInstall: true,
      keepVersions: 2,
    },
  })
  await ctx.loader.await()

  const service = raw<FrontendService>(ctx, 'frontend')
  const current = await service.current()
  assert.ok(current !== null, '启动后应当有当前资源版本')
  assert.equal(current.previous, null)
  assert.match(current.version, /^0\.1\.0-[0-9a-f]{12}$/)

  const index = await service.readAsset('index.html')
  const html = index.toString('utf8')
  assert.ok(html.includes(`/assets/frontend/${current.version}/`))
  assert.ok(!html.includes('__ASSET_'))

  const manifest = await service.manifest()
  assert.equal(manifest.assets?.version, current.version)
  assert.ok(manifest.pages.some((page) => page.path === '/console/api_keys'))
  assert.ok(manifest.pages.some((page) => page.path === '/console/top_up'))
  assert.ok(!manifest.pages.some((page) => page.path === '/admin/accounts'), '禁用的 identity 不贡献页面')

  const manifestFile = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  assert.equal(manifestFile.assets.version, current.version)
  assert.ok(Array.isArray(manifestFile.pages))

  const stateFile = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  assert.equal(stateFile.enabled, true)
  assert.equal(stateFile.assetVersion, current.version)

  await ctx.root.fiber.dispose()
  const stopped = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  assert.equal(stopped.enabled, false)
})
