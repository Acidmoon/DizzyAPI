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

  // 反馈走**轻提示**（page-template 的 toast）：复制是「不刷新页面」的动作，
  // 页面级 notice 用不上；原先改按钮文字的做法在长 key / 文档整页复制时
  // 会把按钮撑变形，而且 1.5 秒后悄悄还原，用户经常没看见。
  function done(tone) {
    if (window.dizzyToast) {
      window.dizzyToast(tone === 'err' ? '复制失败：请手动选择并复制' : '已复制到剪贴板', tone);
      return;
    }
    // 老页面（没有 toast 宿主）退回改按钮文字，功能不丢
    var original = button.textContent;
    button.textContent = tone === 'err' ? '复制失败' : '已复制';
    setTimeout(function () { button.textContent = original; }, 1500);
  }

  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    done('err');
    return;
  }
  navigator.clipboard.writeText(value).then(function () {
    done('ok');
  }, function () {
    done('err');
  });
});
`
