/**
 * 用量导出的浏览器落地：`GET /api/usage/export` 回 JSON `{ filename, content }`，
 * 前端自己拼 Blob 触发下载（阶段 0 的口径：不改 api 契约、不新开服务端路由）。
 *
 * 请求本身走 `@/lib/api` 的 `usage.exportUsage`；这里只做「把正文变成文件」这一段 DOM 动作。
 */

import { api, usage } from "@/lib/api";

/** 导出只关心这三个筛选（分页参数不参与导出：导出是全量）。 */
export interface UsageExportFilters {
  readonly range?: "7d" | "30d" | "90d";
  readonly apiKeyId?: string;
  readonly model?: string;
}

/** 导出并下载；CSV 正文由 `usage` 插件出，前端只负责落地成文件。 */
export async function downloadUsageCsv(filters: UsageExportFilters): Promise<void> {
  const result = await usage.exportUsage(api, filters);
  const blob = new Blob([result.content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // 立刻撤销会让部分浏览器取消下载，等一拍再回收。
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
