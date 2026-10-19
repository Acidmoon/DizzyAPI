import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AssetStore, contentTypeOf, normalizeAssetPath } from '../src/assets.ts'
import { bundledAssetVersion, configSource, prepareBundledFiles, readAssetDirectory, BUNDLED_ASSETS_DIR } from '../src/bundle.ts'
import type { ResolvedFrontendConfig } from '../src/config.ts'
import { isFrontendError } from '../src/errors.ts'

const NOW = () => new Date('2026-10-19T12:00:00.000Z')

async function tempRoot(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dizzy-frontend-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return root
}

function bundle(version: string, marker: string) {
  return {
    version,
    files: [
      { path: 'index.html', content: `<h1>${marker}</h1>` },
      { path: 'app.js', content: `console.log('${marker}')` },
      { path: 'lib/router.js', content: `export const marker = '${marker}'` },
    ],
  }
}

test('安装、原子切换、保留上一版与回滚', async (t) => {
  const root = await tempRoot(t)
  const store = new AssetStore(root, { keepVersions: 2, now: NOW })

  const first = await store.install(bundle('1.0.0', 'v1'))
  assert.equal(first.version, '1.0.0')
  assert.equal(first.previous, null)
  assert.equal((await store.readAsset('app.js')).toString(), "console.log('v1')")

  const second = await store.install(bundle('2.0.0', 'v2'))
  assert.equal(second.version, '2.0.0')
  assert.equal(second.previous, '1.0.0')
  assert.equal((await store.readAsset('app.js')).toString(), "console.log('v2')")
  assert.equal((await store.readAsset('app.js', '1.0.0')).toString(), "console.log('v1')")

  const rolled = await store.rollback()
  assert.equal(rolled.version, '1.0.0')
  assert.equal(rolled.previous, '2.0.0')
  assert.equal((await store.readAsset('app.js')).toString(), "console.log('v1')")

  const third = await store.install(bundle('3.0.0', 'v3'))
  assert.equal(third.previous, '1.0.0')
  const versions = (await store.versions()).map((item) => item.version)
  assert.deepEqual(versions, ['3.0.0', '1.0.0'], 'keepVersions=2 时旧版本 2.0.0 被清掉')

  const pointer = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))
  assert.equal(pointer.current, '3.0.0')
  assert.equal(pointer.previous, '1.0.0')
  const entries = await readdir(root)
  assert.ok(!entries.some((name) => name.includes('.tmp')), '指针临时文件必须已被 rename 掉')
})

test('同版本同内容幂等；同版本不同内容拒绝', async (t) => {
  const root = await tempRoot(t)
  const store = new AssetStore(root, { now: NOW })
  await store.install(bundle('1.0.0', 'v1'))
  const again = await store.install(bundle('1.0.0', 'v1'))
  assert.equal(again.version, '1.0.0')
  await assert.rejects(
    () => store.install(bundle('1.0.0', 'different')),
    (error: unknown) => isFrontendError(error) && error.code === 'FRONTEND_ASSET_VERSION_EXISTS',
  )
})

test('没有上一版时回滚报错', async (t) => {
  const root = await tempRoot(t)
  const store = new AssetStore(root, { now: NOW })
  await store.install(bundle('1.0.0', 'v1'))
  await assert.rejects(
    () => store.rollback(),
    (error: unknown) => isFrontendError(error) && error.code === 'FRONTEND_NO_PREVIOUS_VERSION',
  )
})

test('路径越界与非法路径拒绝', async (t) => {
  const root = await tempRoot(t)
  const store = new AssetStore(root, { now: NOW })
  await store.install(bundle('1.0.0', 'v1'))
  assert.throws(() => normalizeAssetPath('../current.json'), /非法段/)
  assert.throws(() => normalizeAssetPath('/etc/passwd'), /相对路径/)
  assert.throws(() => normalizeAssetPath('lib\\router.js'), /反斜杠/)
  assert.throws(() => normalizeAssetPath('.hidden'), /非法段/)
  await assert.rejects(
    () => store.readAsset('../current.json'),
    (error: unknown) => isFrontendError(error) && error.code === 'FRONTEND_ASSET_INVALID',
  )
  await assert.rejects(
    () => store.readAsset('missing.js'),
    (error: unknown) => isFrontendError(error) && error.code === 'FRONTEND_ASSET_NOT_FOUND',
  )
  assert.equal(contentTypeOf('index.html'), 'text/html; charset=utf-8')
  assert.equal(contentTypeOf('app.js'), 'text/javascript; charset=utf-8')
  assert.equal(contentTypeOf('font.woff2'), 'font/woff2')
})

test('内置资源：版本哈希包含公开配置，index 占位符被替换，config.js 无秘密', async () => {
  const config: ResolvedFrontendConfig = {
    dataPath: './data/frontend',
    publicBase: '/assets/frontend',
    apiBase: '/api',
    basePath: '',
    mode: 'rest',
    mockLatencyMs: 120,
    keepVersions: 2,
    autoInstall: true,
  }
  const source = await readAssetDirectory(BUNDLED_ASSETS_DIR)
  const version = bundledAssetVersion(source, config)
  const prepared = prepareBundledFiles(source, config, version)
  const index = prepared.find((file) => file.path === 'index.html')?.content
  assert.equal(typeof index, 'string')
  assert.ok(String(index).includes(`/assets/frontend/${version}/`))
  assert.ok(!String(index).includes('__ASSET_'))

  const configFile = prepared.find((file) => file.path === 'config.js')
  assert.ok(configFile !== undefined)
  const sourceText = String(configFile.content)
  assert.ok(sourceText.includes('window.__DIZZY_CONSOLE__'))
  assert.ok(sourceText.includes('"mode": "rest"'))
  assert.ok(!sourceText.toLowerCase().includes('token'))
  assert.ok(!sourceText.toLowerCase().includes('password'))

  assert.equal(configSource(config, version).includes(version), true)
  const changed = bundledAssetVersion(source, { ...config, apiBase: '/other-api' })
  assert.notEqual(version, changed, '公开配置变化必须产生新版本')
})
