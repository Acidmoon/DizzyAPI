/**
 * 测试里把「app 目录下的纯 TS 模块」拿进 node 测试的小工具。
 *
 * 为什么需要它：`packages/dashboard/app/package.json` 是上游 Next 工程自带的，
 * **没有 `"type": "module"`**，于是 tsx 会把该目录下的 `.ts` 编译成 **CJS**；
 * `import { roleLabel } from '…admin-logic.ts'` 这种命名导入在运行期拿不到
 * （Node 只能看到 `default` = `module.exports`，报 "does not provide an export named …"）。
 *
 * 用法：
 * ```ts
 * import * as logicModule from '../../app/src/app/(main)/dashboard/_components/admin-logic.ts'
 * const logic = unwrap<typeof logicModule>(logicModule)
 * logic.roleLabel('admin')
 * ```
 *
 * 类型上仍是模块的 ESM 形状（编译期有完整类型），运行期统一走 `default`。
 * **不要**为了这个给 `app/src/` 加 `type: module`：那会改变 Next 工程自己的模块解析，
 * 不是测试该动的东西。
 */
export function unwrap<T>(namespace: unknown): T {
  const record = namespace as { default?: unknown };
  return (record.default ?? namespace) as T;
}
