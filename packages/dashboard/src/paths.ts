/**
 * 插件用到的路径。
 *
 * 产物目录默认跟随包位置（`packages/dashboard/dist`），不靠 `process.cwd()`：
 * 生产进程的工作目录是 `/opt/dizzyapi`，而产物在包目录里，按 cwd 拼会拼错。
 */
import { fileURLToPath } from 'node:url'

/** `packages/dashboard/dist` 的绝对路径。 */
export function defaultDistDir(): string {
  return fileURLToPath(new URL('../dist', import.meta.url))
}
