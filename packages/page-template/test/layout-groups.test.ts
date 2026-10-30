/**
 * 布局层级组件（指标分组 / 分组键值对）的用例。
 *
 * 这两个组件是 owner 三条抱怨的直接落地：
 * - 「卡片并列你也没并列明白」→ 指标分组 + 主指标标记；
 * - 「详情页所有的都是一行然后按照行排列」→ 分组键值对（`<dl>`，不是表格）；
 * - 「全站用量这些指标全部挤在一起」→ `.metric-grid` 等宽等高网格（不是一排 flex）。
 *
 * 用例只盯「结构真的分了组、主次真的有标记、动态文本真的转义」这三件事，
 * 具体像素（间距 / 颜色）由 CSS 负责，不在这里断言。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderKeyValueGroups, renderMetricGroups } from '../src/index.ts'

test('指标分组：组标题 + 组内网格 + 主指标标记', () => {
  const html = renderMetricGroups([
    {
      title: '今日',
      note: '本地时区',
      cards: [
        { label: '今日费用', value: '¥0.23', unit: 'CNY', emphasis: 'primary' },
        { label: '今日请求', value: '5' },
      ],
    },
    { title: '累计', cards: [{ label: '累计请求', value: '12' }] },
  ])
  assert.ok(html.startsWith('<div class="metric-groups">'))
  assert.ok(html.includes('<h2 class="metric-group-title">今日</h2>'))
  assert.ok(html.includes('<span class="metric-group-note">本地时区</span>'))
  // 两组 = 两个 section；组内是 .metric-grid（网格，等宽等高），不是一排 flex。
  assert.equal(html.split('<section class="metric-group">').length - 1, 2)
  assert.ok(html.includes('<div class="metric-grid">'))
  // 主指标有修饰类（数字更大 + 强调色），次级指标没有。
  assert.ok(html.includes('class="card card--primary card--metric"'))
  assert.equal((html.match(/class="card card--metric"/g) ?? []).length, 2)
  assert.match(html, /<span class="card-label">今日请求<\/span><\/div>\s*<div class="card-value-row">/)
})

test('指标分组：标题 / 说明 / 标签 / 数值全部转义', () => {
  const html = renderMetricGroups([
    { title: '<b>今日</b>', note: '<i>n</i>', cards: [{ label: '<script>x</script>', value: '<i>1</i>' }] },
  ])
  assert.ok(!html.includes('<b>今日</b>'))
  assert.ok(!html.includes('<i>n</i>'))
  assert.ok(!html.includes('<script>x</script>'))
  assert.ok(!html.includes('<i>1</i>'))
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'))
})

test('指标分组：空数组不渲染空壳', () => {
  assert.equal(renderMetricGroups([]), '')
})

test('键值分组：小节 + 定义列表 + 等宽值', () => {
  const html = renderKeyValueGroups([
    {
      title: '请求',
      items: [
        { label: '请求 ID', value: 'req-1', mono: true },
        { label: '状态', value: '200' },
      ],
    },
    { title: '费用', items: [{ label: '金额', value: '¥2.00 CNY' }] },
  ])
  assert.ok(html.startsWith('<div class="kv-groups">'))
  assert.ok(html.includes('<h3 class="kv-group-title">请求</h3>'))
  // 键值对用 dl/dt/dd（定义列表），不是「字段 / 值」表格 —— 这是 owner 那条抱怨的落点。
  assert.ok(html.includes('<dl class="kv-list">'))
  assert.ok(!html.includes('<table'))
  assert.ok(html.includes('<dt class="kv-key">请求 ID</dt><dd class="kv-value kv-value--mono">req-1</dd>'))
  assert.ok(html.includes('<dd class="kv-value">200</dd>'))
})

test('键值分组：没有 title 时不渲染小节标题（外层已有区块标题时用）', () => {
  const html = renderKeyValueGroups([{ items: [{ label: '项目', value: '值' }] }])
  assert.ok(!html.includes('kv-group-title'))
  assert.ok(html.includes('<dt class="kv-key">项目</dt><dd class="kv-value">值</dd>'))
})

test('键值分组：label 由组件转义；值按约定是「已渲染 HTML」不再二次转义', () => {
  const html = renderKeyValueGroups([
    { items: [{ label: '<b>x</b>', value: '<span class="badge">ok</span>' }] },
  ])
  assert.ok(!html.includes('<b>x</b>'))
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'))
  // 二次转义会把徽标变字面量，所以值原样输出（与 renderTable 的单元格同一约定）。
  assert.ok(html.includes('<span class="badge">ok</span>'))
})
