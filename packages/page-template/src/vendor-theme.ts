/**
 * vendor 控件的**外观重绘**：把 Tom Select 与 flatpickr 的默认主题接到我们的设计 token 上。
 *
 * 为什么必须有这个文件：这两个库都自带**浅色主题**，直接 vendor 进来会在深色站上
 * 出现白色下拉框与白色日历（截图实测：`controls-after.png` 里那个白块就是它）。
 * 「不引第三方 UI 库」的精神是「不引它的外观」，行为可以借、皮肤必须自己画。
 *
 * 约定：**只写颜色 / 圆角 / 间距 / 字号**，不碰定位（浮层定位由库自己算，它们用
 * CSSOM 赋值，不受 CSP `style-src 'self'` 限制）。全部复用 `assets.ts` 的 token，
 * 不新增颜色字面量。
 *
 * ⚠️ 这两份覆盖**必须排在 vendor CSS 之后**（`/assets/app.css` 的拼接顺序是
 * `PAGE_CSS + COMPONENT_CSS + LAYOUT_CSS + MODAL_CSS + vendorCss + VENDOR_THEME_CSS`）。
 * 顺序反了会被库的默认浅色主题盖回去，表现为「下拉框又变白了」——
 * 同优先级下后者胜，所以这里不靠 `!important`，靠拼接顺序。
 */
