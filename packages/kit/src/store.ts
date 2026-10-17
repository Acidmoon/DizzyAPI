import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 存储适配器的边界：一次读入、一次整份写回。
 *
 * 之所以把存储做成可替换的适配器，而不是让插件直接写文件：
 * 按 AGENTS.md D8，账户 / 额度 / 流水这些数据的唯一写者最终是 Go。
 * 控制面插件现在自己落盘，只是「Go 与桥尚未存在」这一段时期的临时安排；
 * 等桥就绪，换一个 bridge 适配器即可，插件的对外接口一字不改。
 */
export interface JsonStore<T> {
  /** 供日志与排障：人类可读的描述。 */
  readonly describe: string
  /** 绝对路径；内存存储为 undefined。 */
  readonly path: string | undefined
  read(): Promise<T>
  write(value: T): Promise<void>
  close(): Promise<void>
}

export interface JsonCodec<T> {
  /** 领域对象 → 可 JSON 化的形状（bigint、Map 等在这里转换）。 */
  encode(value: T): unknown
  /** 可 JSON 化的形状 → 领域对象；数据不合法必须抛错，不许静默降级。 */
  decode(raw: unknown): T
}

/**
 * JSON 文件存储：写是原子的——先写同目录的 `<path>.tmp`，再 rename 覆盖。
 *
 * `mode` 只在新建文件时生效（rename 保留临时文件的权限位），Windows 忽略它；
 * 存秘密的场合传 `0o600`。
 */
export function jsonFileStore<T>(
  path: string,
  codec: JsonCodec<T>,
  empty: () => T,
  options: { readonly mode?: number } = {},
): JsonStore<T> {
  return {
    describe: `json（${path}）`,
    path,

    async read() {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if (isFileNotFound(error)) return empty()
        throw error
      }
      return codec.decode(JSON.parse(text))
    },

    async write(value) {
      const payload = `${JSON.stringify(codec.encode(value), null, 2)}\n`
      const temp = `${path}.tmp`
      await mkdir(dirname(path), { recursive: true })
      const encoding =
        options.mode === undefined
          ? ({ encoding: 'utf8' } as const)
          : ({ encoding: 'utf8', mode: options.mode } as const)
      await writeFile(temp, payload, encoding)
      await rename(temp, path)
    },

    async close() {
      // 每次改动都已落盘，没有需要 flush 的状态
    },
  }
}

/** 内存存储：进程退出即丢，用于测试与「不需要持久化」的场合。 */
export function memoryStore<T>(empty: () => T): JsonStore<T> {
  let current = empty()
  return {
    describe: 'memory（进程退出即丢）',
    path: undefined,

    async read() {
      return current
    },

    async write(value) {
      current = value
    },

    async close() {
      // 没有待落盘的东西
    },
  }
}

export function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
