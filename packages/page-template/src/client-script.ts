/*
 * 客户端脚本（`/assets/app.js` 的内容）。
 *
 * 为什么单独一个文件：它现在是站点行为的**唯一**入口——浮层菜单、确认框、
 * 弹窗、下拉与日期的渐进增强、htmx 配置。和像素级 CSS（`assets.ts`）混在一起
 * 会同时违背「一个文件一个职责」和单文件 400 行软上限。
 *
 * 纪律：
 * - **不要引框架**，这里只有委托监听与少量 DOM 操作；
 * - 每个升级函数都要**幂等**（htmx 局部刷新会重复调用）；
 * - 任何增强失败都只能降级到原生控件，绝不能把整页脚本打断。
 */

/**
 * 站点唯一的客户端脚本（web 把它当 `/assets/app.js` 发出去）。
 *
 * 页面是**服务端渲染**的：筛选条件都在 URL 查询串里，菜单项就是普通链接，
 * 点了直接导航过去——状态因此可分享、可刷新、可后退。脚本不做重绘，
 * 只做三件事：**开合浮层**（菜单 / 确认框 / 弹窗）、**升级控件**（下拉 / 日期）、
 * 以及设置 htmx 配置。
 *
 * 悬浮提示与轻提示的代码不在这里：它们是独立的两块行为（`client-tooltip.ts` /
 * `client-toast.ts`），在文件末尾拼进同一个 `CLIENT_JS`。
 * 为什么仍是一个文件发出去：站点只引一个 `/assets/app.js`（多一个 `<script>` 就多一次
 * 请求与一次版本串维护），但**源码按职责拆开**，谁改 tooltip 不用读这一段。
 */
import { BOOST_JS } from './client-boost.ts'
import { NAV_ORDER_JS } from './client-nav-order.ts'
import { FEEDBACK_JS } from './client-feedback.ts'
import { TOAST_JS } from './client-toast.ts'
import { TOOLTIP_JS } from './client-tooltip.ts'

