// 把 Next 静态导出的 `out/` 拷成 `packages/dashboard/dist/`。
//
// 为什么需要这一步：`output: "export"` 的产物目录固定在 `<app>/out`，Next 没有
// 「导出到任意目录」的配置项；而插件（`packages/dashboard/src/`）约定读
// `packages/dashboard/dist/`，两个路径之间必须有一次搬运。
//
// 同时写一份 `dist/build-info.json`（构建戳），原因见文件末尾的说明。
//
// 用法：`npm run build`（`next build` 之后自动执行本脚本）。
//
// 路径可用参数覆盖（测试用，部署时不要传）：
//   node scripts/export-dist.mjs --out=<导出的 out 目录> --dist=<目标 dist 目录>
//                                  --repo=<取 git 信息用的仓库目录>
import { execFileSync } from "node:child_process";
import { cp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 从命令行参数里取 `--key=value`，没给就返回 undefined。 */
function argOf(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

const source = resolve(argOf("out") ?? join(appDir, "out"));
const target = resolve(argOf("dist") ?? resolve(appDir, "..", "dist"));
/** 取 git 信息的仓库目录；默认是脚本所在的仓库。 */
const repoDir = resolve(argOf("repo") ?? appDir);

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

/**
 * 取 git 信息：`commit` 是当前 HEAD 的短 hash，`dirty` 表示工作区有没有未提交改动。
 *
 * 取不到（比如目录不在 git 仓库里、或没装 git）就返回 `commit: "unknown"`、
 * `dirty: null`，**不让构建因此失败** —— 构建产物本身不该依赖 git 可用。
 */
function gitInfo() {
  const run = (args) => {
    try {
      return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return undefined;
    }
  };
  const commit = run(["rev-parse", "--short", "HEAD"]);
  if (commit === undefined || commit === "") return { commit: "unknown", dirty: null };
  const status = run(["status", "--porcelain"]);
  return { commit, dirty: status === undefined ? null : status !== "" };
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

// 构建戳。
//
// 为什么必须有它：`dist/` 是 gitignored 的构建产物，插件读的是**磁盘上当前那一
// 份**，它不认 git commit。所以「代码已经合进 main、但服务器上的 dist/ 还是上一
// 版」这个状态在服务器上是**完全静默**的 —— 页面照常 200，只是内容是旧的。
//
// 有了 build-info.json，部署验收只要 `cat`（或 `curl`）它一眼就知道发上去的到底
// 是哪个 commit；`dirty: true` 表示本地有未提交改动，这种产物**不许上服务器**
// （因为「发的是哪个 commit」这个问题会没有答案）。
//
// `files` / `bytes` 统计的是**导出的内容本身**，不含 build-info.json 自己。
const git = gitInfo();
const info = {
  commit: git.commit,
  dirty: git.dirty,
  builtAt: new Date().toISOString(),
  files,
  bytes,
};
await writeFile(join(target, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");

console.log(`[export-dist] ${target} : ${files} 个文件 / ${(bytes / 1024 / 1024).toFixed(2)} MiB`);
console.log(`[export-dist] build-info.json : commit=${info.commit} dirty=${info.dirty} builtAt=${info.builtAt}`);
if (info.dirty === true) {
  console.warn("[export-dist] 警告：工作区有未提交改动，这份产物不许上服务器。");
}
