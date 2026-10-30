/**
 * 可访问性与交互反馈的**样式层**（Vercel Web Interface Guidelines 的落地）。
 *
 * 为什么单独一个文件：这里全是「跨组件的全局行为」——焦点环、动效偏好、触控、
 * 浮层滚动链、跳过链接、屏幕阅读器专用工具类。它们不属于任何一个组件
 * （卡片 / 表格 / 表单都有自己的样式文件），但每一条都必须**全站生效**，
 * 塞进某个组件文件里会让人以为只影响那一处。
 *
 * 三条纪律（改之前先读）：
 * 1. **只用 `:focus-visible`，不用 `:focus`**：鼠标点击不画环，键盘 Tab 才画。
 *    唯一例外是 `.notice:focus`（那是**程序**把焦点移过去，见 client-pending.ts）。
 * 2. **不许出现裸的 `outline: none`**：去掉原生环必须同时给出替代环，
 *    否则键盘用户彻底看不见焦点在哪（这是 WCAG 2.4.7 的硬要求）。
 * 3. **动效只动 `transform` / `opacity`**：这两样走合成器，不触发布局重排。
 *    这里有一条全局的 `prefers-reduced-motion` 兜底，别在别处再写 `!important`。
 */

/** 焦点环颜色：与侧栏选中项的图标同色（`assets.ts` 的 `#4D93F8`），深色底上对比度足够。 */
export const FOCUS_RING_VAR = `--focus-ring: #4D93F8;`

/**
 * 全站可访问性样式。
 *
 * 拼接位置：`assets.ts` 的 `PAGE_CSS` 末尾（见那边的一行 `${A11Y_CSS}`）。
 * 放在 `COMPONENT_CSS` 之前也能生效——这里的规则要么是 `:focus-visible`
 * （比 `.input` 多一个伪类，优先级更高），要么是全新的类名，不靠拼接顺序取胜。
 */