/** 浮层开合 / 控件升级 / htmx 配置那一段。 */
const CLIENT_CORE_JS = `
(function () {
  'use strict';

  // ── htmx 配置（必须在 htmx 之后、DOMContentLoaded 之前执行）──────────
  // htmx 默认会 insertAdjacentHTML 注入一段内联 <style> 给 indicator 上样式，
  // 而站点 CSP 是 style-src 'self'（无 'unsafe-inline'、无 nonce），实测该注入
  // 被拦下并产生 1 条 style-src-elem 违规。关掉注入，等价规则放在
  // COMPONENT_CSS（服务端输出，首屏就生效，不会闪）。
  //
  // 时机说明：htmx 的 init 挂在 DOMContentLoaded 上，而本文件是 body 末尾的
  // 经典脚本，一定先于 DOMContentLoaded 执行，所以「设置 → 初始化」没有窗口期。
  // 实测见 AGENTS.md「前端 / CSP」。若把本脚本挪到 htmx 之前，window.htmx 还是
  // undefined，配置设不进去，htmx 就会按默认值注入（实测那才是唯一会出违规的写法）。
  if (window.htmx && window.htmx.config) {
    window.htmx.config.includeIndicatorStyles = false;
    // ── 局部刷新的两个配置（第 4 批）────────────────────────────────────
    // 1) **不缓存历史**：htmx 的 history 缓存会把**整页 HTML** 写进 sessionStorage，
    //    而「新建 API key 之后那一次渲染」的明文就在主列里 —— 秘密纪律不允许它落到
    //    sessionStorage（与 localStorage / URL / 日志同级）。
    // 2) **后退 / 前进 = 整页重载**：关了缓存之后，popstate 找不到缓存项时会走
    //    『refreshOnHistoryMiss』。设成 true 就是整页 reload——侧栏高亮与内容由服务端
    //    一起重新渲染，天然一致，不必在客户端手工回放状态（那才是错位的来源）。
    //    代价是后退那一下是全量请求；换来的是「绝不错位」。
    window.htmx.config.historyCacheSize = 0;
    window.htmx.config.refreshOnHistoryMiss = true;
    // 3) 关掉 eval：全站不用 hx-on: / js: 表达式，而 CSP 没有 'unsafe-eval'，
    //    留着它只会在别人将来写 hx-on 时静默失效。
    window.htmx.config.allowEval = false;
  }

  function closeAll(except) {
    var pills = document.querySelectorAll('.pill[aria-expanded="true"]');
    for (var i = 0; i < pills.length; i++) {
      if (pills[i] !== except) pills[i].setAttribute('aria-expanded', 'false');
    }
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;

    var pill = target.closest('.pill');
    if (pill) {
      var open = pill.getAttribute('aria-expanded') === 'true';
      closeAll(pill);
      pill.setAttribute('aria-expanded', open ? 'false' : 'true');
      // 键盘打开（Enter / Space 触发的 click，其 detail 是 0）时把焦点送进菜单，
      // 否则焦点还留在胶囊上，用户得再按一次 Tab 才够得到第一项。
      // 鼠标点击不搬焦点：那会让浮层刚出现就闪一圈焦点环。
      if (!open && event.detail === 0) {
        var wrap = pill.parentNode;
        var item = wrap && wrap.querySelector('.menu-item[aria-selected="true"]');
        if (!item && wrap) item = wrap.querySelector('.menu-item');
        if (item && item.focus) item.focus();
      }
      event.stopPropagation();
      return;
    }

    // 点到菜单项：让它按链接正常导航（脚本不拦截），但先收起浮层。
    if (target.closest('.menu-item')) {
      closeAll(null);
      return;
    }

    closeAll(null);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    // 按 Esc 收起浮层之后，焦点必须回到那个胶囊上：否则焦点停在一个
    // 已经 display: none 的菜单项里，下一次 Tab 会从文档开头重新数。
    var open = document.querySelector('.pill[aria-expanded="true"]');
    closeAll(null);
    if (open && open.focus) open.focus();
  });

  // ── 确认框（替代 window.confirm）──────────────────────────────────────
  // 原生 confirm 是浏览器画的模态框，样式完全不可控（CSS 碰不到），还阻塞整个页面。
  // 这里用原生 <dialog>（没有默认外观，只提供焦点陷阱 / ESC / backdrop），外观自绘。
  //
  // 无 JS 时怎么办：<dialog> 默认不显示，所以没有 JS 时点了按钮**直接执行**，
  // 不会「卡住不动」——这是刻意的降级（浏览器原生 confirm 在无 JS 时也没了）。
  var confirmDialog = document.getElementById('dizzy-confirm');
  var confirmText = confirmDialog ? confirmDialog.querySelector('[data-confirm-text]') : null;
  var confirmOk = confirmDialog ? confirmDialog.querySelector('[data-confirm-ok]') : null;
  var confirmCancel = confirmDialog ? confirmDialog.querySelector('[data-confirm-cancel]') : null;
  // 待确认的动作：确认后执行它，取消则丢弃。
  var pendingAction = null;

  function closeConfirm() {
    pendingAction = null;
    if (confirmDialog && confirmDialog.open) confirmDialog.close();
  }

  if (confirmDialog && confirmOk && confirmCancel) {
    confirmOk.addEventListener('click', function () {
      var action = pendingAction;
      closeConfirm();
      if (action) action();
    });
    confirmCancel.addEventListener('click', closeConfirm);
    // 点 backdrop（dialog 元素本身）也取消
    confirmDialog.addEventListener('click', function (event) {
      if (event.target === confirmDialog) closeConfirm();
    });
  }

  // 表单：提交前先确认
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.getAttribute) return;
    var message = form.getAttribute('data-confirm');
    if (!message) return;
    // 没有 <dialog>（理论上不会发生）就直接放行，不要把用户卡住
    if (!confirmDialog || !confirmOk) return;
    event.preventDefault();
    if (confirmText) confirmText.textContent = message;
    pendingAction = function () {
      // 程序化 form.submit() **不触发** submit 事件，待定态（「保存…」）得在这里显式点亮，
      // 否则确认之后按钮毫无变化，看起来还是「点了没反应」。
      if (window.dizzyPending) window.dizzyPending(form);
      form.submit();
    };
    confirmDialog.showModal();
  });

  // 按钮 / 链接：点击前先确认
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var trigger = target.closest('[data-confirm-action]');
    if (!trigger) return;
    var message = trigger.getAttribute('data-confirm-action');
    if (!message) return;
    if (!confirmDialog || !confirmOk) return;
    event.preventDefault();
    event.stopPropagation();
    if (confirmText) confirmText.textContent = message;
    pendingAction = function () { trigger.click(); };
    confirmDialog.showModal();
  }, true);
  // ── 弹窗（原生 <dialog> + 触发器）────────────────────────────────────
  // 服务端只输出结构与 data-* 钩子，这里只负责 showModal / close。
  // 焦点陷阱、ESC、::backdrop、顶层顺序全部由浏览器负责——手写的焦点陷阱在
  // Safari / 移动端都会被 tab 键绕出去。
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;

    var opener = target.closest('[data-dialog-open]');
    if (opener) {
      var dialog = document.getElementById(opener.getAttribute('data-dialog-open'));
      // 找不到目标就什么都不做（不要把点击吞掉，链接还要能跳）
      if (dialog && dialog.showModal) {
        event.preventDefault();
        dialog.showModal();
        // 浏览器默认把焦点放在第一个可聚焦元素上（通常是右上角的关闭按钮），
        // 底部还会画一圈焦点环，看起来像「按钮坏了」。编辑类弹窗把焦点放到
        // 第一个输入框更合理，键盘用户也能直接开始打字。
        var firstField = dialog.querySelector('.dialog__body--modal input.input');
        if (firstField && !firstField.disabled) firstField.focus();
      }
      return;
    }

    var closer = target.closest('[data-dialog-close]');
    if (closer) {
      var host = closer.closest('dialog');
      if (host) {
        event.preventDefault();
        host.close();
      }
    }
  });

  // 点 backdrop 关闭：只有**点击目标是 dialog 元素本身**才算
  // （正文里的点击会冒泡上来，靠这一条区分）。
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || target.tagName !== 'DIALOG' || !target.open) return;
    if (target.hasAttribute('data-dialog-backdrop')) target.close();
  });

  // ── 控件升级（渐进增强）──────────────────────────────────────────────
  // 服务端输出的是**可用的原生控件**（select / input[type=date]），
  // 这里把它们升级成自绘浮层的版本。JS 没跑时原生控件照样能用，功能不丢。
  function upgradeControls() {
    if (window.TomSelect) {
      var selects = document.querySelectorAll('select[data-tom-select]');
      for (var i = 0; i < selects.length; i++) {
        // 已经升级过的跳过（htmx 局部刷新后可能重复调用）
        if (selects[i].tomselect) continue;
        try {
          var ts = new window.TomSelect(selects[i], {
            // 浮层定位交给 Tom Select（它用 CSSOM 赋值，不受 CSP 限制）
            create: false,
            allowEmptyOption: true,
          });
          // 库会把原生控件的 class 抄到它自己的包装元素上（.ts-wrapper 会带我们的 .input）。
          // 那样等于「.input 的边框内边距」与「.ts-control 的边框内边距」叠加，
          // 视觉上是框里套框、且比同排输入框矮一截（实测截图）。外观归 .ts-control，
          // 所以把这类抄过来的皮肤类摘掉。
          if (ts && ts.wrapper) ts.wrapper.classList.remove('input', 'select');
        } catch (error) {
          // 单个控件失败不能让整页脚本停掉——原生 select 还在，用户能用
          if (window.console && console.warn) console.warn('TomSelect 初始化失败', selects[i], error);
        }
      }
    }
    if (window.flatpickr) {
      var dates = document.querySelectorAll('input[data-flatpickr]');
      for (var j = 0; j < dates.length; j++) {
        if (dates[j]._flatpickr) continue;
        // 每轮把当前元素取出来存成局部变量：下面的闭包是**异步**执行的，
        // 用 dates[j] 会读到循环结束后的 j（= length，undefined）——这正是
        // 「日历搬进弹窗后位置没纠正」的真因（setTimeout 里抛 TypeError）。
        var input = dates[j];
        try {
          // 原生 date 输入会**同时**弹出浏览器自带的日历图标，与 flatpickr 的浮层
          // 叠在一起。换成 text 之后只剩我们自己的日历（这是 DOM 属性赋值，
          // 不涉及 style，不受 CSP 限制）。无 JS 时它仍是 type=date，功能不丢。
          if (input.type === 'date') input.type = 'text';
          var fp = window.flatpickr(input, { dateFormat: 'Y-m-d', allowInput: true });
          // 弹窗里的日期：flatpickr 把日历挂在 document.body 上，而 <dialog> 打开后
          // 处在**顶层（top layer）**，body 里的浮层会被 backdrop 盖住、完全看不见
          // （实测：日历的 open 类加上了，屏幕上什么都没有）。
          // 搬到最近的 <dialog> 里就能进顶层，但换父元素会改变定位参照系
          // （对话本身是定位元素），flatpickr 按文档坐标算出的 left/top 会跑偏
          // （实测：日历被挤出弹窗右边界）。所以搬进去之后自己按视口重算一次。
          var host = input.closest ? input.closest('dialog') : null;
          if (host && fp && fp.calendarContainer) {
            host.appendChild(fp.calendarContainer);
            // 自己的监听排在 flatpickr 的之后（同一个元素上后绑定的先不了），
            // 所以 open 与它的定位都已完成，rAF 之后再纠正一次即可。
            var fixInDialog = function () {
              window.setTimeout(function () {
                var cal = fp.calendarContainer;
                if (!cal) return;
                var box = input.getBoundingClientRect();
                var hostBox = host.getBoundingClientRect();
                var width = cal.offsetWidth || 300;
                var limit = (window.innerWidth || 1024) - width - 12;
                // 日历是 dialog 的子元素，所以坐标要换算成「相对 dialog」。
                // 先按视口算目标位置（并夹在窗口内），再减去 dialog 的原点。
                var left = Math.max(12, Math.min(Math.round(box.left), Math.round(limit))) - hostBox.left;
                var height = cal.offsetHeight || 280;
                var viewport = window.innerHeight || 768;
                // 下面放不下就翻到输入框上方（和 flatpickr 自己的策略一致）。
                var below = box.bottom + 4;
                var top = below + height > viewport - 8 ? box.top - height - 4 : below;
                cal.style.position = 'absolute';
                cal.style.left = Math.round(left) + 'px';
                cal.style.top = Math.round(top - hostBox.top) + 'px';
              });
            };
            input.addEventListener('focus', fixInDialog);
            input.addEventListener('click', fixInDialog);
          }
        } catch (error) {
          if (window.console && console.warn) console.warn('flatpickr 初始化失败', input, error);
        }
      }
    }
  }

  // 首次加载：DOM 已解析到本脚本处，直接升级。
  upgradeControls();
  // htmx 局部刷新换入的内容也要升级（第 4 批做局部刷新时靠这一条）。
  if (window.htmx) {
    document.body.addEventListener('htmx:afterSwap', upgradeControls);
  }
})();
`

/**
 * 站点脚本全文：核心段 + 悬浮提示 + 轻提示 + 交互反馈 + 局部刷新 + 侧栏拖动排序。
 *
 * 顺序不影响正确性（每段各管各的），但按「页面骨架 → 交互辅助」排更好读。
 * `FEEDBACK_JS` 要排在 `CLIENT_CORE_JS` 之后（确认框那段引用它导出的 `window.dizzyPending`）；
 * `BOOST_JS` 要在 `CLIENT_CORE_JS` 之后（它读 htmx 的 afterSwap，前提是 htmx 已配好）；
 * `NAV_ORDER_JS` 放在最后（它只碰侧栏，与其它段无耦合）。
 */
export const CLIENT_JS = `${CLIENT_CORE_JS}
${TOOLTIP_JS}
${TOAST_JS}
${FEEDBACK_JS}
${BOOST_JS}
${NAV_ORDER_JS}`
