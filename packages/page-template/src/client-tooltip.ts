/*
 * 悬浮提示的客户端行为（拼进 `/assets/app.js`）。
 *
 * 职责很窄：把服务端输出的 `data-tooltip` 属性变成自绘浮层。
 * 浮层的**结构**在 `tooltip.ts`（服务端渲染一次的空壳），这里只负责写文本与算坐标。
 *
 * 定位用 Floating UI（`window.FloatingUIDOM`，MIT，vendor 在 `/assets/vendor/floating-ui/`）：
 * 手写定位要自己处理「上面放不下翻到下面」「左右不出视口」「滚动时跟随」，
 * 这套边界条件已经踩过一次（flatpickr 的日历在弹窗里被挤出边界）。
 *
 * 两条纪律：
 * - **坐标一律用 CSSOM 赋值**（`el.style.left = …`），不用 `setAttribute('style', …)`：
 *   站点 CSP 是 `style-src 'self'`，后者会被浏览器静默丢弃（实测见 AGENTS.md）。
 * - **库没加载成功就什么都不做**：这样 SVG 里的 `<title>` 兜底还留着，
 *   用户至少还有浏览器原生提示，而不是「有钩子、没反应」。
 */
export const TOOLTIP_JS = `
(function () {
  'use strict';

  var host = document.getElementById('dizzy-tooltip');
  var ui = window.FloatingUIDOM;
  // 没有浮层壳、或 vendor 库没加载成功：保持原状（<title> 兜底仍然有效）。
  if (!host || !ui || typeof ui.computePosition !== 'function') return;

  // 脚本确认接管之后，才把无 JS 兜底摘掉：
  // 否则「浏览器原生提示」与「自绘浮层」会在悬停时一起弹出来。
  // 先扫一遍现成的，之后每个元素在真正要显示时再摘（局部刷新换进来的内容也能覆盖到）。
  function dropFallback(element) {
    if (element.hasAttribute('title')) element.removeAttribute('title');
    var inner = element.querySelectorAll('title');
    for (var k = 0; k < inner.length; k += 1) inner[k].remove();
  }

  var fallbacks = document.querySelectorAll('[data-tooltip]');
  for (var i = 0; i < fallbacks.length; i += 1) dropFallback(fallbacks[i]);

  var current = null;
  var stopAutoUpdate = null;

  function hide() {
    current = null;
    if (stopAutoUpdate) {
      stopAutoUpdate();
      stopAutoUpdate = null;
    }
    host.hidden = true;
    host.textContent = '';
  }

  function place(reference) {
    return ui.computePosition(reference, host, {
      // fixed 定位的浮层按视口坐标算，不受滚动容器影响（.main 自己是滚动容器）。
      strategy: 'fixed',
      placement: 'top',
      middleware: [ui.offset(8), ui.flip(), ui.shift({ padding: 8 })],
    }).then(function (result) {
      // 算坐标是异步的：期间鼠标可能已经离开，别把旧内容又摆上来。
      if (current !== reference) return;
      host.style.left = result.x + 'px';
      host.style.top = result.y + 'px';
    });
  }

  function show(reference) {
    var text = reference.getAttribute('data-tooltip');
    if (!text || current === reference) return;
    if (stopAutoUpdate) {
      stopAutoUpdate();
      stopAutoUpdate = null;
    }
    // 局部刷新换进来的新柱子没经过上面那一轮初始化，这里补摘一次兜底。
    dropFallback(reference);
    current = reference;
    host.textContent = text;
    host.hidden = false;
    // 滚动 / 容器尺寸变化时自动重算（元素在 .main 里，页面滚动不会移动 fixed 浮层）。
    stopAutoUpdate = ui.autoUpdate(reference, host, function () {
      place(reference);
    });
  }

  function hitOf(node) {
    if (!node || !node.closest) return null;
    return node.closest('[data-tooltip]');
  }

  document.addEventListener('mouseover', function (event) {
    var hit = hitOf(event.target);
    if (hit) show(hit);
    else if (current) hide();
  });

  // 移出当前元素才关：在同一元素内部移动（例如从柱子移到柱子的子节点）不该闪烁。
  document.addEventListener('mouseout', function (event) {
    if (!current) return;
    if (hitOf(event.relatedTarget) === current) return;
    hide();
  });

  // 键盘与读屏用户：可聚焦元素获得焦点时同样显示。
  document.addEventListener('focusin', function (event) {
    var hit = hitOf(event.target);
    if (hit) show(hit);
  });
  document.addEventListener('focusout', function () {
    if (current) hide();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && current) hide();
  });

  // 点任何东西都收起：提示是悬停辅助，不该在点完之后还挂着。
  document.addEventListener('click', function () {
    if (current) hide();
  });
})();
`
