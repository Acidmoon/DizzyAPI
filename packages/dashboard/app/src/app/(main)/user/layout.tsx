/**
 * 用户侧路由段（`/user/**`）复用同一套外壳（侧栏 + 页头 + 主题）。
 *
 * 为什么不自己再写一份侧栏：侧栏清单的唯一源是 `src/navigation/sidebar/sidebar-items.ts`，
 * 外壳的唯一源是骨架线的 layout（`界面` 的批次）。这里只做一行转接 ——
 * **不复制任何外壳标记**，否则改一次壳层要改两处。
 *
 * 待办（合并时看）：骨架线如果把外壳从 `dashboard/layout.tsx` 提到 `(main)/layout.tsx`，
 * `/user` 会被自动覆盖，那时删掉本文件即可（`(main)` 段布局对所有同级路由生效）。
 */
export { default } from "@/app/(main)/dashboard/layout";
