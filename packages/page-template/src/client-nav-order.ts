/*
 * 侧栏拖动排序（拼进 `/assets/app.js`）。
 *
 * 为什么用 **Pointer Events** 而不是 HTML5 Drag & Drop：原生 `draggable` 在
 * iOS Safari 上根本不触发（触屏没有 dragstart），而 owner 要的就是「按住拖动」。
 * Pointer Events 在鼠标 / 触屏 / 手写笔上行为一致，只有一条实现。
 *
 * 三条纪律：
 * 1. **阈值 5px**：按下后移动没超过 5px 就不算拖动，点击照常导航——否则「想点时
 *    手抖 1px」就变成拖拽，链接再也点不开。
 * 2. **拖动中只改 DOM，松手才落库**：每动一次都发请求会把服务端打成筛子，
 *    而且中途失败还会留下半截顺序。
 * 3. **落库失败回滚成服务端顺序**：页面打开时那份顺序（`snapshot`）就是服务端顺序，
 *    失败就照它复原 + 弹错误提示，绝不「只改 DOM 假装成功」。
 *
 * 无 JS：侧栏就是服务端按 `navOrder`（或站默认）渲染的一份静态列表，拖动不可用但
 * 一切照常。控件本身都是 `<a href>`，不依赖脚本。
 *
 * 服务端契约（`shell.ts` 输出）：导航容器带 `data-nav-area` 与 `data-nav-order-url`，
 * 每个可拖项带 `data-nav-path`。这里**不认识任何具体路由**，只做排序与提交。
 */
export const NAV_ORDER_JS = `
(function () {
  'use strict';

  var nav = document.querySelector('[data-nav-order-url]');
  if (!nav || !window.PointerEvent || !window.fetch) return;

  var orderUrl = nav.getAttribute('data-nav-order-url');
  var area = nav.getAttribute('data-nav-area') || '';
  var THRESHOLD = 5;
  var drag = null;          // { item, id, x, y, moved, snapshot, anchor }
  var swallowClick = false; // 拖动结束后吞掉那一次 click（否则会顺带导航）

  function items() {
    var all = nav.querySelectorAll('[data-nav-path]');
    var out = [];
    for (var i = 0; i < all.length; i += 1) {
      if (all[i].parentNode === nav) out.push(all[i]);
    }
    return out;
  }

  function paths() {
    var list = items();
    var out = [];
    for (var i = 0; i < list.length; i += 1) out.push(list[i].getAttribute('data-nav-path'));
    return out;
  }

  // 拖动时按指针位置把元素插到「中线已经越过」的那一项之前。
  function moveTo(item, y) {
    var list = items();
    for (var i = 0; i < list.length; i += 1) {
      var el = list[i];
      if (el === item) continue;
      var box = el.getBoundingClientRect();
      if (y < box.top + box.height / 2) {
        if (el.previousSibling !== item) nav.insertBefore(item, el);
        return;
      }
    }
    var last = list[list.length - 1];
    if (last && last !== item && last.nextSibling !== item) nav.insertBefore(item, last.nextSibling);
  }

  function restore(snapshot, anchor) {
    for (var i = 0; i < snapshot.length; i += 1) nav.insertBefore(snapshot[i], anchor);
  }

  function persist() {
    var body = new URLSearchParams();
    body.set('area', area);
    body.set('navOrder', paths().join(','));
    return window.fetch(orderUrl, {
      method: 'POST',
      credentials: 'same-origin',
      // 同源 POST：浏览器会带 Origin，服务端 assertSameOrigin 靠它拦跨站。
      // X-Requested-With 让服务端知道「这次别 303」，回 204 / 4xx 就好。
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'dizzyapi',
      },
      body: body.toString(),
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
    });
  }

  function fail(snapshot, anchor) {
    restore(snapshot, anchor);
    if (typeof window.dizzyToast === 'function') {
      window.dizzyToast('侧栏顺序没保存成功，已恢复', 'err');
    }
  }

  nav.addEventListener('pointerdown', function (event) {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    var target = event.target;
    var item = target && target.closest ? target.closest('[data-nav-path]') : null;
    if (!item || item.parentNode !== nav) return;
    var list = items();
    if (list.length < 2) return;
    drag = {
      item: item,
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      snapshot: list.slice(),
      // 复原时的插入锚点：最后一项的下一个兄弟（可能是 .side-sep / 文本节点）。
      // 拖动只在这批项之间挪，所以「全部插到锚点之前」就恢复了原顺序。
      anchor: list[list.length - 1].nextSibling,
    };
  });

  nav.addEventListener('pointermove', function (event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.moved) {
      var dx = event.clientX - drag.x;
      var dy = event.clientY - drag.y;
      if (dx * dx + dy * dy < THRESHOLD * THRESHOLD) return;
      drag.moved = true;
      drag.item.classList.add('side-link--dragging');
      // 捕获指针：指针移出侧栏也继续收到事件，松手才不会漏。
      if (drag.item.setPointerCapture) {
        try { drag.item.setPointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
      }
    }
    event.preventDefault();
    moveTo(drag.item, event.clientY);
  });

  function finish(event, commit) {
    if (!drag || event.pointerId !== drag.id) return;
    var state = drag;
    drag = null;
    state.item.classList.remove('side-link--dragging');
    if (state.item.releasePointerCapture && state.item.hasPointerCapture && state.item.hasPointerCapture(state.id)) {
      try { state.item.releasePointerCapture(state.id); } catch (error) { /* 忽略 */ }
    }
    if (!state.moved) return; // 没超过阈值：当作点击，交给浏览器导航
    swallowClick = true;
    window.setTimeout(function () { swallowClick = false; }, 0);
    if (!commit) { fail(state.snapshot, state.anchor); return; }
    persist().catch(function () { fail(state.snapshot, state.anchor); });
  }

  nav.addEventListener('pointerup', function (event) { finish(event, true); });
  nav.addEventListener('pointercancel', function (event) { finish(event, false); });

  // 拖动结束的那次 click 不该再导航（既不该整页跳，也不该被 htmx boost）。
  document.addEventListener('click', function (event) {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
})();
`
