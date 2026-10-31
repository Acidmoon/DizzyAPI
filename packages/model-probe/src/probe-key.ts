/**
 * 探测 key 的创建与轮换。
 *
 * 三条纪律：
 * 1. **明文只在创建 / 轮换那一次出现**，立刻写进 `credentials`；本插件之后只持**引用名**。
 *    明文永不进 `model-probe.db`、日志、探测记录、错误信息。
 * 2. 用 `appManaged: true` 创建：用户页会把它标成「应用托管」并禁止改名 / 停用 / 删除 / 轮换，
 *    避免探测 key 被人误删，也不会和用户自己起的 key 混淆。
 * 3. 名字固定 `__probe__` 前缀：饼图按**前缀**排除探测流量（不硬编码具体名字）。
 */
import { ModelProbeError } from './errors.ts'

/** 探测 key 的名字。前缀是约定，`用量` 线的饼图按它排除探测流量。 */
export const PROBE_KEY_NAME = '__probe__dizzy'

/** 名字前缀：饼图过滤与「这是不是探测 key」的判断都用它，别用全名。 */
export const PROBE_KEY_NAME_PREFIX = '__probe__'

export interface ApiKeyViewLike {
  readonly id: string
  readonly name: string
  readonly appManaged: boolean
  readonly enabled: boolean
  readonly secret: string | null
}

/** `api-key` 服务里本插件用到的那几个方法（只声明结构，不 import 实现）。 */
export interface ApiKeySeam {
  list(userId: number): Promise<ApiKeyViewLike[]>
  create(userId: number, input: { name: string; appManaged?: boolean }): Promise<{ key: ApiKeyViewLike; secret: string }>
  rotate(userId: number, id: string): Promise<{ key: ApiKeyViewLike; secret: string }>
}

/** `credentials` 服务里本插件用到的那几个方法。 */
export interface CredentialsSeam {
  describe(ref: string): { readonly configured: boolean }
  resolve(ref: string): string | undefined
  set(ref: string, value: string): Promise<void>
}

export interface ProbeKeyDeps {
  readonly apiKey: ApiKeySeam
  readonly credentials: CredentialsSeam
  readonly userId: number
  readonly ref: string
  /** 记住 keyId 的落点（`model_probe_meta`），避免每次都去 list 一遍。 */
  readonly rememberKeyId: (keyId: string) => void
  readonly recallKeyId: () => string | undefined
  readonly log: (message: string) => void
}

export interface ProbeKeyState {
  readonly keyId: string
  readonly keyName: string
}

/**
 * 确保有一把可用的探测 key，并把明文落进 `credentials`。
 *
 * 四种情况：
 * - credentials 里有值、meta 记得 keyId，且它还在 api-key 的列表里 → 直接用；
 * - meta 记得 keyId 但 credentials 里没值（被清过）→ **轮换**拿到新明文；
 * - api-key 列表里已有同名 appManaged key（`meta` 丢了 / 换机器）→ 轮换它；
 * - 都没有 → 新建一把。
 */
export async function ensureProbeKey(deps: ProbeKeyDeps): Promise<ProbeKeyState> {
  const remembered = deps.recallKeyId()
  const configured = deps.credentials.describe(deps.ref).configured

  const keys = await safeList(deps)
  const byId = remembered === undefined ? undefined : keys.find((key) => key.id === remembered)
  const byName = keys.find((key) => key.name === PROBE_KEY_NAME)
  const existing = byId ?? byName

  if (existing !== undefined) {
    if (configured && deps.credentials.resolve(deps.ref) !== undefined) {
      deps.rememberKeyId(existing.id)
      return { keyId: existing.id, keyName: existing.name }
    }
    // 有 key 记录但明文丢了：轮换一次拿新明文（旧明文同时失效，不会留下第二份有效秘密）。
    const rotated = await deps.apiKey.rotate(deps.userId, existing.id)
    await deps.credentials.set(deps.ref, rotated.secret)
    deps.rememberKeyId(rotated.key.id)
    deps.log(`探测 key 的明文缺失，已轮换并写回 credentials（引用名 ${deps.ref}）`)
    return { keyId: rotated.key.id, keyName: rotated.key.name }
  }

  const created = await deps.apiKey.create(deps.userId, { name: PROBE_KEY_NAME, appManaged: true })
  await deps.credentials.set(deps.ref, created.secret)
  deps.rememberKeyId(created.key.id)
  deps.log(`已创建探测 key「${PROBE_KEY_NAME}」（应用托管），明文已写入 credentials（引用名 ${deps.ref}）`)
  return { keyId: created.key.id, keyName: created.key.name }
}

async function safeList(deps: ProbeKeyDeps): Promise<ApiKeyViewLike[]> {
  try {
    return await deps.apiKey.list(deps.userId)
  } catch (error) {
    throw new ModelProbeError(
      'MODEL_PROBE_KEY_UNAVAILABLE',
      `读取探测用户的 API key 列表失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
