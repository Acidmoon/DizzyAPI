/*
 * 交互反馈的客户端行为（拼进 `/assets/app.js`）。
 *
 * 这一段专治 owner 说的「点一个按钮之后要反应半天才能加载出来」：站点是
 * **表单 POST + 303 整页刷新**，点下去到新页面出现之间浏览器是静默的——
 * 用户看不到任何「正在做事」的迹象，于是以为按钮坏了、再点一次。
 *
 * 四件事，都只做**反馈**、不改业务数据：
 * 1. **待定态**：提交那一刻就把提交按钮改成「保存…」并置 `aria-busy`，
 *    宽度用 CSSOM 钉住（不让文案变化把按钮撑大），同一表单只放行一次提交。
 * 2. **播报**：把「正在保存…」写进文档里唯一的 `#dizzy-status`
 *    （`role="status" aria-live="polite"`），读屏用户也知道动作已经开始。
 * 3. **错误就地显示**：服务端把错误放在 `?err=…&field=…`，页面顶部的提示条带
 *    `data-field`；这里把它**搬到那个字段下方**（`aria-describedby` 一并接上），
 *    并把焦点交给字段——键盘用户不用回页顶找「为什么不成功」。
 *    浏览器原生校验（required / type=email）没过时同理，错误就地写在字段下。
 * 4. **失败定位兜底**：找不到对应字段（或错误与字段无关）时，聚焦页顶那条提示。
 *
 * 为什么不用 `disabled` 属性：`<button name="reset" value="1">恢复默认</button>`
 * 的 name / value 必须照常进表单数据，`disabled` 会让它从提交数据里消失。
 * 所以用 `aria-disabled` + `pointer-events: none`（见 a11y.ts），配合一个
 * 「已经提交过」的属性防止重复提交。
 *
 * 为什么还要 `pageshow`：站点把 htmx 的 history 缓存关了，后退是整页重载；
 * 但 **bfcache**（往返缓存）仍可能把「保存中」的页面原样恢复，所以无条件还原一次。
 */