export const VENDOR_THEME_CSS = `
/* ── Tom Select：藏起被接管的原生控件（缺了这条会「两个下拉叠在一起」）──
 * 库给原始 <select> 加了 .ts-hidden-accessible 这个类名，但 **规则不在它的 min.css 里**
 * （实测 grep 不到，官方主题各自提供）——于是原生下拉和 .ts-wrapper 同时显示：
 * 截图里表现为「同一行出现两个『全部动作』、控件比同排输入框高一截」。
 * 这里补一份标准的「视觉隐藏但保留可访问性」写法。 */
.ts-hidden-accessible {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  padding: 0 !important;
  margin: -1px !important;
  overflow: hidden !important;
  clip: rect(0 0 0 0) !important;
  white-space: nowrap !important;
  border: 0 !important;
}

/* ── Tom Select：输入框本体 ────────────────────────────────────────
 * 与 .input 对齐：同样的背景、边框、圆角、内边距、高度、字号。
 * 库默认是白底黑字 + 34px 高，直接用会和旁边的输入框明显不齐。 */
.ts-wrapper.single .ts-control,
.ts-wrapper.multi .ts-control {
  background: var(--bg-layer-2);
  border: 1px solid var(--border-l2);
  border-radius: 10px;
  color: var(--label-primary);
  padding: 8px 12px;
  min-height: 38px;
  display: flex;
  align-items: center;
  box-shadow: none;
}
.ts-wrapper.single.focus .ts-control,
.ts-wrapper.multi.focus .ts-control {
  border-color: var(--border-l3);
  box-shadow: none;
}
/* 库自带的 .input-hidden / .ts-control > input 有白底，要清掉。 */
.ts-wrapper .ts-control > input {
  background: transparent;
  color: var(--label-primary);
  font: inherit;
  font-size: var(--fs-body);
  line-height: var(--lh-body);
}
.ts-wrapper .ts-control > .item,
.ts-wrapper .ts-control > .ts-placeholder {
  color: var(--label-primary);
  font-size: var(--fs-body);
  line-height: var(--lh-body);
}
.ts-wrapper .ts-control > .ts-placeholder { color: var(--label-caption); }
/* 单选的展开箭头：库用 CSS 三角画，颜色写死成深色，深色站上几乎看不见。 */
.ts-wrapper.single .ts-control:after {
  border-color: var(--label-tertiary) transparent transparent transparent;
}
.ts-wrapper.single.dropdown-active .ts-control:after {
  border-color: transparent transparent var(--label-tertiary) transparent;
}
/* 行内筛选栏里要和同排的 .input（38px）等高。这条必须写在这里而不是
 * layout-classes.ts：同优先级的规则按拼接顺序取胜，而 vendor 主题排在后面。 */
.form--inline .ts-wrapper.single .ts-control,
.form--inline .ts-wrapper.multi .ts-control { min-height: 38px; height: 38px; padding: 0 12px; }

/* ── Tom Select：浮层 ──────────────────────────────────────────────── */
.ts-wrapper .ts-dropdown {
  background: var(--bg-layer-3);
  border: 1px solid var(--border-l2);
  border-radius: 10px;
  color: var(--label-primary);
  margin-top: 6px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, .5);
  overflow: hidden;
}
.ts-dropdown .option,
.ts-dropdown .optgroup-header {
  padding: 8px 12px;
  font-size: var(--fs-body);
  line-height: var(--lh-body);
  color: var(--label-secondary);
}
.ts-dropdown .option.active,
.ts-dropdown .option:hover,
.ts-dropdown .option:focus {
  background: var(--bg-layer-2);
  color: var(--label-primary);
}
.ts-dropdown .option.selected {
  color: var(--label-primary);
  font-weight: 600;
}
.ts-dropdown .option[data-disabled],
.ts-dropdown .option.disabled { color: var(--label-caption); opacity: .6; }
.ts-dropdown .create { color: var(--label-secondary); }

/* ── flatpickr：日历 ──────────────────────────────────────────────── */
.flatpickr-calendar {
  background: var(--bg-layer-3);
  border: 1px solid var(--border-l2);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, .5);
  color: var(--label-primary);
}
/* 库用两个伪元素画指向上方的小三角，颜色要跟着换成浮层底色。 */
.flatpickr-calendar.arrowTop:before { border-bottom-color: var(--border-l2); }
.flatpickr-calendar.arrowTop:after { border-bottom-color: var(--bg-layer-3); }
.flatpickr-calendar.arrowBottom:before { border-top-color: var(--border-l2); }
.flatpickr-calendar.arrowBottom:after { border-top-color: var(--bg-layer-3); }

.flatpickr-months .flatpickr-month,
.flatpickr-current-month .flatpickr-monthDropdown-months,
.flatpickr-current-month input.cur-year {
  background: transparent;
  color: var(--label-primary);
  fill: var(--label-primary);
}
.flatpickr-current-month .flatpickr-monthDropdown-months { font-size: var(--fs-label); }
.flatpickr-current-month .flatpickr-monthDropdown-months .option { background: var(--bg-layer-3); }
.flatpickr-months .flatpickr-prev-month svg,
.flatpickr-months .flatpickr-next-month svg { fill: var(--label-secondary); }
.flatpickr-months .flatpickr-prev-month:hover svg,
.flatpickr-months .flatpickr-next-month:hover svg { fill: var(--label-primary); }

/* 星期表头：库的默认色在深色底上几乎看不见。 */
span.flatpickr-weekday { color: var(--label-caption); font-size: var(--fs-caption); background: transparent; }

/* 日期格：hover / 今天 / 选中三态。 */
.flatpickr-day { color: var(--label-secondary); border-radius: 8px; border-color: transparent; }
.flatpickr-day:hover,
.flatpickr-day:focus {
  background: var(--bg-layer-2);
  border-color: transparent;
  color: var(--label-primary);
}
.flatpickr-day.today { border-color: var(--border-l3); }
.flatpickr-day.today:hover { background: var(--bg-layer-2); border-color: var(--border-l3); }
/* 选中态用「反色」（白底深字），与 .btn 主按钮同一套观感。 */
.flatpickr-day.selected,
.flatpickr-day.selected:hover,
.flatpickr-day.selected:focus {
  background: var(--label-primary);
  border-color: var(--label-primary);
  color: var(--bg-base);
  font-weight: 600;
}
.flatpickr-day.flatpickr-disabled,
.flatpickr-day.flatpickr-disabled:hover { color: var(--label-caption); opacity: .4; }
.flatpickr-day.nextMonthDay,
.flatpickr-day.prevMonthDay { color: var(--label-caption); }
.flatpickr-day.inRange {
  background: var(--bg-layer-2);
  border-color: transparent;
  box-shadow: -5px 0 0 var(--bg-layer-2), 5px 0 0 var(--bg-layer-2);
}
.flatpickr-day.startRange, .flatpickr-day.endRange {
  background: var(--label-primary);
  border-color: var(--label-primary);
  color: var(--bg-base);
  box-shadow: none;
}
.flatpickr-calendar .numInputWrapper:hover { background: var(--bg-layer-2); }
`
