/**
 * 用户侧 5 页的护栏（充值 / 兑换码 / 模型广场 / 文档 / 个人资料）。
 *
 * 与 `user-pages-guards.test.ts`（前 4 页）分工：那份管「越权 / 价格表只读 / secret 不外泄」，
 * 这份管这 5 页特有的纪律：
 * - 充值必须明说「不会自动到账」（下单成功 ≠ 到账）；
 * - 兑换码是凭据：不进 URL / storage / console，失败提示不回显码；
 * - 模型广场与文档**只读**（没有写入口）；
 * - 文档内容的唯一源是仓库 `docs/api/*.md`，`public/docs/` 由构建期同步生成（不入库，防漂移）；
 * - 个人资料的密码只走 body、提交后清空。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '../app')
const userRoot = join(app, 'src/app/(main)/user')

const NEW_PAGES = ['topup/page.tsx', 'redeem/page.tsx', 'models/page.tsx', 'docs/page.tsx', 'profile/page.tsx'] as const

function read(relative: string): string {
  return readFileSync(join(userRoot, relative), 'utf8')
}

/** 去掉注释后的源码（护栏约束代码，不是文案）。 */
function readCode(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('越权与只读', () => {
  for (const page of NEW_PAGES) {
    it(`${page} 不碰管理面接口`, () => {
      assert.ok(!readCode(page).includes('/api/admin'), `${page} 引用了管理面接口`)
    })
  }

  it('模型广场没有写入口（改模型与价格是管理台的事）', () => {
    const source = readCode('models/page.tsx')
    for (const forbidden of ['setModelPrice', 'deleteModelPrice', '新增', '编辑', '删除']) {
      assert.ok(!source.includes(forbidden), `模型广场出现写入口：${forbidden}`)
    }
  })

  it('文档页没有写入口', () => {
    const source = readCode('docs/page.tsx')
    for (const forbidden of ['method: "PUT"', 'method: "DELETE"', '提交', '保存']) {
      assert.ok(!source.includes(forbidden), `文档页出现写入口：${forbidden}`)
    }
  })
})

describe('充值：下单 ≠ 到账', () => {
  const source = readCode('topup/page.tsx')

  it('页面明确写「不会自动到账」', () => {
    assert.ok(source.includes('不会自动到账'))
  })

  it('下单成功的提示是「订单已创建」，不是「充值成功」', () => {
    assert.ok(source.includes('订单已创建'))
    assert.ok(!source.includes('充值成功'))
  })

  it('取消订单要二次确认（AlertDialog），不用 window.confirm', () => {
    assert.ok(source.includes('AlertDialog'))
    assert.ok(!source.includes('window.confirm'))
  })
})

describe('兑换码：凭据纪律', () => {
  const source = readCode('redeem/page.tsx')

  it('码不进 storage / console / URL', () => {
    for (const forbidden of ['localStorage.', 'sessionStorage.', 'console.log', 'history.pushState']) {
      assert.ok(!source.includes(forbidden), `出现 ${forbidden}`)
    }
  })

  it('失败提示走稳定码映射，不回显用户输入的码', () => {
    assert.ok(source.includes('redeemErrorMessage'))
    assert.ok(!/toast\.error\(\s*code\s*\)/.test(source), '把用户输入的码直接打进提示了')
  })
})

describe('文档：唯一源是 docs/api，副本由构建期同步', () => {
  const repoDocs = resolve(app, '../../../docs/api')
  const gitignore = resolve(app, '../../../.gitignore')

  const DOCS = ['01-overview.md', '02-endpoints.md', '03-errors.md', '04-examples.md', '05-limits-billing.md']

  it('5 个源文件都在仓库根 docs/api（唯一源）', () => {
    for (const name of DOCS) assert.ok(readFileSync(join(repoDocs, name)).length > 0, `docs/api/${name} 不存在`)
  })

  it('构建期同步：public/docs 不入库，由 scripts/sync-docs.mjs 生成', () => {
    assert.ok(existsSync(join(app, 'scripts/sync-docs.mjs')), '缺构建期同步脚本 sync-docs.mjs')
    assert.ok(
      readFileSync(gitignore, 'utf8').includes('/packages/dashboard/app/public/docs'),
      'public/docs 必须被 gitignore —— 提交副本就会漂移（改了 docs/api 页面还显示旧内容）',
    )
    const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    assert.ok((pkg.scripts?.build ?? '').includes('sync-docs'), 'build 必须先跑 sync-docs')
  })

  it('文档清单里的 5 个 slug 与仓库文件一一对应', () => {
    const page = readCode('docs/page.tsx')
    for (const name of DOCS) {
      assert.ok(page.includes(name.replace('.md', '')), `文档页缺少 ${name}`)
    }
  })

  it('页面不经过 dangerouslySetInnerHTML 渲染文档', () => {
    assert.ok(!readCode('docs/page.tsx').includes('dangerouslySetInnerHTML'))
  })
})

describe('个人资料：密码纪律', () => {
  const source = readCode('profile/page.tsx')

  it('密码只进 state 与 body，提交后清空', () => {
    assert.ok(!source.includes('localStorage.'))
    assert.ok(!source.includes('sessionStorage.'))
    assert.ok(source.includes('setCurrentPassword("")'), '提交成功后没有清空当前密码')
    assert.ok(source.includes('setNewPassword("")'), '提交成功后没有清空新密码')
  })

  it('两个密码框都是 type="password" 且 autocomplete 正确', () => {
    assert.ok(source.includes('autoComplete="current-password"'))
    assert.ok(source.includes('autoComplete="new-password"'))
    assert.equal((source.match(/type="password"/g) ?? []).length, 2)
  })
})

describe('三态齐全（新 5 页）', () => {
  for (const page of NEW_PAGES) {
    it(`${page} 三态都有`, () => {
      const source = readCode(page)
      assert.ok(source.includes('LoadingBlock'), `${page} 缺加载态`)
      assert.ok(source.includes('ErrorBlock'), `${page} 缺错误态`)
    })
  }

  it('有列表的页面还有空态', () => {
    for (const page of ['topup/page.tsx', 'redeem/page.tsx', 'models/page.tsx']) {
      assert.ok(readCode(page).includes('EmptyBlock'), `${page} 缺空态`)
    }
  })
})

describe('每个新页面都在 sidebar-items.ts 里登记过', () => {
  const sidebar = readFileSync(join(app, 'src/navigation/sidebar/sidebar-items.ts'), 'utf8')
  const routes: Readonly<Record<(typeof NEW_PAGES)[number], string>> = {
    'topup/page.tsx': '/user/topup',
    'redeem/page.tsx': '/user/redeem',
    'models/page.tsx': '/user/models',
    'docs/page.tsx': '/user/docs',
    'profile/page.tsx': '/user/profile',
  }
  for (const [page, route] of Object.entries(routes)) {
    it(`${route} 已登记（${page}）`, () => {
      assert.ok(sidebar.includes(`"${route}"`), `${route} 没登记进侧栏，用户只能手输 URL`)
    })
  }
})
