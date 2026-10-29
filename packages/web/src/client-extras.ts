/**
 * `/assets/app.js` 里除 `CLIENT_JS` 之外的那部分：**复制按钮**。
 *
 * 为什么单独一个文件：它既不属于 `page-template` 的通用客户端脚本（那份是控件升级与
 * 浮层开合的通用行为），也不属于 `service.ts` 的编排职责；塞在 `service.ts` 里会把
 * 那个文件顶过 400 行软上限（owner「不要一个文件写那么大」）。
 *
 * 历史：这里原先还有 `window.confirm`（删除前确认）。原生 confirm 是浏览器画的模态框，
 * 样式完全不可控、还阻塞整页，现在由 `page-template` 的自绘确认框承担
 * （`packages/page-template/src/confirm.ts`，行为在 `CLIENT_JS`）。
 */
export const COPY_JS = `
document.addEventListener('click', function (event) {
  var target = event.target;
  if (!target || !target.closest) return;
  var button = target.closest('[data-copy]');
  if (!button) return;
  var value = button.getAttribute('data-copy');
  if (!value) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(function () {
      var original = button.textContent;
      button.textContent = '已复制';
      setTimeout(function () { button.textContent = original; }, 1500);
    });
  }
});
`
