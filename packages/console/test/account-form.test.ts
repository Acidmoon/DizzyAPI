import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatModelMapInput, parseModelMapInput, parseModelsInput } from '../assets/lib/account-form.js'

test('parseModelsInput：逗号分隔、trim、去空、去重、保序，空 → null', () => {
  assert.deepEqual(parseModelsInput('gpt-5, gpt-5-codex'), ['gpt-5', 'gpt-5-codex'])
  assert.deepEqual(parseModelsInput('  gpt-5 ,, gpt-5 , o3 '), ['gpt-5', 'o3'], '去空、去重、保序')
  assert.deepEqual(parseModelsInput('claude-sonnet-4-5'), ['claude-sonnet-4-5'])
  assert.equal(parseModelsInput(''), null, '空输入 → null（未声明）')
  assert.equal(parseModelsInput('   ,  , '), null)
})

test('parseModelMapInput：每行 对外名=上游名，跳过坏行，空 → null', () => {
  assert.deepEqual(parseModelMapInput('gpt-5-codex=claude-sonnet-4-5'), {
    'gpt-5-codex': 'claude-sonnet-4-5',
  })
  assert.deepEqual(
    parseModelMapInput('  gpt-5 = gpt-5-2025 \n\no3=o3-mini\n无等号行\n=空键\n空值=\n'),
    { 'gpt-5': 'gpt-5-2025', o3: 'o3-mini' },
    'trim 键值、跳过空行 / 无等号 / 空键 / 空值',
  )
  assert.equal(parseModelMapInput(''), null, '空输入 → null（不改写）')
  assert.equal(parseModelMapInput('\n  \n'), null)
})

test('formatModelMapInput：往返一致，null → 空串', () => {
  assert.equal(formatModelMapInput(null), '')
  assert.equal(formatModelMapInput(undefined), '')
  const map = { 'gpt-5-codex': 'claude-sonnet-4-5', o3: 'o3-mini' }
  assert.deepEqual(parseModelMapInput(formatModelMapInput(map)), map, '格式化后能解析回同一映射')
})
