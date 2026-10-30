/**
 * 测试里把「app 目录下的纯 TS 模块」拿进 node 测试的小工具。
 *
 * 为什么需要它：`packages/dashboard/app/package.json` 是上游的，没有 `"type": "module"`，
 * 于是 tsx 会把该目录下的 `.ts` 编译成 **CJS**；`import { formatYuan } from '…format.ts'`
 * 这种命名导入在运行期拿不到（Node 只能看到 `default` = `module.exports`）。
 *
 * 用法：
 * ```ts
 * import * as formatModule from '../app/src/lib/format.ts'
 * const format = unwrap<typeof formatModule>(formatModule)
 * format.formatYuan('1000000')
 * ```
 * 类型上仍是模块的 ESM 形状（编译期有类型），运行期统一走 `default`。
 */
export function unwrap<T>(namespace: unknown): T {
  const record = namespace as { default?: unknown }
  return (record.default ?? namespace) as T
}
