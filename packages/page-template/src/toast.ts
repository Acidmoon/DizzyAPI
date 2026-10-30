/**
 * 轻提示（Toast）：一次性的短消息，浮在页面右下角逐条消失。
 *
 * 与 `renderNotice()` 的区别（两个都要有，别混）：
 * - `notice` 是**页面级**的状态条，随服务端渲染出现，属于「这一页现在是成功 / 失败状态」；
 * - `toast` 是**动作级**的反馈，由客户端在动作完成后弹一条（复制成功、导出完成），
 *   不改变页面状态、不占布局、不需要刷新。
 *
 * 为什么需要它：站点是「表单 POST + 303」的服务端渲染站，绝大多数动作**整页刷新**，
 * 页面级提示条足够。但有几类动作根本不刷新页面——复制到剪贴板、下载文件——
 * 做完没有任何反馈，用户只能猜。这类反馈只能是客户端的，就是 toast。
 *
 * 服务端只输出一个空宿主（`renderToastHost()`），不预渲染任何消息：
 * 服务端渲染的短消息属于 notice，不走这里（否则刷新一次就重复弹）。
 */

/** toast 宿主的元素 id（客户端脚本按它找容器）。 */
export const TOAST_HOST_ID = 'dizzy-toasts'

/**
 * toast 宿主：固定在视口右下角，`aria-live="polite"` 让读屏软件把新消息念出来。
 *
 * 由 `renderDocument` 每页输出一次；没有 JS 时它永远是空的（不占空间、不影响布局）。
 */
export function renderToastHost(): string {
  return `<div class="toasts" id="${TOAST_HOST_ID}" role="status" aria-live="polite"></div>`
}

/** 轻提示的 CSS（由 `web` 拼进 `/assets/app.css`）。 */
export const TOAST_CSS = `
/* ── 轻提示（Toast）──────────────────────────────────────────────
 * fixed 定位、不吃鼠标事件：它只是反馈，不该挡住下面的按钮。
 * 用 bottom + right 而不是居中：中上位置在这个站点会盖住页面标题与筛选栏。 */
.toasts {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 70;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
  pointer-events: none;
}
.toast {
  max-width: 360px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--border-l3);
  background: var(--bg-layer-3);
  color: var(--label-primary);
  font-size: var(--fs-label);
  line-height: var(--lh-label);
  box-shadow: 0 10px 32px rgba(0, 0, 0, .44);
  animation: toast-in .18s ease-out;
}
/* 失败提示要能一眼区分（复制失败、导出失败）。 */
.toast.toast--err {
  border-color: rgba(242, 90, 90, .48);
  background: #3A2A2C;
  color: #FFD8D8;
}
@keyframes toast-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
/* 用户要求「减少动态效果」时不做位移动画（只留显隐）。 */
@media (prefers-reduced-motion: reduce) {
  .toast { animation: none; }
}
`
