import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SettingsError } from '../src/errors.ts'
import { createSettingsStore } from '../src/store.ts'

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'dizzyapi-settings-')), 'settings.json')
}

function isCorrupt(error: unknown): boolean {
  return error instanceof SettingsError && error.code === 'SETTINGS_STORE_CORRUPT'
}

test('JSON 存储：写入后能读回来', async () => {
  const path = await tempFile()
  const store = createSettingsStore(path)
  assert.deepEqual(await store.read(), { namespaces: {} })

  await store.write({
    namespaces: { mailer: { revision: 'abc', config: { transport: 'smtp' }, updatedAt: 't' } },
  })
  const snapshot = await store.read()
  assert.deepEqual(snapshot.namespaces.mailer?.config, { transport: 'smtp' })
})

test('文件不存在时按空启动', async () => {
  assert.deepEqual(await createSettingsStore(await tempFile()).read(), { namespaces: {} })
})

test('文件损坏时报错，不重建成空', async () => {
  const path = await tempFile()
  await writeFile(path, '这不是 JSON', 'utf8')
  await assert.rejects(createSettingsStore(path).read(), isCorrupt)
})

test('严格解码：版本 / 形状 / 必填字段不对都拒绝', async () => {
  const cases: readonly unknown[] = [
    { version: 2, namespaces: {} },
    { version: 1, namespaces: [] },
    { version: 1, namespaces: { mailer: { revision: '', config: {}, updatedAt: 't' } } },
    { version: 1, namespaces: { mailer: { revision: 'a', config: 'x', updatedAt: 't' } } },
    { version: 1, namespaces: { mailer: { revision: 'a', config: {} } } },
  ]

  for (const body of cases) {
    const path = await tempFile()
    await writeFile(path, JSON.stringify(body), 'utf8')
    await assert.rejects(createSettingsStore(path).read(), isCorrupt, JSON.stringify(body))
  }
})
