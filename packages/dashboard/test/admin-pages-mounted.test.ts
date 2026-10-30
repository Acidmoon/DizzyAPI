/**
 * 护栏：页面正文组件**必须真的被 page.tsx 挂上**。
 *
 * 这条是从一个真 bug 来的（2026-10-31）：`/dashboard` 的正文组件
 * （`dashboard-overview.tsx`）写完了、也过了类型检查，但 `page.tsx` 还留着占位文案，
 * **全仓没有一处 import 它**。`pnpm test` 与 `next build` **都不会报这种错** ——
 * 孤立组件照样测试全绿、构建全过，只有真浏览器或读代码才看得见。
 *
 * 判定两条，代价极低：
 * 1. 每个 `page.tsx` 必须 import 至少一个 `_components/` 里的东西；
 * 2. 命名约定为 `*-board.tsx` / `*-overview.tsx` 的正文组件，必须被某个 `page.tsx` import。
 *
 * 弹窗（`*-dialog.tsx`）与共用件（三态 / 取数 hook）由 board 引用，不由 page 直接挂，
 * 所以不参与第 2 条——**别把这条规则做成一刀切**，否则会逼着把弹窗硬塞进 page。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'

const DASHBOARD_ROOT = join(import.meta.dirname, '..', 'app', 'src', 'app', '(main)', 'dashboard')

/** 递归列出文件。 */
function walk(dir: string, suffixes: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, suffixes))
    else if (suffixes.some((suffix) => entry.endsWith(suffix))) out.push(full)
  }
  return out
}

const pageFiles = walk(DASHBOARD_ROOT, ['page.tsx'])
const componentFiles = walk(join(DASHBOARD_ROOT, '_components'), ['.tsx'])

test('每个 page.tsx 都必须 import 正文组件', () => {
  assert.ok(pageFiles.length >= 4, `页面数太少（${String(pageFiles.length)}），路径可能写错了`)
  const offenders = pageFiles
    .filter((file) => !readFileSync(file, 'utf8').includes('_components/'))
    .map((file) => relative(DASHBOARD_ROOT, file))
  assert.deepEqual(offenders, [], `这些 page.tsx 没挂正文组件：\n${offenders.join('\n')}`)
})

test('每个正文组件（*-board / *-overview）都必须被某个 page.tsx 挂上', () => {
  // 命名约定：页面正文一律 `*-board.tsx` / `*-overview.tsx`。
  const bodies = componentFiles.filter((file) => /-(board|overview)\.tsx$/.test(file))
  assert.ok(bodies.length >= 3, `正文组件太少（${String(bodies.length)}），命名约定可能变了`)
  const pageSources = pageFiles.map((file) => readFileSync(file, 'utf8')).join('\n')
  const orphans: string[] = []
  for (const body of bodies) {
    const base = (body.split(sep).pop() ?? '').replace(/\.tsx$/, '')
    // 页面 import 时用不带扩展名的路径：`_components/<name>`。
    if (!pageSources.includes(`_components/${base}"`)) orphans.push(`${base}.tsx`)
  }
  assert.deepEqual(
    orphans,
    [],
    `这些正文组件没有任何 page.tsx 挂上（写完忘了 import）：\n${orphans.join('\n')}`,
  )
})
