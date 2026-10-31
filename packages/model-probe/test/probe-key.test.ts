/**
 * 探测 key 的创建 / 恢复护栏。
 *
 * 硬要求（总工下的）：
 * - 用 `appManaged: true` 创建，用户误删不了；
 * - **明文只在创建 / 轮换那一刻出现，立刻写进 `credentials`**；
 * - 本插件之后只持引用名 —— 下面用一个记录「写过什么」的假 credentials 来钉住这一条。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { PROBE_KEY_NAME, PROBE_KEY_NAME_PREFIX, ensureProbeKey, type ApiKeySeam, type CredentialsSeam } from '../src/probe-key.ts'

interface FakeKey {
  id: string
  name: string
  appManaged: boolean
  enabled: boolean
  secret: string | null
}

/** 一个够用的假 api-key / credentials，记录所有写过的值。 */
function harness(initial: FakeKey[] = []) {
  const keys: FakeKey[] = initial.map((key) => ({ ...key }))
  const secrets = new Map<string, string>()
  const created: { name: string; appManaged?: boolean }[] = []
  const rotated: string[] = []
  let nextId = 100

  const apiKey: ApiKeySeam = {
    async list() {
      return keys.map((key) => ({ ...key }))
    },
    async create(_userId, input) {
      created.push(input)
      nextId += 1
      const key: FakeKey = {
        id: `key-${nextId}`,
        name: input.name,
        appManaged: input.appManaged === true,
        enabled: true,
        secret: 'sk-dz-new-secret',
      }
      keys.push(key)
      return { key: { ...key }, secret: 'sk-dz-new-secret' }
    },
    async rotate(_userId, id) {
      rotated.push(id)
      const key = keys.find((item) => item.id === id)
      assert.ok(key !== undefined, `rotating unknown key ${id}`)
      key.secret = 'sk-dz-rotated-secret'
      return { key: { ...key }, secret: 'sk-dz-rotated-secret' }
    },
  }

  const credentials: CredentialsSeam = {
    describe(ref) {
      return { configured: secrets.has(ref) }
    },
    resolve(ref) {
      return secrets.get(ref)
    },
    async set(ref, value) {
      secrets.set(ref, value)
    },
  }

  return { apiKey, credentials, keys, secrets, created, rotated }
}

const REF = 'dizzyapi/model-probe/key'

function deps(env: ReturnType<typeof harness>, remembered?: string) {
  let keyId = remembered
  return {
    apiKey: env.apiKey,
    credentials: env.credentials,
    userId: 1,
    ref: REF,
    rememberKeyId: (id: string) => {
      keyId = id
    },
    recallKeyId: () => keyId,
    log: () => {
      // 静默
    },
  }
}

test('第一次：创建 appManaged 的 key，并把明文写进 credentials', async () => {
  const env = harness()
  const state = await ensureProbeKey(deps(env))

  assert.equal(state.keyName, PROBE_KEY_NAME)
  assert.ok(state.keyName.startsWith(PROBE_KEY_NAME_PREFIX))
  assert.equal(env.created.length, 1)
  assert.equal(env.created[0].name, PROBE_KEY_NAME)
  assert.equal(env.created[0].appManaged, true, '必须是应用托管，否则用户能误删')
  assert.equal(env.secrets.get(REF), 'sk-dz-new-secret')
})

test('第二次（已有 key + 明文在）：不新建、不轮换', async () => {
  const env = harness()
  const first = await ensureProbeKey(deps(env))
  const second = await ensureProbeKey(deps(env, first.keyId))

  assert.equal(second.keyId, first.keyId)
  assert.equal(env.created.length, 1, '不该再建一把')
  assert.equal(env.rotated.length, 0, '明文还在就不该轮换')
})

test('有 key 记录但明文丢了 → 轮换一次补回明文', async () => {
  const env = harness([{ id: 'key-old', name: PROBE_KEY_NAME, appManaged: true, enabled: true, secret: null }])
  const state = await ensureProbeKey(deps(env, 'key-old'))

  assert.equal(state.keyId, 'key-old')
  assert.deepEqual(env.rotated, ['key-old'])
  assert.equal(env.created.length, 0, '已有同名 key 时不该另建')
  assert.equal(env.secrets.get(REF), 'sk-dz-rotated-secret')
})

test('meta 丢了但 api-key 列表里有同名 key → 认它并轮换（换机器 / 清过库也能恢复）', async () => {
  const env = harness([{ id: 'key-exist', name: PROBE_KEY_NAME, appManaged: true, enabled: true, secret: null }])
  const state = await ensureProbeKey(deps(env))

  assert.equal(state.keyId, 'key-exist')
  assert.deepEqual(env.rotated, ['key-exist'])
  assert.equal(env.created.length, 0)
})

test('明文在但记录已被删 → 重新建一把（不复用失效引用）', async () => {
  const env = harness()
  // 先手工塞一份「孤儿明文」，模拟 key 被删了但 credentials 还留着。
  env.secrets.set(REF, 'sk-dz-orphan')
  const state = await ensureProbeKey(deps(env, 'key-gone'))

  assert.equal(state.keyId, 'key-101')
  assert.equal(env.created.length, 1)
  assert.equal(env.secrets.get(REF), 'sk-dz-new-secret', '孤儿明文要被新明文覆盖')
})

test('key 名带 __probe__ 前缀：饼图按前缀排除探测流量', () => {
  assert.ok(PROBE_KEY_NAME_PREFIX.length > 0)
  assert.ok(PROBE_KEY_NAME.startsWith(PROBE_KEY_NAME_PREFIX))
})