export const FEEDBACK_JS = `
(function () {
  'use strict';

  var status = document.getElementById('dizzy-status');

  // 播报：先清空再写，读屏才会把重复的同一句话也念出来。
  function say(text) {
    if (!status) return;
    status.textContent = '';
    window.setTimeout(function () { status.textContent = text; }, 30);
  }

  function labelOf(element) {
    if (!element) return '';
    return (element.textContent || '').replace(/\\s+/g, ' ').trim();
  }

  // 提交按钮：优先 event.submitter（用户真正点中的那颗），退化到第一颗。
  function submitterOf(form, event) {
    if (event && event.submitter) return event.submitter;
    return form.querySelector('button[type="submit"], input[type="submit"]');
  }

  // 已经进入待定态的表单（数组里存还原所需的信息）。
  var pending = [];

  function markPending(form, button) {
    if (!form || form.getAttribute('data-pending') === 'done') return;
    form.setAttribute('data-pending', 'done');
    form.setAttribute('aria-busy', 'true');
    var button = button || submitterOf(form, null);
    var label = labelOf(button);
    if (button) {
      button.setAttribute('aria-busy', 'true');
      button.setAttribute('aria-disabled', 'true');
      if (button.classList) button.classList.add('is-pending');
      // 宽度钉住：文案从「保存」变「保存…」不能让整排按钮跳一下。
      // 走 el.style 赋值（CSSOM）；写 style 属性会被 CSP 的 style-src 'self' 拦掉。
      try {
        var width = button.getBoundingClientRect().width;
        if (width > 0) button.style.minWidth = Math.ceil(width) + 'px';
      } catch (error) { /* 量不到就让它按内容宽度 */ }
      if (label !== '') button.textContent = label + '…';
    }
    pending.push({ form: form, button: button, label: label });
    say(label === '' ? '正在提交…' : '正在' + label + '…');
  }

  // 还原：换页没发生（校验失败 / 用户取消 / bfcache 恢复）时要能再点。
  function restore() {
    for (var i = 0; i < pending.length; i += 1) {
      var item = pending[i];
      item.form.removeAttribute('data-pending');
      item.form.removeAttribute('aria-busy');
      if (!item.button) continue;
      item.button.removeAttribute('aria-busy');
      item.button.removeAttribute('aria-disabled');
      if (item.button.classList) item.button.classList.remove('is-pending');
      item.button.style.minWidth = '';
      if (item.label !== '') item.button.textContent = item.label;
    }
    pending.length = 0;
  }

  // 冒泡阶段监听（不是捕获）：确认框那段委托在 document 上先注册，
  // 它会 preventDefault 并弹出确认框；这里看到 defaultPrevented 就说明
  // 「这次提交被拦下了」，不能点亮待定态，否则取消之后按钮永远是「保存…」。
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || form.tagName !== 'FORM') return;
    if (event.defaultPrevented) return;
    if (form.getAttribute('data-pending') === 'done') {
      // 已经提交过一次：再点不算（否则会发出两条写请求）。
      event.preventDefault();
      return;
    }
    markPending(form, submitterOf(form, event));
  });

  // 确认框点「确认」之后走的是 form.submit()（程序化提交），它**不触发** submit
  // 事件，所以待定态得由确认框那段显式调这个入口点亮。
  window.dizzyPending = markPending;

  window.addEventListener('pageshow', restore);

  // ── 错误就地显示 ───────────────────────────────────────────────────
  // 字段的「外层」：.field 包裹（模板的 renderField 与页面手写的一致）。
  function wrapperOf(control) {
    if (!control) return null;
    var node = control.parentNode;
    while (node && node !== document.body) {
      if (node.classList && node.classList.contains('field')) return node;
      node = node.parentNode;
    }
    return control.parentNode;
  }

  function errorBase(control) {
    return control.id || control.name || 'field';
  }

  // 在字段下方写一条错误（没有就建），并把无障碍关系接上。
  function setFieldError(control, message) {
    var wrap = wrapperOf(control);
    if (!wrap) return;
    var node = wrap.querySelector('.field-error');
    if (!node) {
      node = document.createElement('p');
      node.className = 'field-error';
      node.setAttribute('role', 'alert');
      wrap.appendChild(node);
    }
    node.textContent = message;
    if (!node.id) node.id = errorBase(control) + '-error';
    control.setAttribute('aria-invalid', 'true');
    var described = (control.getAttribute('aria-describedby') || '').split(/\\s+/).filter(Boolean);
    if (described.indexOf(node.id) < 0) described.push(node.id);
    control.setAttribute('aria-describedby', described.join(' '));
  }

  function clearFieldError(control) {
    var wrap = wrapperOf(control);
    var node = wrap && wrap.querySelector ? wrap.querySelector('.field-error') : null;
    if (node && node.parentNode) node.parentNode.removeChild(node);
    control.removeAttribute('aria-invalid');
    var errorId = errorBase(control) + '-error';
    var described = (control.getAttribute('aria-describedby') || '').split(/\\s+/).filter(function (id) {
      return id !== '' && id !== errorId;
    });
    if (described.length === 0) control.removeAttribute('aria-describedby');
    else control.setAttribute('aria-describedby', described.join(' '));
  }

  // 把页顶那条错误提示搬到对应字段下方；搬不动（没有 field）就留着它自己。
  (function relocateNotice() {
    var notice = document.querySelector('.notice.err[data-field]');
    if (!notice) return;
    var name = notice.getAttribute('data-field');
    var control = name ? document.getElementsByName(name)[0] : null;
    if (!control) return;
    var text = notice.textContent || '';
    setFieldError(control, text);
    // 幂等：局部刷新 / 重复执行时别把类名叠加两次。
    if (notice.className.indexOf('notice--moved') < 0) notice.className += ' notice--moved';
    try { control.focus(); } catch (error) { /* 忽略 */ }
    if (control.scrollIntoView) control.scrollIntoView({ block: 'center' });
    say(text);
  })();

  // 原生校验失败：默认会弹一个浏览器气泡（样式不可控、还挡在字段上）。
  // 这里取消气泡、改成字段下方的文字 + aria-invalid，焦点由浏览器交给第一个错误字段。
  document.addEventListener('invalid', function (event) {
    var control = event.target;
    if (!control || !control.setAttribute) return;
    event.preventDefault();
    var message = control.validationMessage || '';
    if (message !== '') setFieldError(control, message);
    else control.setAttribute('aria-invalid', 'true');
  }, true);

  // 用户改了输入就清掉该字段的错误（否则改对了还一直红着）。
  document.addEventListener('input', function (event) {
    var control = event.target;
    if (!control || !control.validity) return;
    if (control.validity.valid) clearFieldError(control);
  }, true);

  // ── 失败定位兜底 ───────────────────────────────────────────────────
  // 服务端 303 回 ?err=… 的提示条是 role="alert" + tabindex="-1"。
  // 字段找得到的情况已在上面就地处理；这里只兜「与字段无关的错误」。
  (function focusError() {
    var notice = document.querySelector('.notice.err');
    if (!notice || notice.className.indexOf('notice--moved') >= 0) return;
    try { notice.focus(); } catch (error) { /* 忽略 */ }
    if (notice.scrollIntoView) notice.scrollIntoView({ block: 'center' });
  })();

  // ── 局部刷新期间的「在加载」体感 ───────────────────────────────────
  // 侧栏链接是 htmx 局部刷新（只换 <main>）。请求期间主列不变，看着也像「没反应」，
  // 所以淡一点 + 播报一句；换入 / 失败都要还原。
  if (window.htmx) {
    function setBusy(busy, text) {
      var main = document.querySelector('main.main');
      if (main) {
        if (busy) {
          main.classList.add('is-busy');
          main.setAttribute('aria-busy', 'true');
        } else {
          main.classList.remove('is-busy');
          main.removeAttribute('aria-busy');
        }
      }
      if (busy && text) say(text);
    }
    document.body.addEventListener('htmx:beforeRequest', function () { setBusy(true, '正在加载页面…'); });
    document.body.addEventListener('htmx:afterSwap', function () { setBusy(false); });
    document.body.addEventListener('htmx:sendError', function () { setBusy(false); });
    document.body.addEventListener('htmx:responseError', function () { setBusy(false); });
    document.body.addEventListener('htmx:timeout', function () { setBusy(false); });
  }
})();
`
