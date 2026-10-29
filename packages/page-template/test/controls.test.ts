/**
 * 自研控件（下拉 / 日期）的渲染契约。
 *
 * 这一批控件的**核心取舍是渐进增强**：服务端输出的永远是一个**可用的原生元素**
 * （`<select>` / `<input type="date">`），只多一个 `data-*` 钩子。
 * 所以这里的断言分两类：
 * 1. 无 JS 时必须还能用（原生元素、`name`、`option` 的 `value` / `selected` 都对）；
 * 2. 有 JS 时能被升级（钩子属性在、`CLIENT_JS` 里真有升级逻辑且幂等）。
 *
 * 为什么不用原生控件直接改样式：下拉浮层与日历浮层由**浏览器绘制**，
 * CSS 完全碰不到（`appearance` 只能改外观，改不了浮层）。要自绘只能把选择逻辑
 * 搬进 DOM，那是 Tom Select / flatpickr 干的事。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLIENT_JS } from '../src/client-script.ts'
import { VENDOR_THEME_CSS } from '../src/vendor-theme.ts'
import { renderDatePicker } from '../src/date-picker.ts'
import { MODAL_CSS, dialogOpenAttr, renderModal } from '../src/modal.ts'
import { renderSelect, renderSelectShell } from '../src/select.ts'

// ─────────────────────── 下拉 ───────────────────────

test('下拉：输出原生 select + 升级钩子（无 JS 时表单照样能提交）', () => {
  const html = renderSelect({
    name: 'action',
    id: 'f-action',
    allowEmpty: false,
    options: [
      { value: 'block', label: '命中即拒绝', selected: true },
      { value: 'log', label: '命中只记日志' },
    ],
  })
  assert.match(html, /^<select class="input" id="f-action" name="action" data-tom-select>/)
  assert.match(html, /<option value="block" selected>命中即拒绝<\/option>/)
  assert.match(html, /<option value="log">命中只记日志<\/option>/)
  // 恰好一个 selected（浏览器取第一个 selected，多写就是两个源）
  assert.equal(html.match(/ selected/g)?.length, 1)
})

test('下拉：默认可留空，且空首项只在没有选项被选中时才占选中态', () => {
  const withPlaceholder = renderSelect({
    name: 'targetType',
    placeholder: '全部目标',
    options: [{ value: 'user', label: '用户' }],
  })
  assert.match(withPlaceholder, /<option value="" selected>全部目标<\/option>/)

  // 已有选中项时，空首项不能再抢选中态
  const picked = renderSelect({
    name: 'targetType',
    placeholder: '全部目标',
    options: [{ value: 'user', label: '用户', selected: true }],
  })
  assert.match(picked, /<option value="">全部目标<\/option>/)
  assert.match(picked, /<option value="user" selected>用户<\/option>/)
  assert.equal(picked.match(/ selected/g)?.length, 1)
})

test('下拉：不给 placeholder 时空首项的文本为空（筛选器「全部」的极简形态）', () => {
  const html = renderSelect({ name: 'x', options: [{ value: 'a', label: 'A' }] })
  assert.match(html, /<option value="" selected><\/option>/)
})

test('下拉：选项文本一律转义，塞不进真标签', () => {
  const html = renderSelect({
    name: 'x',
    allowEmpty: false,
    options: [{ value: '<b>', label: '<script>alert(1)</script>' }],
  })
  assert.ok(!html.includes('<script>'), '选项文本没转义')
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  // 属性值里的引号也要转义，否则会提前闭合 value
  assert.match(html, /value="&quot;|value="&#34;|value="&lt;b&gt;"/)
})

test('下拉：renderSelectShell 原样保留 optionsHtml（动态拼接的场景）', () => {
  const html = renderSelectShell({
    name: 'op',
    id: 'f-op',
    optionsHtml: '<option value="update">改字段</option>',
    className: 'input--tight',
    ariaLabel: '动作',
  })
  assert.match(html, /<option value="update">改字段<\/option>/)
  assert.match(html, /class="input input--tight"/)
  assert.match(html, /aria-label="动作"/)
  assert.match(html, /data-tom-select/)
})

// ─────────────────────── 日期 ───────────────────────

test('日期：输出原生 date 输入 + 升级钩子，值格式 YYYY-MM-DD', () => {
  const html = renderDatePicker({ name: 'from', value: '2026-10-30', ariaLabel: '起始日期' })
  assert.match(html, /<input class="input" type="date" name="from" value="2026-10-30" data-flatpickr aria-label="起始日期">/)
})

test('日期：空值不输出 value=""（否则浏览器会当成「有值的空字符串」）', () => {
  for (const value of [undefined, '']) {
    const html = renderDatePicker({ name: 'to', value })
    assert.ok(!html.includes('value='), `空值不该输出 value：${html}`)
    assert.match(html, /data-flatpickr/)
  }
})

test('日期：值也过转义', () => {
  const html = renderDatePicker({ name: 'to', value: '"><script>x</script>' })
  assert.ok(!html.includes('<script>'))
})

// ─────────────────────── 客户端升级脚本 ───────────────────────

test('客户端：两个钩子都有对应的升级代码，且升级是幂等的', () => {
  // 有钩子没脚本 = 控件永远升级不了（无声失败，和「写了内联样式被 CSP 丢掉」同类）。
  assert.match(CLIENT_JS, /select\[data-tom-select\]/)
  assert.match(CLIENT_JS, /input\[data-flatpickr\]/)
  // 幂等：htmx 局部刷新会重复调用，重复初始化会炸掉原控件
  assert.match(CLIENT_JS, /\.tomselect\)\s*continue/)
  assert.match(CLIENT_JS, /\._flatpickr\)\s*continue/)
})

test('客户端：单个控件失败不中断整页脚本', () => {
  // 升级是「锦上添花」，任一个控件抛错都不能让后面的控件和确认框一起停掉。
  const upgradeBlock = CLIENT_JS.slice(CLIENT_JS.indexOf('function upgradeControls'))
  assert.match(upgradeBlock, /try\s*\{/)
  assert.match(upgradeBlock, /catch/)
})

test('客户端：htmx 换入的内容也会被升级（第 4 条局部刷新的前提）', () => {
  assert.match(CLIENT_JS, /htmx:afterSwap['"],\s*upgradeControls/)
})

// ─────────────────────── 弹窗 ───────────────────────

test('弹窗：原生 dialog + 无默认外观的类，标题与关闭按钮都在', () => {
  const html = renderModal({ id: 'key-3', title: '编辑 API key', bodyHtml: '<form></form>' })
  assert.match(html, /^<dialog class="dialog dialog--modal" id="key-3" aria-labelledby="key-3-title" data-dialog-backdrop>/)
  assert.match(html, /<h2 class="dialog__title" id="key-3-title">编辑 API key<\/h2>/)
  assert.match(html, /data-dialog-close/)
  assert.match(html, /<form><\/form>/)
})

test('弹窗：宽档与底部操作区，标题转义', () => {
  const html = renderModal({
    id: 'm1',
    title: 'A & <B>',
    bodyHtml: '',
    footerHtml: '<button class="btn">保存</button>',
    size: 'full',
  })
  assert.match(html, /dialog--modal dialog--full/)
  assert.match(html, /<div class="dialog__actions dialog__actions--modal"><button class="btn">保存<\/button><\/div>/)
  assert.ok(!html.includes('<B>'), '标题没转义')
  assert.match(html, /A &amp; &lt;B&gt;/)
})

test('弹窗：没给底部就整块不出现（空 div 会留一条分隔线）', () => {
  const html = renderModal({ id: 'm2', title: 't', bodyHtml: '' })
  assert.ok(!html.includes('dialog__actions'))
})

test('弹窗：打开属性带前导空格（要能直接拼进属性位）', () => {
  assert.equal(dialogOpenAttr('key-3'), ' data-dialog-open="key-3"')
})

test('弹窗：CSS 只给外观，不给 display（display:none 是原生 dialog 的降级基础）', () => {
  // 原生 <dialog> 未打开时是 display:none —— 这正是「无 JS 时弹窗不可见」的原因，
  // 也是为什么弹窗不能承载唯一入口。这里守住「别把 display 改成 block」。
  assert.ok(MODAL_CSS.includes('.dialog--modal'))
  assert.ok(!/\.dialog--modal\s*\{[^}]*display\s*:\s*block/.test(MODAL_CSS))
})

test('客户端：弹窗开合是委托监听，且 backdrop 只认 dialog 元素本身', () => {
  assert.match(CLIENT_JS, /data-dialog-open/)
  assert.match(CLIENT_JS, /showModal\(\)/)
  assert.match(CLIENT_JS, /data-dialog-close/)
  // 点正文里的元素也会冒泡到 document，必须靠 target.tagName === 'DIALOG' 区分
  assert.match(CLIENT_JS, /target\.tagName !== 'DIALOG'/)
})

test('客户端：打开弹窗后把焦点放到第一个输入框', () => {
  // 否则浏览器把焦点给「关闭」按钮，弹窗一开就是一圈焦点环，像是按钮坏了。
  assert.match(CLIENT_JS, /\.dialog__body--modal input\.input/)
})

// ─────────────────────── vendor 主题 ───────────────────────

test('vendor 主题：必须自己补 .ts-hidden-accessible（库里没有这条规则）', () => {
  // 实测：Tom Select 的 min.css 里**没有** .ts-hidden-accessible 的定义，
  // 只是给原始 <select> 加了这个类名。少了它原生下拉和 .ts-wrapper 会一起显示
  // （表现为同一行出现两个「全部动作」、控件比同排输入框高一截）。
  assert.ok(VENDOR_THEME_CSS.includes('.ts-hidden-accessible'))
  assert.match(VENDOR_THEME_CSS, /clip:\s*rect/)
})

test('客户端：Tom Select 升级后摘掉库抄到包装元素上的皮肤类', () => {
  // 库会把原生控件的 class 抄到 .ts-wrapper 上，于是 .input 与 .ts-control
  // 的边框内边距叠加，视觉上是「框里套框」。
  assert.match(CLIENT_JS, /wrapper\.classList\.remove\(['"]input['"]/)
})

test('客户端：日期升级时把原生 date 改成 text（否则日历图标与 flatpickr 叠一起）', () => {
  assert.match(CLIENT_JS, /input\.type === 'date'\)\s*input\.type = 'text'/)
})

test('客户端：弹窗里的日历要搬进 dialog（顶层），并自己重算坐标', () => {
  // <dialog> 打开后在 top layer，body 里的浮层会被 backdrop 盖住完全看不见；
  // 搬进 dialog 之后参照系变了，必须按视口重算 left/top，还要处理放不下时上翻。
  assert.match(CLIENT_JS, /closest\('dialog'\)/)
  assert.match(CLIENT_JS, /appendChild\(fp\.calendarContainer\)/)
  assert.match(CLIENT_JS, /hostBox\.top/)
  assert.match(CLIENT_JS, /window\.innerHeight/)
})
