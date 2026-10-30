/*
 * 侧栏局部刷新之后的三件同步（拼进 `/assets/app.js`）。
 *
 * htmx 只换 `<main>`，**外壳不动**，所以有两样东西不会自己跟上：
 * 1. `document.title`——htmx 不换 `<head>`（也刻意不换：换 head 会重新拉脚本）；
 * 2. 侧栏高亮（`aria-current="page"`）——它在外壳里，服务端已经不重渲染了。
 *
 * 所以片段里带两个属性（`main-column.ts` 输出）：`data-page-title` / `data-page-path`，
 * 这里在 `htmx:afterSwap` 之后读一次、写两处。
 *
 * 为什么用**服务端给的路径**而不是 `location.pathname` 反推：片段是唯一真相，
 * 不去猜 URL 与页面项的对应关系（带查询串、带尾斜杠时猜错就是高亮错位）。
 *
 * 第三件是**兜底**：HX 请求也可能拿到非片段响应（未登录被 302 到登录页、404、500）。
 * 服务端纪律是「未登录的 HX 请求照样 302」，所以浏览器会跟到登录页并拿到整页 HTML。
 * 那种响应绝不能塞进 `<main>`——这里取消这次 swap，改成整页跳转。
 *
 * 后退 / 前进：`app.js` 里把 htmx 的 history 缓存关了（`historyCacheSize = 0` +
 * `refreshOnHistoryMiss = true`），所以 back 走整页重载——侧栏与内容必然一致。
 * 关缓存还有一个更重要的理由：缓存会把整页 HTML 写进 sessionStorage，
 * 而「新建 API key 后那一次」的明文就在主列里（秘密纪律）。
 */
export const BOOST_JS = `
(function () {
  'use strict';
  if (!window.htmx) return;

  function sync() {
    var main = document.querySelector('main[data-page-path]');
    if (!main) return;
    var title = main.getAttribute('data-page-title');
    if (title) document.title = title;
    var path = main.getAttribute('data-page-path');
    var links = document.querySelectorAll('.side-nav .side-link[data-nav-path]');
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('data-nav-path') === path) {
        links[i].setAttribute('aria-current', 'page');
      } else {
        links[i].removeAttribute('aria-current');
      }
    }
  }

  document.body.addEventListener('htmx:afterSwap', sync);

  // 非片段响应（登录页 / 404 / 500）不换入主列，改成整页跳转。
  // 判据是响应的第一个元素：片段一定以 <main 开头（服务端同一个渲染路径切出来的）。
  document.body.addEventListener('htmx:beforeSwap', function (event) {
    var detail = event.detail || {};
    var html = typeof detail.serverResponse === 'string' ? detail.serverResponse : '';
    if (html === '' || html.indexOf('<main') === 0) return;
    detail.shouldSwap = false;
    var url = detail.xhr && detail.xhr.responseURL;
    if (url) window.location.assign(url);
  });
})();
`
