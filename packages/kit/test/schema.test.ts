import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkConfigObject,
  flattenFields,
  knownKeysOf,
  readString,
  standardSchema,
  type FieldSpec,
} from '../src/index.ts'

interface Demo {
  readonly host: string
  readonly port: number | undefined
}

const DEMO_FIELDS: readonly FieldSpec[] = [
  { key: 'host', label: '主机', kind: 'string', writable: true },
  { key: 'port', label: '端口', kind: 'integer', min: 1, max: 65_535 },
  { key: 'smtp', label: 'SMTP', kind: 'object', fields: [{ key: 'user', label: '用户名', kind: 'string' }] },
]

function validateDemo(value: unknown): Demo | readonly { message: string }[] {
  const { raw, issues } = checkConfigObject(value, knownKeysOf(DEMO_FIELDS))
  const host = readString(raw, 'host', issues)
  if (issues.length > 0) return issues
  return { host: host ?? '', port: undefined }
}

test('不给字段元数据时，schema 上就没有 fields', () => {
  const schema = standardSchema<Demo>('test', validateDemo)
  assert.equal('fields' in schema, false)
  assert.equal(schema.fields, undefined)
})

test('给了字段元数据时，原样挂在 schema 上（不影响校验）', () => {
  const schema = standardSchema<Demo>('test', validateDemo, DEMO_FIELDS)
  assert.equal(schema.fields, DEMO_FIELDS)

  const ok = schema['~standard'].validate({ host: 'smtp.example.com' })
  assert.ok('value' in ok)
  assert.equal(ok.value.host, 'smtp.example.com')

  const bad = schema['~standard'].validate({ nope: 1 })
  assert.ok('issues' in bad)
  assert.equal(bad.issues.length, 1)
})

test('knownKeysOf 只取顶层键', () => {
  assert.deepEqual(knownKeysOf(DEMO_FIELDS), ['host', 'port', 'smtp'])
})

test('flattenFields 展平成点分路径，父字段也在', () => {
  assert.deepEqual(
    flattenFields(DEMO_FIELDS).map((field) => field.path),
    ['host', 'port', 'smtp', 'smtp.user'],
  )
})

test('校验的已知键与元数据是同一份，不会漂移', () => {
  const schema = standardSchema<Demo>('test', validateDemo, DEMO_FIELDS)
  // 元数据里加了 port，校验就得认 port，否则「未知配置项」会把它打回来
  assert.equal(checkConfigObject({ host: 'x', port: 25 }, knownKeysOf(schema.fields ?? [])).issues.length, 0)
})
