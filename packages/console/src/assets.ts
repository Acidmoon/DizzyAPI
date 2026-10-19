/**
 * 静态资源的版本化安装与原子切换。
 *
 * 目录布局（`root` 由配置的 `dataPath` 决定）：
 *
 * ```
 * <root>/current.json                 指针：{ current, previous, updatedAt }
 * <root>/versions/<version>/...       不可变资源；含 `.asset.json` 元数据
 * ```
 *
 * 安装顺序是「先写完整版本目录 → 再换指针」，所以任何时刻读到的当前版本都是完整的。
 * 旧版本保留，`rollback()` 只改指针，不复制文件。
 *
 * 这里**不监听端口、不发 HTTP**：字节由未来的 Go httpapi 或反向代理直接读盘发出去
 * （AGENTS.md D13、D8）。唯一的 HTTP 服务是 `preview.ts`，明确只用于开发预览。
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, isAbsolute } from 'node:path'
import { describeError, isFileNotFound } from '@dizzyapi/plugin-kit'
import { FrontendError, isFrontendError } from './errors.ts'

export interface AssetFile {
  /** 相对路径，POSIX 分隔符；不以 `/` 开头，不允许 `..` 或点开头。 */
  readonly path: string
  readonly content: string | Uint8Array
  readonly contentType?: string
}

export interface AssetBundle {
  readonly files: readonly AssetFile[]
  /** 省略时按内容哈希生成 `0.1.0-<hash12>`。 */
  readonly version?: string
  readonly label?: string
}

export interface AssetVersionRecord {
  readonly version: string
  readonly label: string | null
  readonly checksum: string
  readonly fileCount: number
  readonly bytes: number
  readonly installedAt: string
}

export interface AssetPointer {
  readonly current: string
  readonly previous: string | null
  readonly updatedAt: string
}

export interface InstalledAssetSet extends AssetVersionRecord {
  readonly previous: string | null
  /** 绝对目录；仅供服务端 / 运维使用，绝不进浏览器响应。 */
  readonly directory: string
}

export interface AssetStoreOptions {
  readonly keepVersions?: number
  readonly now?: () => Date
}

interface AssetMetadata extends AssetVersionRecord {}

const METADATA_FILE = '.asset.json'
const POINTER_FILE = 'current.json'
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

export class AssetStore {
  readonly root: string
  private readonly keepVersions: number
  private readonly now: () => Date
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(root: string, options: AssetStoreOptions = {}) {
    this.root = resolve(root)
    this.keepVersions = Math.max(2, options.keepVersions ?? 2)
    this.now = options.now ?? (() => new Date())
  }

  get pointerPath(): string {
    return join(this.root, POINTER_FILE)
  }

  get versionsRoot(): string {
    return join(this.root, 'versions')
  }

