// 把 Next 静态导出的 `out/` 拷成 `packages/dashboard/dist/`。
//
// 为什么需要这一步：`output: "export"` 的产物目录固定在 `<app>/out`，Next 没有
// 「导出到任意目录」的配置项；而插件（`packages/dashboard/src/`）约定读
// `packages/dashboard/dist/`，两个路径之间必须有一次搬运。
//
// 用法：`npm run build`（`next build` 之后自动执行本脚本）。
import { cp, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(appDir, "out");
const target = resolve(appDir, "..", "dist");

async function count(dir) {
  const { readdir } = await import("node:fs/promises");
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await count(full);
      files += nested.files;
      bytes += nested.bytes;
    } else {
      files += 1;
      bytes += (await stat(full)).size;
    }
  }
  return { files, bytes };
}

try {
  await stat(source);
} catch {
  console.error(`[export-dist] 没有找到导出产物：${source}（先跑 next build）`);
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });

const { files, bytes } = await count(target);
console.log(`[export-dist] ${target} : ${files} 个文件 / ${(bytes / 1024 / 1024).toFixed(2)} MiB`);