export const A11Y_CSS = `
:root { ${FOCUS_RING_VAR} }

/* ── 焦点可见（Focus）──────────────────────────────────────────────
 * 键盘 Tab 到任何可交互元素都要有清楚的环。用 :focus-visible 而不是 :focus：
 * 鼠标点按钮不画环（否则每次点击都闪一圈，看着像「选中了」）。
 *
 * outline-offset 取 2px：环画在元素外面，不被自身的圆角切掉。
 * 例外处理见下一条（overflow: hidden 的容器里改为内描边）。 */
a[href]:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
summary:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

/* 面板与表格是 overflow: hidden（圆角要裁内容），外侧焦点环会被裁成半圈。
 * 这几处改成**内描边**（负 offset），环仍然完整可见。 */
.panel :focus-visible,
.table :focus-visible { outline-offset: -2px; }

/* 原生输入框的焦点环由浏览器画、样式不可控；这里统一换成我们的环。
 * 注意：只压 outline，不改边框颜色（边框变化在深色底上对比度不够）。 */
.input:focus-visible,
.select:focus-visible,
.textarea:focus-visible { outline-offset: 1px; }

/* 复合控件（Tom Select 的可见框是 .ts-control，真正的焦点在它内部的 input 上）。
 * 库会在包装元素上加 .focus 类，用它画 :focus-within 等价的环。 */
.ts-wrapper.focus .ts-control,
.ts-wrapper:focus-within .ts-control {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

/* ── 跳过链接（Skip link）──────────────────────────────────────────
 * 键盘 / 读屏用户不必每次经过 12 个侧栏项才能到正文。
 * 平时移出视口（transform 而不是 top：只动合成器属性），聚焦时滑下来。 */
.skip-link {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 100;
  padding: 10px 16px;
  border-radius: 10px;
  background: var(--label-primary);
  color: #111214;
  font-size: var(--fs-label);
  line-height: var(--lh-label);
  font-weight: 500;
  white-space: nowrap;
  transform: translateY(calc(-100% - 24px));
  transition: transform .15s ease;
}
.skip-link:focus-visible { transform: none; }

/* ── 屏幕阅读器专用（视觉隐藏但仍在无障碍树里）─────────────────────
 * 用途：aria-live 状态区（pending 态播报）。不要用 display: none /
 * visibility: hidden —— 那会把内容一起从无障碍树里摘掉，读屏念不到。 */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* ── 表单：就地错误 ────────────────────────────────────────────────
 * 服务端校验失败 / 浏览器原生校验失败时，错误写在字段正下方（而不是只弹一个
 * 页面顶部的条），配合 aria-describedby 让读屏念到「字段 + 原因」。
 * 颜色用 error 而不是 caption：错误必须和普通说明区分开。 */
.field-error {
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  color: #F25A5A;
  margin: 0;
}
.input[aria-invalid="true"],
.select[aria-invalid="true"],
.textarea[aria-invalid="true"] { border-color: rgba(242, 90, 90, .72); }

/* 原生校验（required / type=email / pattern）没过的字段：Chrome 119+ / Safari 16.4+
 * 支持 :user-invalid，它只在**用户交互之后**才命中，页面初次加载不会整片飘红。 */
.input:user-invalid,
.select:user-invalid,
.textarea:user-invalid { border-color: rgba(242, 90, 90, .72); }

/* 错误提示条被程序聚焦时也要看得见（它是 role="alert"，不是可交互元素，
 * :focus-visible 在程序化聚焦时不保证命中，所以这里显式画）。 */
.notice:focus {
  outline: 2px solid var(--label-tertiary);
  outline-offset: 2px;
}

/* 字段级错误被客户端脚本搬到字段下方之后，页顶那条原始提示就不再重复显示。
 * 为什么写成两个类（.notice.notice--moved）：.notice 本身是 display: flex 且
 * **拼在 PAGE_CSS 之后**，同优先级下它会赢——实测就是「搬完了页顶还留着一条」。
 * 两个类提高优先级，不靠拼接顺序。 */
.notice.notice--moved { display: none; }

/* ── 交互反馈：待定态（pending）────────────────────────────────────
 * 点了按钮之后到页面换掉之间，按钮必须有明确的变化，否则就是 owner 说的
 * 「点了没反应」。文案由 client-pending.ts 改成「保存…」，这里只管外观。
 *
 * 不用 disabled 属性：按钮的 name / value 必须照常进表单数据
 * （profile 页的「恢复默认」就是靠 <button name="reset" value="1">），
 * disabled 会让它从提交数据里消失。改用 aria-disabled + pointer-events。 */
.btn.is-pending,
.btn[aria-busy="true"] { cursor: progress; }
.btn[aria-disabled="true"] {
  pointer-events: none;
  opacity: .72;
}
.icon-btn[aria-disabled="true"] { pointer-events: none; opacity: .72; }

/* 页内局部刷新（htmx）期间的「在加载」体感：主列淡一点。
 * 只动 opacity，不动布局 —— 内容不会因为加这个类而跳位。 */
.main.is-busy { opacity: .55; transition: opacity .12s ease; }

/* 加载指示器（htmx 默认那个）也跟着动效偏好走：见下面 reduced-motion 兜底。 */

/* ── 触控（Touch）──────────────────────────────────────────────────
 * touch-action: manipulation 去掉双击缩放带来的 300ms 点击延迟
 * （「点一下要等一下才响应」的一半原因在这里）。
 * 可拖动排序的侧栏项例外：那份规则在 extra-styles.ts 里是 touch-action: none
 * （优先级更高：.side-nav .side-link[data-nav-path]）。 */
a[href],
button,
input,
select,
textarea,
summary,
label,
[role="tab"] { touch-action: manipulation; }

/* 点击高亮：**显式设置**（指南要求，而不是留浏览器默认）。
 * 深色站点上默认那层半透明蓝灰很难看，这里换成一层很淡的白。 */
a[href],
button,
[role="tab"],
.pill,
.seg-item,
.menu-item,
.side-link,
.icon-btn {
  -webkit-tap-highlight-color: rgba(255, 255, 255, .12);
}

/* 点下去的即时反馈（触屏没有 hover，只有 :active）——按压感要早于请求返回。 */
.btn:active,
.icon-btn:active,
.pill:active,
.menu-item:active,
.seg-item:active { opacity: .82; }

/* ── 浮层：滚动链 ──────────────────────────────────────────────────
 * 弹窗里滚到底之后，滚动会「传」给背后的页面（iOS 上尤其明显：背景跟着滑，
 * 松手后弹窗位置错位）。contain 把滚动链截断在浮层内部。 */
.dialog,
.dialog--modal,
.dialog--confirm,
.menu,
.ts-dropdown { overscroll-behavior: contain; }

/* 桌面（指针精细）上关掉整页的橡皮筋回弹；触屏设备保留下拉刷新等原生行为。 */
@media (pointer: fine) {
  html { overscroll-behavior: none; }
}

/* ── 锚点定位 ──────────────────────────────────────────────────────
 * 从目录点进某个标题时，别让标题贴在视口最上沿（留一口气）。 */
.page-title,
.section-title,
.model-name,
.dialog__title { scroll-margin-top: 24px; }

/* ── 动效偏好（Animation）──────────────────────────────────────────
 * 系统设了「减少动态效果」就整体关掉：动画、过渡、平滑滚动全部归零。
 * 为什么用 !important：这些规则要能压过各组件自己写的 transition
 * （.side-link 的背景过渡、.btn 的透明度过渡…），逐条改会漏。
 * 用 0.01ms 而不是 0：某些浏览器会绕过 transitionend 事件，等 1ms 更稳。 */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
`
