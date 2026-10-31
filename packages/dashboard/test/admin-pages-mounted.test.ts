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

/**
 * 第三条：管理台的每个页面目录都必须在 `sidebar-items.ts` 里登记。
 *
 * 理由：侧栏清单是路由的**唯一源**。目录建了却没登记 = 用户点不到
 * （只能靠手输 URL），而页面上不会报错——这类「建了等于没建」只有读代码才看得见。
 * 反过来，登记了却没建目录 = 点进去是 404，更容易被发现；所以这条只查前半段。
 */
test('每个管理页目录都在 sidebar-items.ts 里登记了', () => {
  const sidebar = readFileSync(
    join(DASHBOARD_ROOT, '..', '..', '..', 'navigation', 'sidebar', 'sidebar-items.ts'),
    'utf8',
  )
  // `/dashboard` 本身是根页，它的 page.tsx 在 DASHBOARD_ROOT 下，没有自己的目录名。
  const dirs = new Set<string>()
  for (const page of pageFiles) {
    const rel = relative(DASHBOARD_ROOT, page).split(sep)
    if (rel.length >= 2) dirs.add(rel[0] as string)
  }
  assert.ok(dirs.size >= 5, `页面目录太少（${String(dirs.size)}），路径可能写错了`)
  const offenders = [...dirs].filter((dir) => !sidebar.includes(`"/dashboard/${dir}"`))
  assert.deepEqual(
    offenders,
    [],
    `这些页面目录没在 sidebar-items.ts 登记（用户只能手输 URL 进来）：\n${offenders.join('\n')}`,
  )
})

/**
 * 第四条：**每个页面私有弹窗都必须被某个组件挂上**。
 *
 * 这条是 2026-10-31 补的：owner 提「管理员的上游账号页必须能添加账号」，
 * 结果服务端 `POST /api/accounts` 与客户端 `createAccount()` **早就有**，
 * 缺的是页面上的入口——弹窗写完没接到 board 上，管理员照样没法建账号。
 *
 * 与第 2 条的区别：第 2 条管「正文组件被 page 挂上」，这条管「弹窗被 board 挂上」。
 * 两者都是「东西写了但没人用」——`pnpm test` 与 `next build` **都不会报**，
 * 只有真浏览器点一下才发现。
 *
 * **范围只限页面私有弹窗**：`_components/` 根下的 `*-dialog.tsx`。
 * `header/` `sidebar/` 这些**站点外壳**目录里的弹窗（`search-dialog` 等）
 * 由外壳自己用，不受这条约束——把它们算进来会误报。
 */
test('每个页面私有弹窗（*-dialog.tsx）都必须被某个组件挂上', () => {
  const dialogs = componentFiles.filter(
    (file) => file.endsWith('-dialog.tsx') && relative(join(DASHBOARD_ROOT, '_components'), file).split(sep).length === 1,
  )
  assert.ok(dialogs.length >= 4, `弹窗太少（${String(dialogs.length)}），命名约定可能变了`)
  const componentSources = componentFiles.map((file) => readFileSync(file, 'utf8')).join('\n')
  const orphans: string[] = []
  for (const dialog of dialogs) {
    const base = (dialog.split(sep).pop() ?? '').replace(/\.tsx$/, '')
    if (!componentSources.includes(`./${base}"`)) orphans.push(`${base}.tsx`)
  }
  assert.deepEqual(
    orphans,
    [],
    `这些弹窗没有任何组件挂上（写完忘了接）：\n${orphans.join('\n')}`,
  )
})
