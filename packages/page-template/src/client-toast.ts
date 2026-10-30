/*
 * 轻提示的客户端行为（拼进 `/assets/app.js`）。
 *
 * 两种用法：
 * 1. **声明式**：元素带 `data-toast="文案"`，点击后弹一条（不刷新页面的动作）；
 * 2. **命令式**：脚本里调 `window.dizzyToast('文案')` / `('文案', 'err')`。
 *
 * 宿主 `<div class="toasts">` 由服务端每页输出一次（`renderDocument`），
 * 所以这里不需要建容器；没有宿主就什么都不做（老页面 / 局部片段里安全）。
 *
 * 为什么上限 4 条：连点十次复制会叠出一列挡住右下角，
 * 而提示本身就是「看一眼就走」的东西，超出的直接从最旧的丢。
 */
export const TOAST_JS = `
(function () {
  'use strict';

  var host = document.getElementById('dizzy-toasts');
  if (!host) return;

  var MAX = 4;
  var ERR_TTL = 5200;
  var OK_TTL = 2600;

  function toast(message, tone) {
    if (!message) return;
    var node = document.createElement('div');
    node.className = tone === 'err' ? 'toast toast--err' : 'toast';
    // textContent 而不是 innerHTML：文案里可能有模型名 / 文件名，绝不能当 HTML 解析。
    node.textContent = message;
    host.appendChild(node);
    while (host.children.length > MAX) host.removeChild(host.firstChild);
    window.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, tone === 'err' ? ERR_TTL : OK_TTL);
  }

  // 命令式入口（复制按钮等脚本用）
  window.dizzyToast = toast;

  // 声明式：任何带 data-toast 的元素点一下就弹
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var trigger = target.closest('[data-toast]');
    if (!trigger) return;
    var tone = trigger.getAttribute('data-toast-tone');
    toast(trigger.getAttribute('data-toast'), tone === 'err' ? 'err' : 'ok');
  });
})();
`
