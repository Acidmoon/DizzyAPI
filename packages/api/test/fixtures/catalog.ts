/**
 * 前端宿主与能力目录夹具。
 *
 * 从 `test/fixtures.ts` 按域拆出（§5.6：测试文件 500 行上限）。行为逐字未改。
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type {
  CatalogPluginLike,
  CatalogPort,
  FrontendPageLike,
  FrontendPort,
} from '../../src/types.ts'
import { DomainError } from './support.ts'

export interface FakeFrontend extends FrontendPort {
  readonly root: string
  readonly pagesList: FrontendPageLike[]
  setEnabled(enabled: boolean): Promise<void>
}

export async function createFakeFrontend(pages: FrontendPageLike[] = []): Promise<FakeFrontend> {
  const root = await mkdtemp(join(tmpdir(), 'dizzy-api-http-'))
  const versionDir = join(root, 'versions', 'v1')
  await mkdir(versionDir, { recursive: true })
  await writeFile(
    join(versionDir, 'index.html'),
    '<!doctype html><html><body><div id="app">index</div></body></html>\n',
    'utf8',
  )
  await writeFile(join(versionDir, 'app.js'), "console.log('asset')\n", 'utf8')
  await writeFile(join(versionDir, 'style.css'), 'body { color: black }\n', 'utf8')
  await writeFile(join(root, 'state.json'), JSON.stringify({ enabled: true }), 'utf8')

  const pagesList = [...pages]
  const frontend: FakeFrontend = {
    config: { publicBase: '/assets/frontend' },
    root,
    pagesList,
    async current() {
      return { version: 'v1' }
    },
    async assetPath(path: string, version?: string): Promise<string> {
      if (version !== undefined && version !== 'v1') throw new DomainError('FRONTEND_ASSET_NOT_FOUND', '版本不存在')
      if (path.includes('\\') || path.includes('\0')) {
        throw new DomainError('FRONTEND_ASSET_INVALID', '非法路径')
      }
      const segments = path.split('/')
      if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new DomainError('FRONTEND_ASSET_INVALID', '非法路径')
      }
      const base = resolve(root, 'versions', 'v1')
      const target = resolve(base, ...segments)
      if (target !== base && !target.startsWith(`${base}${sep}`)) {
        throw new DomainError('FRONTEND_ASSET_NOT_FOUND', '路径越界')
      }
      return target
    },
    async indexFile() {
      return join(root, 'versions', 'v1', 'index.html')
    },
    async manifest() {
      return {
        schemaVersion: 1,
        revision: 'manifest-1',
        generatedAt: new Date().toISOString(),
        pages: pagesList,
        assets: { version: 'v1', base: '/assets/frontend/v1/' },
      }
    },
    pages(area?: 'console' | 'admin') {
      return area === undefined ? pagesList : pagesList.filter((page) => page.area === area)
    },
    async assets() {
      return { dataPath: root }
    },
    async setEnabled(enabled: boolean) {
      await writeFile(join(root, 'state.json'), JSON.stringify({ enabled }), 'utf8')
    },
  }
  return frontend
}

export class FakeCatalog implements CatalogPort {
  readonly plugins: CatalogPluginLike[] = [
    {
      id: 'api',
      package: '@dizzyapi/plugin-api',
      kind: 'plugin',
      state: 'active',
      disabled: false,
      manifest: { description: '产品 HTTP 入口' },
      capabilities: ['http-api', 'spa-hosting'],
    },
    {
      id: 'off',
      package: '@dizzyapi/plugin-off',
      kind: 'plugin',
      state: 'disabled',
      disabled: true,
      manifest: { description: null },
      capabilities: [],
    },
  ]

  async query(): Promise<{ generatedAt: string; plugins: readonly CatalogPluginLike[] }> {
    return { generatedAt: '2026-10-19T00:00:00.000Z', plugins: this.plugins }
  }
}
