import { jsonFileStore, memoryStore, type JsonCodec, type JsonStore } from '@dizzyapi/plugin-kit'
import { SettingsError } from './errors.ts'
import { isPlainObject } from './merge.ts'

/**
 * 覆盖文件。**这是设置插件独有的文件**，`app.yml` 仍然是「人写的基线」。
 *
 * ```
 * { "version": 1,
 *   "namespaces": {
 *     "mailer": { "revision": "9f2c…", "config": { … }, "updatedAt": "…" } } }
 * ```
 *
 * 为什么是 JSON 而不是 YAML：这个文件由程序写、从不手改，因此用不着注释，
 * 也就用不着为它引一个 YAML 依赖——直接复用 kit 那个原子写的 JSON 适配器。
 * 人在意的注释留在 app.yml 里，那正是基线的本分。
 */
export interface NamespaceRecord {
  /** 覆盖内容的指纹，见 revision.ts。 */
  readonly revision: string
  /** 只装**覆盖**的那部分，不是合并后的完整配置。 */
  readonly config: Record<string, unknown>
  readonly updatedAt: string
}

export interface SettingsSnapshot {
  readonly namespaces: Readonly<Record<string, NamespaceRecord>>
}

export const SNAPSHOT_VERSION = 1

export function emptySnapshot(): SettingsSnapshot {
  return { namespaces: {} }
}

interface WireSnapshot {
  version: number
  namespaces: Record<string, NamespaceRecord>
}

/** 严格解码：版本不认识、形状不对直接抛，**绝不重建成空**。 */
export const settingsCodec: JsonCodec<SettingsSnapshot> = {
  encode(value) {
    const wire: WireSnapshot = { version: SNAPSHOT_VERSION, namespaces: {} }
    for (const [ns, record] of Object.entries(value.namespaces)) {
      wire.namespaces[ns] = {
        revision: record.revision,
        config: record.config,
        updatedAt: record.updatedAt,
      }
    }
    return wire
  },

  decode(raw) {
    const wire = requireObject(raw, '根对象')
    if (wire.version !== SNAPSHOT_VERSION) {
      throw corrupt(`版本不受支持：${String(wire.version)}（本插件只认 ${SNAPSHOT_VERSION}）`)
    }
    const rawNamespaces = requireObject(wire.namespaces, 'namespaces')

    const namespaces: Record<string, NamespaceRecord> = {}
    for (const [ns, value] of Object.entries(rawNamespaces)) {
      const record = requireObject(value, `namespaces[${ns}]`)
      if (typeof record.revision !== 'string' || record.revision === '') {
        throw corrupt(`namespaces[${ns}].revision 必须是非空字符串`)
      }
      if (!isPlainObject(record.config)) {
        throw corrupt(`namespaces[${ns}].config 必须是对象`)
      }
      if (typeof record.updatedAt !== 'string') {
        throw corrupt(`namespaces[${ns}].updatedAt 必须是字符串`)
      }
      namespaces[ns] = {
        revision: record.revision,
        config: record.config,
        updatedAt: record.updatedAt,
      }
    }
    return { namespaces }
  },
}

/** 省略路径即纯内存，进程退出即丢。 */
export function createSettingsStore(dataPath: string | undefined): JsonStore<SettingsSnapshot> {
  if (dataPath === undefined) return memoryStore(emptySnapshot)

  const inner = jsonFileStore(dataPath, settingsCodec, emptySnapshot)
  return {
    ...inner,
    /**
     * kit 的 jsonFileStore 先把文件解析成 JSON 再交给 codec，所以「文件根本不是 JSON」
     * 会在到达 codec 之前抛 SyntaxError。那属于文件损坏，折回 SETTINGS_STORE_CORRUPT。
     */
    async read() {
      try {
        return await inner.read()
      } catch (error) {
        if (error instanceof SyntaxError) throw corrupt(`不是合法 JSON（${error.message}）`)
        throw error
      }
    },
  }
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw corrupt(`${where} 不是对象`)
  return value
}

function corrupt(detail: string): SettingsError {
  return new SettingsError('SETTINGS_STORE_CORRUPT', `设置覆盖文件损坏：${detail}`)
}
