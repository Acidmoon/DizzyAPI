/**
 * 用户侧页面的**源码级护栏**。用真浏览器断言太慢、也不适合进 `pnpm test`，
 * 但下面这些是「原则性问题」，用文本断言就足够挡住回归：
 *
 * 1. 用户侧页面**不许**碰管理面接口（`/api/admin/*`）——越权回归的第一道闸；
 * 2. **价格表只读**（owner 明确要求）：不许出现任何写入口（新增 / 编辑 / 删除按钮、表单、PUT/DELETE）；
 * 3. 明文密钥不进 URL / storage / console（一次性 secret 纪律）；
 * 4. 金额格式化只有一个源（`@/lib/format`），页面里不许自己 `toFixed` / 除法 / `Intl.NumberFormat`；
 * 5. 每页都要有加载 / 空 / 错误三态（owner 的验收口径）；
 * 6. 用户侧外壳不许复制侧栏标记（侧栏清单只有一个源）。
 *
 * 注意：所有内容断言跑在 **去掉注释后的源码** 上（`readCode`）。否则「这里禁止 localStorage」
 * 这种说明性注释会把护栏自己绊倒——护栏要约束的是代码，不是文案。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '../app/src')
const userRoot = join(app, 'app/(main)/user')

const PAGE_FILES = ['page.tsx', 'usage/page.tsx', 'keys/page.tsx', 'pricing/page.tsx'] as const

const COMPONENT_FILES = [
  '_components/page-states.tsx',
  '_components/usage-chart.tsx',
  '_components/usage-breakdown.tsx',
  '_components/usage-detail-dialog.tsx',
  '_components/usage-metrics.tsx',
  '_components/usage-table.tsx',
  'usage/_components/usage-filters.tsx',
  'keys/_components/key-name-dialog.tsx',
  'keys/_components/key-secret-dialog.tsx',
] as const

const LIB_FILES = ['_lib/api.ts', '_lib/paths.ts', '_lib/seven-points.ts', '_lib/types.ts'] as const

const ALL_FILES = [...PAGE_FILES, ...COMPONENT_FILES, ...LIB_FILES]

function read(relative: string): string {
  return readFileSync(join(userRoot, relative), 'utf8')
}

/** 去掉块注释与行注释（保留 `http://` 这类冒号后的双斜杠）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function readCode(relative: string): string {
  return stripComments(read(relative))
}

describe('越权：用户侧不碰管理面接口', () => {
  for (const file of ALL_FILES) {
    it(`${file} 不出现 /api/admin`, () => {
      assert.ok(!readCode(file).includes('/api/admin'), `${file} 引用了管理面接口`)
    })
  }

  it('数据层只用 session / usage / keys / pricing 四个域', () => {
    const api = readCode('_lib/api.ts')
    const domains = new Set([...api.matchAll(/['"`]\/api\/([a-z-]+)/g)].map((match) => match[1]))
    assert.ok(domains.size > 0, '没匹配到任何接口域，护栏本身失效了')
    for (const domain of domains) {
      assert.ok(['session', 'usage', 'keys', 'pricing'].includes(domain ?? ''), `意外的接口域：${domain}`)
    }
  })
})

describe('价格表只读（owner 明确要求）', () => {
  const pricing = readCode('pricing/page.tsx')

  it('页面里没有任何写入口', () => {
    for (const forbidden of ['新增', '编辑', '删除', '保存', '提交', '<form', 'method="PUT"', 'method="DELETE"']) {
      assert.ok(!pricing.includes(forbidden), `价格表出现了写入口：${forbidden}`)
    }
  })

  it('不引入任何写接口', () => {
    for (const forbidden of ['createKey', 'updateKey', 'removeKey', 'rotateKey', 'apiRequest', 'toast']) {
      assert.ok(!pricing.includes(forbidden), `价格表引用了写接口：${forbidden}`)
    }
  })

  it('明确标出「只读」，且只 import 了读接口', () => {
    assert.ok(pricing.includes('只读'))
    assert.ok(pricing.includes('fetchPricing'))
  })
})

describe('一次性 secret 纪律', () => {
  const secretDialog = readCode('keys/_components/key-secret-dialog.tsx')
  const keysPage = readCode('keys/page.tsx')

  it('明文只进 React state，不进 storage / console / cookie / URL', () => {
    for (const source of [secretDialog, keysPage]) {
      for (const forbidden of [
        'localStorage.',
        'sessionStorage.',
        'console.log',
        'console.info',
        'document.cookie',
        'history.pushState',
      ]) {
        assert.ok(!source.includes(forbidden), `出现 ${forbidden}`)
      }
    }
  })

  it('关掉弹窗时由父组件清空明文（setSecret(null)）', () => {
    assert.ok(keysPage.includes('setSecret(null)'), '父组件没有在关闭时清空明文')
  })

  it('删除 / 轮换走自研二次确认（AlertDialog），不用 window.confirm', () => {
    assert.ok(keysPage.includes('AlertDialog'))
    assert.ok(!keysPage.includes('window.confirm'))
  })
})

describe('金额格式化只有一个源', () => {
  for (const file of [...PAGE_FILES, ...COMPONENT_FILES, ...LIB_FILES]) {
    it(`${file} 不自己算钱`, () => {
      const source = readCode(file)
      for (const forbidden of ['toFixed(', 'Intl.NumberFormat', '/ 1_000_000', '/ 1000000']) {
        assert.ok(!source.includes(forbidden), `${file} 自己算金额：${forbidden}`)
      }
    })
  }

  it('凡是用 formatXxx 的文件都从 @/lib/format 引入', () => {
    const formatters = /format(?:Yuan|CentsAsYuan|MicrosAsYuan|Tokens|DateTime|Date|DurationMs|TtftMs|Percent|MonthDayLabel)\(/
    for (const file of [...PAGE_FILES, ...COMPONENT_FILES]) {
      if (!formatters.test(readCode(file))) continue
      assert.ok(readCode(file).includes('@/lib/format'), `${file} 用了格式化函数却没从唯一源引入`)
    }
  })

  it('页面不直接读 costMicros 做换算（一律经格式化函数）', () => {
    for (const file of PAGE_FILES) {
      const source = readCode(file)
      assert.ok(!/Number\([^)]*costMicros/.test(source), `${file} 把金额转成了 number`)
      assert.ok(!/Number\([^)]*balanceCents/.test(source), `${file} 把余额转成了 number`)
    }
  })
})

describe('三态齐全（加载 / 空 / 错误）', () => {
  for (const file of PAGE_FILES) {
    it(`${file} 三态都有`, () => {
      const source = readCode(file)
      assert.ok(source.includes('LoadingBlock'), `${file} 缺加载态`)
      assert.ok(source.includes('EmptyBlock'), `${file} 缺空态`)
      assert.ok(source.includes('ErrorBlock'), `${file} 缺错误态`)
    })
  }
})

describe('壳层不复制', () => {
  it('user/layout.tsx 只是转接，不含侧栏标记', () => {
    const layout = readCode('layout.tsx')
    for (const forbidden of ['SidebarProvider', '<aside', 'sidebarItems', 'nav-item', 'SidebarInset']) {
      assert.ok(!layout.includes(forbidden), `layout 里复制了外壳：${forbidden}`)
    }
    assert.ok(layout.includes('dashboard/layout'), 'layout 应转接骨架线的外壳')
  })
})

describe('路由与侧栏挂载清单', () => {
  it('四个页面文件都在（/user、/user/usage、/user/keys、/user/pricing）', () => {
    for (const file of PAGE_FILES) assert.ok(read(file).length > 0, `${file} 不存在`)
  })

  it('每个页面都是客户端组件（静态导出下没有服务端会话可取）', () => {
    for (const file of PAGE_FILES) {
      assert.ok(readCode(file).trimStart().startsWith('"use client";'), `${file} 缺 "use client"`)
    }
  })

  it('页面里不出现 cookies() / headers() 这类服务端 API', () => {
    for (const file of PAGE_FILES) {
      const source = readCode(file)
      for (const forbidden of ['next/headers', 'cookies(', 'headers(']) {
        assert.ok(!source.includes(forbidden), `${file} 用了服务端 API：${forbidden}`)
      }
    }
  })
})
