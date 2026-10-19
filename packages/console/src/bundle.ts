/**
 * 包内 `assets/` 的读取与「安装前生成物」。
 *
 * 版本号 = 原始资源内容 + 会影响运行时的公开配置的哈希。配置一变就产生新版本，
 * 旧版本仍在，所以回滚可以回到「旧配置 + 旧资源」的一致状态。
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssetFile } from './assets.ts'
import { FrontendError } from './errors.ts'
import type { ResolvedFrontendConfig } from './config.ts'

export const BUNDLED_ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url))

const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.map'])

/** 读取一个资源目录（递归，不含点文件与符号链接）。 */
export async function readAssetDirectory(directory: string): Promise<AssetFile[]> {
  const files: AssetFile[] = []
  await walk(directory, '')
  return files.sort((a, b) => a.path.localeCompare(b.path))

  async function walk(absolute: string, prefix: string): Promise<void> {
    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch (error) {
      throw new FrontendError(
        'FRONTEND_ASSET_INVALID',
        `读取内置资源目录失败：${directory}（${(error as Error).message}）`,
      )
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(join(absolute, entry.name), path)
        continue
      }
      if (!entry.isFile()) continue
      const content = await readFile(join(absolute, entry.name))
      files.push({
        path,
        content: isText(entry.name) ? content.toString('utf8') : content,
      })
    }
  }
}

/**
 * 生成一个稳定的资源版本。内容相同 + 配置相同 = 同一个版本，启动时不会重复安装。
 * `publicBase` 也算进去：它改变 index.html 里的 `<base href>`，属于资源内容。
 */
export function bundledAssetVersion(
  files: readonly AssetFile[],
  config: Pick<ResolvedFrontendConfig, 'publicBase' | 'apiBase' | 'basePath' | 'mode' | 'mockLatencyMs'>,
): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.content)
    hash.update('\0')
  }
  hash.update(
    JSON.stringify({
      publicBase: config.publicBase,
      apiBase: config.apiBase,
      basePath: config.basePath,
      mode: config.mode,
      mockLatencyMs: config.mockLatencyMs,
    }),
  )
  return `0.1.0-${hash.digest('hex').slice(0, 12)}`
}

/**
 * 把模板里的占位符换成当前公开基址，并生成 `config.js`。
 * `config.js` 只含公开配置，没有任何秘密。
 */
export function prepareBundledFiles(
  files: readonly AssetFile[],
  config: ResolvedFrontendConfig,
  version: string,
): AssetFile[] {
  const assetBase = `${config.publicBase}/${version}/`
  const prepared: AssetFile[] = []
  let sawIndex = false

  for (const file of files) {
    if (file.path === 'index.html') {
      sawIndex = true
      if (typeof file.content !== 'string') {
        throw new FrontendError('FRONTEND_ASSET_INVALID', 'index.html 必须按文本读取')
      }
      const html = file.content
        .replaceAll('__ASSET_BASE__', assetBase)
        .replaceAll('__ASSET_VERSION__', version)
      if (html.includes('__ASSET_')) {
        throw new FrontendError('FRONTEND_ASSET_INVALID', 'index.html 还有未替换的占位符')
      }
      prepared.push({ path: file.path, content: html })
      continue
    }
    prepared.push(file)
  }

  if (!sawIndex) throw new FrontendError('FRONTEND_ASSET_INVALID', '内置资源缺少 index.html')
  prepared.push({
    path: 'config.js',
    content: configSource(config, version, assetBase),
  })
  return prepared.sort((a, b) => a.path.localeCompare(b.path))
}

export function configSource(
  config: ResolvedFrontendConfig,
  version: string,
  assetBase = `${config.publicBase}/${version}/`,
): string {
  const payload = {
    appName: 'DizzyAPI',
    mode: config.mode,
    apiBase: config.apiBase,
    basePath: config.basePath,
    publicBase: config.publicBase,
    assetBase,
    assetVersion: version,
    mockLatencyMs: config.mockLatencyMs,
  }
  return `window.__DIZZY_CONSOLE__ = Object.freeze(${JSON.stringify(payload, null, 2)});\n`
}

function isText(name: string): boolean {
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase())
}
