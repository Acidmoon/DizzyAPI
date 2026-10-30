/**
 * CSV 的**唯一实现**（转义规则只此一份）。
 *
 * 为什么放 kit：`api` 与 `usage` 都依赖 kit，而 CSV 要同时被
 * 「用户侧用量导出」「管理面用量导出」使用。以前 `api/src/views/usage.ts` 里有一份
 * `csvField`，再多一个调用方就会出现第二份规则——两份转义迟早漂，而漂了不会报错，
 * 只会让某个单元格悄悄吃掉一个逗号。
 *
 * 两条规则（都是防「导出的文件在 Excel 里执行东西 / 错位」）：
 * 1. `= + - @` 开头加前导 `'`：**防公式注入**——CSV 里的 `=HYPERLINK(...)` 在 Excel 打开时
 *    是活的公式，不是文本。`\t` / `\r` 也算，它们同样能让 Excel 进公式模式。
 * 2. 含 `,` `"` 或换行的单元格用双引号包起来，内部的 `"` 双写：RFC 4180。
 *    顺序不能反——先加前导 `'` 再判断是否需要引号。
 */

/** UTF-8 BOM：Excel 靠它认出 UTF-8，没有它中文会变乱码。 */
export const CSV_BOM = '\uFEFF'

/** CSV 行分隔符：RFC 4180 用 CRLF（Excel / Windows 工具都认）。 */
export const CSV_EOL = '\r\n'

/** 单个单元格：先防公式注入，再按 RFC 4180 转义。 */
export function csvField(value: unknown): string {
  let text = value === undefined || value === null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`
  return text
}

/** 一行（单元格数组 → 逗号连接，各自转义）。 */
export function csvLine(cells: readonly unknown[]): string {
  return cells.map(csvField).join(',')
}

/**
 * 整份 CSV 文稿：BOM + 表头 + 行。
 *
 * 空结果也带表头（用户看到的是「有列名、零行」，不是空白文件）。
 */
export function csvDocument(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [csvLine(header), ...rows.map(csvLine)]
  return `${CSV_BOM}${lines.join(CSV_EOL)}`
}
