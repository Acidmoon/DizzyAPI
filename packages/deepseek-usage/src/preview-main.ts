/**
 * `pnpm preview:deepseek-usage` 的入口。**只用于开发预览**。
 *
 * 它不经过 cordis 插件树：用一份内置的演示数据把页面渲染出来，
 * 方便在没有真实用量数据时核对视觉。
 */
import { createServer } from 'node:http'
import { collectBoard, type UsageRow } from './collect.ts'
import { renderPage } from './render.ts'
import { PAGE_CSS, CLIENT_JS } from './client.ts'

const PORT = process.env.PORT === undefined ? 7794 : Number(process.env.PORT)

/** 造 30 天的演示数据：两个模型、三种协议、两个 key。 */
function demoRows(): UsageRow[] {
  const rows: UsageRow[] = []
  const models = [
    { name: 'deepseek-flash', weight: 92 },
    { name: 'deepseek-v4-pro', weight: 8 },
  ]
  const protocols = ['openai-chat', 'openai-responses', 'anthropic']
  const keys = [
    { id: 'key-1', name: '默认密钥' },
    { id: 'key-2', name: '线上业务' },
  ]

  for (let day = 29; day >= 0; day -= 1) {
    const date = new Date(Date.UTC(2026, 9, 22) - day * 86_400_000)
    const iso = date.toISOString()
    // 周末量低一些；几个「高峰日」拉高柱高。
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6
    const peak = day === 3 || day === 17 ? 7 : 1
    const calls = Math.round((weekend ? 42 : 90) * peak * (0.6 + ((day * 37) % 11) / 14))

    for (let index = 0; index < calls; index += 1) {
      const model = models[index % models.length === 0 ? 0 : index % 11 === 0 ? 1 : 0]
      const protocol = protocols[index % protocols.length]
      const key = keys[index % keys.length]
      const input = 200 + ((index * 131) % 1800)
      const output = 40 + ((index * 57) % 420)
      const cacheRead = index % 3 === 0 ? 100 + ((index * 17) % 900) : 0
      rows.push({
        startedAt: `${iso.slice(0, 10)}T${String(6 + (index % 16)).padStart(2, '0')}:00:00.000Z`,
        model: model.name,
        protocol,
        apiKeyId: key.id,
        apiKeyName: key.name,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: 0,
        totalTokens: input + output + cacheRead,
        costMicros: String(Math.round((input * 1200 + output * 3600) / 10)),
      })
    }
  }
  return rows
}

const rows = demoRows()
const board = collectBoard({
  usage: {
    exportRows: () => rows,
    summary: () => ({
      totals: {
        costMicros: rows.reduce((total, row) => total + BigInt(row.costMicros), 0n).toString(),
      },
    }),
  },
  range: '30d',
  apiKeyId: null,
  groupBy: 'callKind',
  userId: 7,
  balanceMicros: '6440000',
  userName: 'Acidmoon',
  now: new Date('2026-10-22T08:00:00.000Z'),
})

const html = renderPage({
  board,
  basePath: '/console/usage',
  consoleBaseUrl: 'http://127.0.0.1:7791',
  userName: 'Acidmoon',
  avatarUrl: null,
})

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if (path === '/console/usage/assets/usage.css') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
    res.end(PAGE_CSS)
    return
  }
  if (path === '/console/usage/assets/usage.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
    res.end(CLIENT_JS)
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`用量信息页预览（仅本机，演示数据）：http://127.0.0.1:${PORT}/console/usage`)
})
