/**
 * 前端宿主服务（`frontend`）。
 *
 * 它只做 D13 交给前端插件的事：静态资源的版本 / 原子切换 / 回滚，
 * 以及「已启用插件贡献了哪些页面、设置卡与插槽」的清单。
 *
 * **不监听 HTTP、不转发 LLM 请求、不碰数据库、不读凭据。**
 * 字节由未来的 Go `httpapi` 或反向代理直接读 `<dataPath>` 发出去；
 * 本服务写出的 `manifest.json` 就是它们要读的清单。
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context, type Logger } from 'cordis'
import { describeError } from '@dizzyapi/plugin-kit'
import { AssetStore, type AssetBundle, type AssetVersionRecord, type InstalledAssetSet } from './assets.ts'
import { BUNDLED_ASSETS_DIR, bundledAssetVersion, prepareBundledFiles, readAssetDirectory } from './bundle.ts'
import { FRONTEND_CONFIG_SCHEMA, type ResolvedFrontendConfig } from './config.ts'
import { collectEnabledPlugins, type LoaderEntryLike } from './enabled.ts'
import {
  CORE_OWNER,
  ManifestRegistry,
  type ContributionBundle,
  type FrontendArea,
  type FrontendManifest,
  type FrontendPage,
  type FrontendSettingsCard,
  type FrontendSlot,
} from './manifest.ts'

export interface FrontendAssetsView {
  readonly dataPath: string
  readonly publicBase: string
  readonly assetBase: string | null
  readonly pointer: { readonly current: string; readonly previous: string | null; readonly updatedAt: string } | null
  readonly current: InstalledAssetSet | null
  readonly versions: readonly AssetVersionRecord[]
}

export interface FrontendDescription extends FrontendAssetsView {
  readonly apiBase: string
  readonly basePath: string
  readonly mode: 'rest' | 'mock'
  readonly manifest: FrontendManifest
}

interface FrontendStateFile {
  readonly enabled: boolean
  readonly revision: string
  readonly assetVersion: string | null
  readonly updatedAt: string
}

/**
 * 服务成员一律用 TS `private`，不用 `#`：cordis 以 Proxy 作 receiver 调用服务方法，
 * `#` 字段的 brand check 会抛「Receiver must be an instance of class」（AGENTS.md §10）。
 */
export class FrontendService extends Service {
  static Config = FRONTEND_CONFIG_SCHEMA
  static inject = ['loader']