  /** 安装一个版本并切换指针。相同 version + 相同内容幂等；内容不同直接拒绝。 */
  async install(bundle: AssetBundle): Promise<InstalledAssetSet> {
    const files = normalizeBundle(bundle)
    const checksum = checksumOf(files)
    const version = bundle.version ?? `0.1.0-${checksum.slice(0, 12)}`
    assertVersion(version)
    const directory = this.versionDirectory(version)

    const existing = await readMetadata(directory)
    if (existing !== undefined) {
      if (existing.checksum !== checksum) {
        throw new FrontendError(
          'FRONTEND_ASSET_VERSION_EXISTS',
          `版本 ${version} 已存在且内容不同；版本号必须唯一`,
        )
      }
      return this.switchTo(version, { ...existing, label: bundle.label ?? existing.label })
    }

    await mkdir(this.versionsRoot, { recursive: true })
    const temp = await mkdtemp(join(this.versionsRoot, '.tmp-'))
    try {
      for (const file of files) {
        const target = join(temp, ...file.path.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.content)
      }
      const metadata: AssetMetadata = {
        version,
        label: bundle.label ?? null,
        checksum,
        fileCount: files.length,
        bytes: files.reduce((total, file) => total + byteLength(file.content), 0),
        installedAt: this.now().toISOString(),
      }
      await writeFile(join(temp, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
      try {
        await renameWithRetry(temp, directory)
      } catch (error) {
        // 另一个进程/安装抢先创建了同版本：内容一致就复用，否则报错。
        const raced = await readMetadata(directory)
        if (raced !== undefined && raced.checksum === checksum) {
          await rm(temp, { recursive: true, force: true })
        } else if (raced === undefined && isTransientRenameError(error)) {
          // Windows 上目录 rename 可能被 Defender / 索引器长时间占用。
          // 磁盘上的最终目录在 current.json 指向它之前不可见，所以复制也能保持
          // 「读者只会看到完整版本」；原子性仍由指针切换保证。
          try {
            await cp(temp, directory, { recursive: true, force: false, errorOnExist: true })
            await rm(temp, { recursive: true, force: true })
          } catch (copyError) {
            await rm(directory, { recursive: true, force: true }).catch(() => undefined)
            throw copyError
          }
        } else {
          throw error
        }
      }
    } catch (error) {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined)
      if (isFrontendError(error)) throw error
      throw new FrontendError(
        'FRONTEND_ASSET_INVALID',
        `安装资源版本 ${version} 失败：${describeError(error)}`,
      )
    }

    const record = await readMetadata(directory)
    if (record === undefined) {
      throw new FrontendError('FRONTEND_ASSET_INVALID', `版本目录写入后读不到元数据：${directory}`)
    }
    return this.switchTo(version, { ...record, label: bundle.label ?? record.label })
  }

  /** 切回上一个版本；被切掉的当前版本成为新的 previous，可以再切回来。 */
  async rollback(): Promise<InstalledAssetSet> {
    return this.exclusive(async () => {
      const pointer = await this.readPointer()
      if (pointer === null || pointer.previous === null) {
        throw new FrontendError('FRONTEND_NO_PREVIOUS_VERSION', '没有可回滚的上一个版本')
      }
      const target = await this.requireMetadata(pointer.previous)
      const current = await this.requireMetadata(pointer.current)
      await this.writePointer({
        current: target.version,
        previous: current.version,
        updatedAt: this.now().toISOString(),
      })
      return { ...target, previous: current.version, directory: this.versionDirectory(target.version) }
    })
  }

  /** 当前版本；尚未安装过返回 null。 */
  async current(): Promise<InstalledAssetSet | null> {
    const pointer = await this.readPointer()
    if (pointer === null) return null
    const record = await this.requireMetadata(pointer.current)
    return {
      ...record,
      previous: pointer.previous,
      directory: this.versionDirectory(record.version),
    }
  }

  async pointer(): Promise<AssetPointer | null> {
    return this.readPointer()
  }

  /** 全部有效版本，最新安装的在前。临时目录与坏元数据不会出现在这里。 */
  async versions(): Promise<readonly AssetVersionRecord[]> {
    let names: string[]
    try {
      names = await readdir(this.versionsRoot)
    } catch (error) {
      if (isFileNotFound(error)) return []
      throw error
    }
    const records: AssetVersionRecord[] = []
    for (const name of names) {
      if (!VERSION_RE.test(name)) continue
      const record = await readMetadata(join(this.versionsRoot, name))
      if (record !== undefined) records.push(record)
    }
    return records.sort((a, b) => b.installedAt.localeCompare(a.installedAt) || b.version.localeCompare(a.version))
  }

  /** 读当前版本里的文件。`version` 只给测试与回滚检查用。 */
  async readAsset(path: string, version?: string): Promise<Buffer> {
    return readFile(await this.assetPath(path, version))
  }

  /** 供 Go / 反代集成时核对路径：返回绝对路径，且保证落在版本目录内。 */
  async assetPath(path: string, version?: string): Promise<string> {
    const relativePath = normalizeAssetPath(path)
    const targetVersion = version ?? (await this.current())?.version
    if (targetVersion === undefined) {
      throw new FrontendError('FRONTEND_ASSET_NOT_FOUND', '还没有安装任何前端资源版本')
    }
    assertVersion(targetVersion)
    const base = this.versionDirectory(targetVersion)
    const target = resolve(base, ...relativePath.split('/'))
    const rel = relative(base, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new FrontendError('FRONTEND_ASSET_NOT_FOUND', `资源路径越界：${path}`)
    }
    try {
      await readFile(target)
    } catch (error) {
      if (isFileNotFound(error)) {
        throw new FrontendError('FRONTEND_ASSET_NOT_FOUND', `资源不存在：${relativePath}`)
      }
      throw error
    }
    return target
  }

  async describe(): Promise<{
    readonly root: string
    readonly pointer: AssetPointer | null
    readonly current: InstalledAssetSet | null
    readonly versions: readonly AssetVersionRecord[]
  }> {
    return {
      root: this.root,
      pointer: await this.readPointer(),
      current: await this.current(),
      versions: await this.versions(),
    }
  }

  private versionDirectory(version: string): string {
    return join(this.versionsRoot, version)
  }

  private async switchTo(version: string, record: AssetMetadata): Promise<InstalledAssetSet> {
    return this.exclusive(async () => {
      const pointer = await this.readPointer()
      const previous =
        pointer === null || pointer.current === version ? (pointer?.previous ?? null) : pointer.current
      await this.writePointer({
        current: version,
        previous,
        updatedAt: this.now().toISOString(),
      })
      await this.prune(version, previous)
      return {
        ...record,
        previous,
        directory: this.versionDirectory(version),
      }
    })
  }

  private async requireMetadata(version: string): Promise<AssetMetadata> {
    assertVersion(version)
    const record = await readMetadata(this.versionDirectory(version))
    if (record === undefined) {
      throw new FrontendError('FRONTEND_ASSET_INVALID', `版本 ${version} 的元数据缺失或损坏`)
    }
    return record
  }

  private async readPointer(): Promise<AssetPointer | null> {
    let text: string
    try {
      text = await readFile(this.pointerPath, 'utf8')
    } catch (error) {
      if (isFileNotFound(error)) return null
      throw error
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new FrontendError('FRONTEND_ASSET_INVALID', 'current.json 不是合法 JSON')
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new FrontendError('FRONTEND_ASSET_INVALID', 'current.json 必须是对象')
    }
    const value = raw as Record<string, unknown>
    if (typeof value.current !== 'string' || !VERSION_RE.test(value.current)) {
      throw new FrontendError('FRONTEND_ASSET_INVALID', 'current.json 的 current 非法')
    }
    if (value.previous !== null && (typeof value.previous !== 'string' || !VERSION_RE.test(value.previous))) {
      throw new FrontendError('FRONTEND_ASSET_INVALID', 'current.json 的 previous 非法')
    }
    if (typeof value.updatedAt !== 'string') {
      throw new FrontendError('FRONTEND_ASSET_INVALID', 'current.json 缺少 updatedAt')
    }
    return {
      current: value.current,
      previous: value.previous as string | null,
      updatedAt: value.updatedAt,
    }
  }

  private async writePointer(pointer: AssetPointer): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const temp = `${this.pointerPath}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temp, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')
    try {
      await rename(temp, this.pointerPath)
    } catch (error) {
      // Windows 上偶发 EPERM/EEXIST；先删再 rename。其他错误照常抛。
      const code = (error as { code?: unknown }).code
      if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') {
        await rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
      await rm(this.pointerPath, { force: true })
      await rename(temp, this.pointerPath)
    }
  }

  /**
   * 保留当前版本、上一个版本，其余按安装时间从旧到新删除。
   * 清理失败不影响本次切换（资源仍可用，只是多占一点磁盘）。
   */
  private async prune(current: string, previous: string | null): Promise<void> {
    const versions = await this.versions()
    const keep = new Set<string>([current])
    if (previous !== null) keep.add(previous)
    for (const record of versions) {
      if (keep.size >= this.keepVersions) break
      keep.add(record.version)
    }
    for (const record of versions) {
      if (keep.has(record.version)) continue
      await rm(this.versionDirectory(record.version), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(task, task)
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export function normalizeAssetPath(path: string): string {
  if (typeof path !== 'string' || path === '') {
    throw new FrontendError('FRONTEND_ASSET_INVALID', '资源路径不能为空')
  }
  if (path.includes('\\') || path.includes('\0')) {
    throw new FrontendError('FRONTEND_ASSET_INVALID', `资源路径不能含反斜杠或 NUL：${path}`)
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new FrontendError('FRONTEND_ASSET_INVALID', `资源路径必须是相对路径：${path}`)
  }
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new FrontendError('FRONTEND_ASSET_INVALID', `资源路径含非法段：${path}`)
  }
  return parts.join('/')
}

export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function normalizeBundle(bundle: AssetBundle): readonly AssetFile[] {
  if (bundle === null || typeof bundle !== 'object' || !Array.isArray(bundle.files) || bundle.files.length === 0) {
    throw new FrontendError('FRONTEND_ASSET_INVALID', '资源包必须包含至少一个文件')
  }
  const seen = new Set<string>()
  const files: AssetFile[] = []
  for (const file of bundle.files) {
    const path = normalizeAssetPath(file.path)
    const key = path.toLowerCase()
    if (seen.has(key)) {
      throw new FrontendError('FRONTEND_ASSET_INVALID', `资源路径重复（大小写不敏感）：${path}`)
    }
    seen.add(key)
    if (typeof file.content !== 'string' && !(file.content instanceof Uint8Array)) {
      throw new FrontendError('FRONTEND_ASSET_INVALID', `资源 ${path} 的内容必须是字符串或字节`)
    }
    files.push({
      path,
      content: file.content,
      ...(file.contentType === undefined ? {} : { contentType: file.contentType }),
    })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function checksumOf(files: readonly AssetFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function byteLength(content: string | Uint8Array): number {
  return typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength
}

function assertVersion(version: string): void {
  if (!VERSION_RE.test(version) || version.includes('..')) {
    throw new FrontendError(
      'FRONTEND_ASSET_INVALID',
      `版本号非法：${version}（允许字母、数字、点、下划线、加号、减号）`,
    )
  }
}

/**
 * Windows 上目录 rename 偶尔会被 Defender / 索引器短暂占用而报 EPERM/EBUSY；
 * 目录内容是刚写完的、尚未对外可见，重试是安全的。非瞬时错误照常抛出。
 */
async function renameWithRetry(source: string, target: string, attempts = 4): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(source, target)
      return
    } catch (error) {
      if (!isTransientRenameError(error)) throw error
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
  throw lastError
}

function isTransientRenameError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

async function readMetadata(directory: string): Promise<AssetMetadata | undefined> {
  let text: string
  try {
    text = await readFile(join(directory, METADATA_FILE), 'utf8')
  } catch (error) {
    if (isFileNotFound(error)) return undefined
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new FrontendError('FRONTEND_ASSET_INVALID', `${directory} 的元数据不是合法 JSON`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FrontendError('FRONTEND_ASSET_INVALID', `${directory} 的元数据必须是对象`)
  }
  const value = raw as Record<string, unknown>
  if (
    typeof value.version !== 'string' ||
    typeof value.checksum !== 'string' ||
    typeof value.fileCount !== 'number' ||
    typeof value.bytes !== 'number' ||
    typeof value.installedAt !== 'string'
  ) {
    throw new FrontendError('FRONTEND_ASSET_INVALID', `${directory} 的元数据字段不完整`)
  }
  return {
    version: value.version,
    label: typeof value.label === 'string' ? value.label : null,
    checksum: value.checksum,
    fileCount: value.fileCount,
    bytes: value.bytes,
    installedAt: value.installedAt,
  }
}
