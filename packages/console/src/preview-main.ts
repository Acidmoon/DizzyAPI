/**
 * `pnpm preview:console` 的入口。**只用于开发预览**，不会由 cordis 插件启动。
 */
import { startPreviewServer } from './preview.ts'

const port = process.env.PORT === undefined ? 7790 : Number(process.env.PORT)
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT 非法：${process.env.PORT ?? ''}`)
}

const server = await startPreviewServer({ port })
console.log(`前端开发预览（仅本机，mock 数据）：${server.url}/console`)
console.log('这不是产品运行时；生产由 Go httpapi / 反向代理发静态字节。按 Ctrl-C 停止。')

let closing = false
const shutdown = async (): Promise<void> => {
  if (closing) return
  closing = true
  await server.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
