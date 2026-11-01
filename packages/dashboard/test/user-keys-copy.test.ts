/**
 * 「点密钥那一格复制」的行为与护栏。
 *
 * owner 的原话：**点外面的那个密钥的地方应该可以复制密钥**。
 * 这条链上有三个容易错的地方，逐条钉住：
 *
 * 1. 复制的是**完整 `secret`**，不是 `maskedKey`（复制掩码等于给用户一个用不了的 key）；
 * 2. `secret` 为 `null` / 空串时**不可复制**并说明原因，绝不复制空串；
 * 3. 显示文本始终是掩码：完整 key 不进 DOM 文本、不进 storage / URL / console。
 *
 * 另加两条**接线护栏**（都是本项目踩过的「写了没人用」）：
 * 页面必须真的挂上 `<KeyCopyCell>` 与 `<KeyEditDialog>`，否则弹窗与复制入口等于不存在。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as logicModule from '../app/src/app/(main)/user/keys/_components/key-edit-logic.ts'

import { unwrap } from './helpers/module-interop.ts'

const logic = unwrap<typeof logicModule>(logicModule)

const here = dirname(fileURLToPath(import.meta.url))
const keysDir = resolve(here, '../app/src/app/(main)/user/keys')

/** 去掉块注释与行注释（保留 `https://` 这类冒号后的双斜杠）——护栏约束代码，不约束文案。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function readCode(relative: string): string {
  return stripComments(readFileSync(join(keysDir, relative), 'utf8'))
}

const MASKED = 'DIZZY-abcd••••6789'
const SECRET = 'DIZZY-abcd0123456789ef'

test('复制目标是完整 secret，不是掩码；显示文本仍是掩码', () => {
  const target = logic.keyCopyTargetOf({ maskedKey: MASKED, secret: SECRET })
  assert.equal(target.copyable, true)
  if (!target.copyable) return
  assert.equal(target.secret, SECRET)
  assert.notEqual(target.secret, MASKED)
  assert.equal(target.label, MASKED, '显示文本必须是掩码')
})

test('secret 为 null（受限视图）→ 不可复制并给出原因', () => {
  const target = logic.keyCopyTargetOf({ maskedKey: MASKED, secret: null })
  assert.equal(target.copyable, false)
  if (target.copyable) return
  assert.equal(target.label, MASKED)
  assert.ok(target.reason.length > 0, '要给原因，不能只灰掉')
})

test('secret 是空串 → 也不可复制（绝不把空串送进剪贴板）', () => {
  assert.equal(logic.keyCopyTargetOf({ maskedKey: MASKED, secret: '' }).copyable, false)
})

test('页面真的挂上了复制格子与编辑弹窗', () => {
  const page = readCode('page.tsx')
  assert.ok(page.includes('<KeyCopyCell'), '密钥列没有复制格子')
  assert.ok(page.includes('maskedKey={key.maskedKey}'), '复制格子要拿掩码做显示文本')
  assert.ok(page.includes('<KeyEditDialog'), '编辑弹窗没接到页面上')
  // 行上只剩编辑 / 轮换 / 删除：改名按钮已经收进编辑弹窗。
  assert.equal(page.includes('改名'), false, '行上还有「改名」按钮，应统一收进编辑弹窗')
})

test('明文纪律：新文件不落 storage / cookie / console / URL', () => {
  for (const file of ['page.tsx', '_components/key-copy-cell.tsx', '_components/key-edit-dialog.tsx']) {
    const source = readCode(file)
    for (const forbidden of [
      'localStorage.',
      'sessionStorage.',
      'console.log',
      'console.info',
      'console.warn',
      'document.cookie',
      'history.pushState',
      'dangerouslySetInnerHTML',
    ]) {
      assert.equal(source.includes(forbidden), false, `${file} 出现 ${forbidden}`)
    }
  }
})

test('复制成功与失败都要有反馈（不许静默）', () => {
  const cell = readCode('_components/key-copy-cell.tsx')
  assert.ok(cell.includes('toast.success('), '复制成功没有提示')
  assert.ok(cell.includes('toast.error('), '复制失败没有提示')
  assert.ok(cell.includes('navigator.clipboard'), '没有用剪贴板 API，而是别的歪路')
})
