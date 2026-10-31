// 把仓库里的 `docs/api/*.md` 同步到 `app/public/docs/`（供文档页 `fetch('/docs/xx.md')` 取用）。
//
// 为什么要有这一步：文档的**唯一源**是仓库根 `docs/api/`（人写的那份，旧 SSR 页也读它）。
// 直接把它复制一份进 `public/docs/` 并提交，就会出现两份同名文件、改一处另一处不动 ——
// 这类「复制一份」的漂移在本项目已经踩过（skill 被 junction 入库两份、page-template 是
// deepseek-usage 的整份重复副本）。所以 `public/docs/` **不进版本库**，构建前从源头同步。
//
// 用法：`npm run build` 的第一步；`npm run sync:docs` 也可单独跑。
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(appDir, "..", "..", "..", "docs", "api");
const targetDir = join(appDir, "public", "docs");

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });

const files = (await readdir(sourceDir)).filter((name) => name.endsWith(".md")).sort();
if (files.length === 0) {
  console.error(`[sync-docs] ${sourceDir} 里没有 .md —— 文档源路径可能变了`);
  process.exit(1);
}

for (const name of files) {
  await copyFile(join(sourceDir, name), join(targetDir, name));
}

console.log(`[sync-docs] ${files.length} 个文件：docs/api/ → app/public/docs/`);
