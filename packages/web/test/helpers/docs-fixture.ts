/**
 * API 文档测试的共用夹具。
 *
 * 拆这个文件的原因：`pages-docs.test.ts` 超了 §5.6 的测试文件上限（500 行），
 * 按主题拆成三份时共用的一部分放这里（夹具 + 小节解析工具）。
 *
 * 这里只放**只读**的夹具：不碰服务、不起进程。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { apiDocsPage } from '../../src/pages/api_docs.ts'
import { apiDocsMarkdown, DOC_FILES, DOCS_DIR } from '../../src/content/api_docs.ts'
import { readCodeFacts } from '../../src/content/api_facts.ts'
import type { PageContext } from '../../src/layout.ts'
import type { SessionView, WebRuntime } from '../../src/runtime.ts'

/** 仓库根目录：本文件在 `packages/web/test/helpers/` 下。 */
export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** 读仓库里的源码文件；读不到直接判失败（不是返回空串，那会让断言变得没有意义）。 */
export function readSource(relative: string): string {
  try {
    return readFileSync(`${ROOT}${relative}`, 'utf8')
  } catch (error) {
    assert.fail(`读不到源码 ${relative}（${error instanceof Error ? error.message : String(error)}）`)
  }
}

/** 从代码派生出来的事实（自证对象；与页面渲染用的是同一个函数）。 */
export const FACTS = readCodeFacts()

/** 原样读 `docs/api/*.md`（占位符还没展开）。 */
export const NARRATIVE = DOC_FILES.map((name) => readFileSync(new URL(name, DOCS_DIR), 'utf8')).join('\n')

/** 整页 markdown（占位符已展开）。 */
export const FULL_MARKDOWN = apiDocsMarkdown()

/** markdown 小节。 */
export interface Section {
  readonly heading: string
  readonly body: string
}

/** 按 `##` / `###` 切小节。 */
export function splitSections(text: string): Section[] {
  const sections: Section[] = []
  let heading: string | undefined
  let body: string[] = []
  for (const line of text.split('\n')) {
    if (/^#{2,3} /.test(line)) {
      if (heading !== undefined) sections.push({ heading, body: body.join('\n') })
      heading = line.replace(/^#+\s*/, '').trim()
      body = []
      continue
    }
    if (heading !== undefined) body.push(line)
  }
  if (heading !== undefined) sections.push({ heading, body: body.join('\n') })
  return sections
}

/** 小节里的表格数据行（去掉表头与 `| --- |` 分隔行）。 */
export function tableRows(body: string): string[][] {
  const rows: string[][] = []
  for (const line of body.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue
    rows.push(cells)
  }
  // 第一行是表头，不是数据。
  return rows.slice(1)
}

/** 去掉 markdown 行内代码的反引号。 */
export function plain(value: string): string {
  return value.replaceAll('`', '').trim()
}

/** 围栏代码块（含语言标记）。 */
export function fencedBlocks(text: string): { lang: string; body: string }[] {
  const blocks: { lang: string; body: string }[] = []
  const pattern = /^```(\w*)\r?\n([\s\S]*?)^```/gm
  for (const match of text.matchAll(pattern)) blocks.push({ lang: match[1], body: match[2] })
  return blocks
}

const SESSION: SessionView = {
  sessionId: 'session-1',
  userId: 7,
  user: {
    id: 7,
    name: 'alice',
    status: 'enabled',
    role: 'user',
    balance: 2_500_000n,
    balanceEnabled: true,
    concurrencyLimit: null,
    avatar: null,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
  },
  expiresAt: '2099-10-19T00:00:00.000Z',
}

const EMPTY_SERVICES: WebRuntime = {
  user: undefined,
  auth: undefined,
  apiKey: undefined,
  usage: undefined,
  pricing: undefined,
  modelhub: undefined,
  settings: undefined,
  catalog: undefined,
  accountAdmin: undefined,
  redeem: undefined,
  billing: undefined,
  topup: undefined,
  fontSmiley: undefined,
  audit: undefined,
  observability: undefined,
  contentAudit: undefined,
  gateFeed: undefined,
}

/** 渲染文档页的 HTML（不鉴权，页面本身要登录由 HTTP 层管）。 */
export async function renderDocs(query = ''): Promise<string> {
  const ctx = new Context()
  await ctx.plugin(PageTemplateService)
  const template = ctx.get('pageTemplate') as PageTemplateService
  const pageContext: PageContext = {
    path: '/console/api-docs',
    title: 'API 文档',
    query: new URLSearchParams(query),
    user: SESSION,
    t: template,
    services: EMPTY_SERVICES,
    notice: null,
  themeCss: '',
    takeSecret: () => undefined,
  }
  return apiDocsPage.render(pageContext)
}
