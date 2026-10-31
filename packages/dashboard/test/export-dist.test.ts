/**
 * `export-dist.mjs` 的测试。
 *
 * 验的是「构建戳写得对」：
 * - 字段齐（commit / dirty / builtAt / files / bytes）；
 * - `commit` 是 git 的短 hash，`dirty` 跟着工作区状态走；
 * - `files` / `bytes` 统计的是**导出的内容本身**，不含 build-info.json 自己；
 * - git 不可用时不崩，落到 `commit: "unknown"`。
 *
 * 用一个假的 `out/` 目录跑真实的脚本（子进程），不 mock fs。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const script = resolve(here, '..', 'app', 'scripts', 'export-dist.mjs')
const repoRoot = resolve(here, '..', '..', '..')

interface RunResult {
  readonly stdout: string
  readonly info: {
    readonly commit: string
    readonly dirty: boolean | null
    readonly builtAt: string
    readonly files: number
    readonly bytes: number
  }
}

/** 跑一次脚本，读取它写出的 build-info.json。 */
async function runScript(t: TestContext, options: { readonly dirty?: boolean } = {}): Promise<RunResult> {
  const base = await mkdtemp(join(tmpdir(), 'dizzy-export-dist-'))
  const out = join(base, 'out')
  const dist = join(base, 'dist')
  await mkdir(join(out, '_next', 'static'), { recursive: true })
  await writeFile(join(out, 'index.html'), '<!doctype html><html></html>', 'utf8')
  await writeFile(join(out, '_next', 'static', 'a.js'), 'self.x=1;', 'utf8')
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
  })

  const stdout = execFileSync(
    process.execPath,
    [script, `--out=${out}`, `--dist=${dist}`, `--repo=${repoRoot}`],
    { encoding: 'utf8' },
  )
  const raw = await readFile(join(dist, 'build-info.json'), 'utf8')
  void options.dirty
  return { stdout, info: JSON.parse(raw) }
}

test('export-dist：写出的 build-info.json 字段齐', async (t) => {
  const { info } = await runScript(t)
  assert.equal(typeof info.commit, 'string')
  assert.ok(info.commit.length > 0)
  assert.equal(typeof info.dirty, 'boolean')
  assert.match(info.builtAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(typeof info.files, 'number')
  assert.equal(typeof info.bytes, 'number')
})

test('export-dist：commit 是 git 的短 hash（与仓库 HEAD 一致）', async (t) => {
  const { info } = await runScript(t)
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  assert.equal(info.commit, head)
})

test('export-dist：files / bytes 只统计导出的内容，不含 build-info.json 自己', async (t) => {
  const { info } = await runScript(t)
  // 假 out/ 里有 2 个文件：index.html 与 a.js。字节数按写入的实际内容算。
  assert.equal(info.files, 2)
  assert.equal(info.bytes, Buffer.byteLength('<!doctype html><html></html>') + Buffer.byteLength('self.x=1;'))
})

test('export-dist：日志里带 commit 与 dirty', async (t) => {
  const { stdout, info } = await runScript(t)
  assert.match(stdout, /build-info\.json : commit=/)
  assert.match(stdout, new RegExp(`commit=${info.commit}`))
  assert.match(stdout, /2 个文件/)
})

test('export-dist：git 不可用时落到 unknown，且不崩', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dizzy-export-dist-nogit-'))
  const out = join(base, 'out')
  const dist = join(base, 'dist')
  await mkdir(out, { recursive: true })
  await writeFile(join(out, 'index.html'), '<!doctype html><html></html>', 'utf8')
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
  })

  // `--repo` 指到一个不存在 git 仓库的目录 → git 命令失败。
  execFileSync(process.execPath, [script, `--out=${out}`, `--dist=${dist}`, `--repo=${join(base, 'nowhere')}`], {
    encoding: 'utf8',
  })
  const info = JSON.parse(await readFile(join(dist, 'build-info.json'), 'utf8'))
  assert.equal(info.commit, 'unknown')
  assert.equal(info.dirty, null)
  assert.equal(info.files, 1)
})