  readonly config: ResolvedFrontendConfig
  private readonly logger: Logger
  private readonly dataPath: string
  private readonly store: AssetStore
  private readonly registry: ManifestRegistry
  private readonly manifestPath: string
  private readonly statePath: string
  private lastWrittenKey: string | null = null
  private syncScheduled = false
  private writeScheduled = false
  private disposed = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: ResolvedFrontendConfig) {
    super(ctx, 'frontend')
    this.config = config
    this.logger = ctx.logger('frontend')
    this.dataPath = resolveDataPath(ctx, config.dataPath)
    this.store = new AssetStore(this.dataPath, { keepVersions: config.keepVersions })
    this.registry = new ManifestRegistry({ enabledPlugins: [CORE_OWNER] })
    this.manifestPath = join(this.dataPath, 'manifest.json')
    this.statePath = join(this.dataPath, 'state.json')

    if (config.mode === 'mock') {
      this.logger.warn('前端处于 mock 模式：界面不会调用真实 REST；这只应出现在开发预览或本地演示')
    }

    // 插件树状态一变（启用 / 禁用 / 重载），清单就重算一次。微任务合并抖动。
    ctx.effect(() => {
      const offPlugin = ctx.root.on('internal/plugin', () => this.scheduleSync())
      const offStatus = ctx.root.on('internal/status', () => this.scheduleSync())
      return () => {
        offPlugin()
        offStatus()
        this.syncScheduled = false
        this.writeScheduled = false
      }
    }, 'frontend.manifest')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>> {
    if (this.config.autoInstall) {
      const installed = await this.installBundledAssets()
      this.logger.info(
        `静态资源已就绪：${installed.version}（${installed.fileCount} 个文件，基址 ${this.assetBase(installed.version)}）`,
      )
    } else {
      const current = await this.store.current()
      if (current === null) this.logger.warn('autoInstall 关闭且没有任何已安装资源：界面暂时没有可发的字节')
    }

    const snapshot = await this.sync()
    await this.writeState(true)
    this.logger.info(
      `前端清单已生成：${snapshot.pages.length} 个页面、${snapshot.settingsCards.length} 张设置卡、` +
        `${snapshot.slots.length} 个插槽条目（revision ${snapshot.revision}）`,
    )

    yield async () => {
      this.disposed = true
      this.syncScheduled = false
      this.writeScheduled = false
      await this.flush()
      await this.writeState(false).catch((error: unknown) => {
        this.logger.warn(`写入前端停用状态失败：${describeError(error)}`)
      })
    }
  }

  // ───────────────────────────────── 资源 ─────────────────────────────────

  /** 把包内 `assets/` 安装成当前版本；启动时自动调用，也可手动重装。 */
  async installBundledAssets(): Promise<InstalledAssetSet> {
    const source = await readAssetDirectory(BUNDLED_ASSETS_DIR)
    const version = bundledAssetVersion(source, this.config)
    const files = prepareBundledFiles(source, this.config, version)
    const installed = await this.store.install({ files, version, label: 'builtin' })
    await this.writeManifest(true)
    return installed
  }

  /** 手动安装一版资源（调用方负责提供 index.html 与 config.js 的最终内容）。 */
  async install(bundle: AssetBundle): Promise<InstalledAssetSet> {
    const installed = await this.store.install(bundle)
    await this.writeManifest(true)
    return installed
  }

  async rollback(): Promise<InstalledAssetSet> {
    const installed = await this.store.rollback()
    await this.writeManifest(true)
    return installed
  }

  async current(): Promise<InstalledAssetSet | null> {
    return this.store.current()
  }

  async assets(): Promise<FrontendAssetsView> {
    const current = await this.store.current()
    const pointer = await this.store.pointer()
    return {
      dataPath: this.dataPath,
      publicBase: this.config.publicBase,
      assetBase: current === null ? null : this.assetBase(current.version),
      pointer,
      current,
      versions: await this.store.versions(),
    }
  }

  /** 当前版本里的文件字节；Go / 反代集成应优先直接读磁盘。 */
  async readAsset(path: string, version?: string): Promise<Buffer> {
    return this.store.readAsset(path, version)
  }

  async assetPath(path: string, version?: string): Promise<string> {
    return this.store.assetPath(path, version)
  }

  /** 当前版本 index.html 的绝对路径；没有资源时为 null。 */
  async indexFile(): Promise<string | null> {
    const current = await this.store.current()
    if (current === null) return null
    return this.store.assetPath('index.html', current.version)
  }

  assetBase(version: string): string {
    return `${this.config.publicBase}/${version}/`
  }

  // ───────────────────────────────── 清单 ─────────────────────────────────

  /** 不含资源版本信息的同步快照，给设置页 / 桥查询用。 */
  snapshot(): FrontendManifest {
    return this.registry.snapshot()
  }

  /** 给浏览器与落盘用的完整清单（含当前资源版本与公开基址）。 */
  async manifest(): Promise<FrontendManifest> {
    const snapshot = this.registry.snapshot()
    const current = await this.store.current()
    return current === null
      ? snapshot
      : {
          ...snapshot,
          assets: { version: current.version, base: this.assetBase(current.version) },
        }
  }

  pages(area?: FrontendArea): readonly FrontendPage[] {
    const pages = this.registry.snapshot().pages
    return area === undefined ? pages : pages.filter((page) => page.area === area)
  }

  settingsCards(): readonly FrontendSettingsCard[] {
    return this.registry.snapshot().settingsCards
  }

  slots(slot?: string): readonly FrontendSlot[] {
    const slots = this.registry.snapshot().slots
    return slot === undefined ? slots : slots.filter((item) => item.slot === slot)
  }

  findPage(path: string): FrontendPage | undefined {
    return this.registry.snapshot().pages.find((page) => page.path === path)
  }

  /**
   * 运行期贡献页面 / 设置卡 / 插槽。返回 disposer，调用方应当把它挂在
   * `ctx.effect()` 上；插件卸载时条目随之消失。
   */
  registerContributions(owner: string, bundle: ContributionBundle): () => void {
    const dispose = this.registry.contribute(owner, bundle)
    this.scheduleWrite()
    return () => {
      dispose()
      this.scheduleWrite()
    }
  }

  /** 从 cordis 的 entry 列表重新计算启用集，并返回最新清单。 */
  async sync(): Promise<FrontendManifest> {
    const entries = [...this.ctx.loader.entries()] as unknown as LoaderEntryLike[]
    this.registry.setEnabledPlugins(collectEnabledPlugins(entries))
    await this.writeManifest(true)
    return this.manifest()
  }

  /** 手动覆盖启用集（运维 / 测试）；下一次 `sync()` 会以 loader 为准。 */
  setEnabledPlugins(ids: readonly string[]): FrontendManifest {
    this.registry.setEnabledPlugins(ids)
    this.scheduleWrite()
    return this.registry.snapshot()
  }

  async describe(): Promise<FrontendDescription> {
    const assets = await this.assets()
    return {
      ...assets,
      apiBase: this.config.apiBase,
      basePath: this.config.basePath,
      mode: this.config.mode,
      manifest: await this.manifest(),
    }
  }

  // ───────────────────────────────── 内部 ─────────────────────────────────

  private scheduleSync(): void {
    if (this.syncScheduled || this.disposed) return
    this.syncScheduled = true
    queueMicrotask(() => {
      this.syncScheduled = false
      if (this.disposed) return
      void this.sync().catch((error: unknown) => {
        this.logger.warn(`刷新前端清单失败：${describeError(error)}`)
      })
    })
  }

  private scheduleWrite(): void {
    if (this.writeScheduled || this.disposed) return
    this.writeScheduled = true
    queueMicrotask(() => {
      this.writeScheduled = false
      if (this.disposed) return
      void this.writeManifest(true).catch((error: unknown) => {
        this.logger.warn(`写入前端清单失败：${describeError(error)}`)
      })
    })
  }

  private writeManifest(force = false): Promise<void> {
    return this.enqueue(async () => {
      const manifest = await this.manifest()
      const key = `${manifest.revision}:${manifest.assets?.version ?? ''}`
      if (!force && key === this.lastWrittenKey) return
      await writeJsonAtomic(this.manifestPath, manifest)
      this.lastWrittenKey = key
    })
  }

  private writeState(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      const manifest = await this.manifest()
      const state: FrontendStateFile = {
        enabled,
        revision: manifest.revision,
        assetVersion: manifest.assets?.version ?? null,
        updatedAt: new Date().toISOString(),
      }
      await writeJsonAtomic(this.statePath, state)
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async flush(): Promise<void> {
    await this.queue.catch(() => undefined)
  }
}

function resolveDataPath(ctx: Context, path: string | undefined): string {
  const value = path ?? './data/frontend'
  if (isAbsolute(value)) return value
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, value)
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await rename(temp, path)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    await rm(path, { force: true })
    await rename(temp, path)
  }
}
