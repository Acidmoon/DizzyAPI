/**
 * 指标分组：把「一堆并列的卡片」改成「有主次的几组」。
 *
 * owner 的原话：「前端 UI 全是并列的卡片，卡片并列你也没并列明白；全站用量这些指标
 * 全部挤在一起，谁能看得清楚？」。改法只有两条：
 *
 * 1. **分组**：每一组有自己的小标题 + 网格（例如「今日」「累计」「坏记录隔离」）。
 *    组内用 grid（天然等宽等高），组与组之间留 24px，一眼能看出这是三件事。
 * 2. **主次**：组里可以指定一张**主指标**卡（`StatCard.emphasis = 'primary'`），
 *    它的数字更大、带强调色；其余是次级指标，数字小一号。
 *
 * 为什么单独一个文件：`shell.ts` 装的是「卡片 / 表格 / 表单」这些**零件**，
 * 这里是「零件怎么摆、谁更重」的**布局层级**，改动理由不同，放一起会互相牵制。
 */
import { escapeText } from './escape.ts'
import { statCardHtml, type StatCard } from './shell.ts'

/** 一组指标：小标题 + 若干卡片。 */
export interface MetricGroup {
  /** 组标题（例如「今日」）。省略 = 不渲染标题行（单组场景）。 */
  readonly title?: string
  /** 标题右侧的补充说明（时区、口径这类），省略不渲染。 */
  readonly note?: string
  readonly cards: readonly StatCard[]
}

/**
 * 渲染分组的指标区。
 *
 * 输出结构（组标题是 `h2`，与页面里其它 `.section-title` 同级）：
 *
 * ```
 * <div class="metric-groups">
 *   <section class="metric-group">
 *     <div class="metric-group-head"><h2 class="metric-group-title">今日</h2></div>
 *     <div class="metric-grid">…卡片…</div>
 *   </section>
 * </div>
 * ```
 */
export function renderMetricGroups(groups: readonly MetricGroup[]): string {
  if (groups.length === 0) return ''
  const blocks = groups.map((group) => {
    const head = group.title === undefined
      ? ''
      : `<div class="metric-group-head"><h2 class="metric-group-title">${escapeText(group.title)}</h2>${
        group.note === undefined ? '' : `<span class="metric-group-note">${escapeText(group.note)}</span>`
      }</div>`
    // 卡片 DOM 与 `renderStatCards` 共用同一份（`statCardHtml`），只多一个用途类。
    const cards = group.cards.map((card) => statCardHtml(card, ' card--metric')).join('\n')
    return `<section class="metric-group">
${head}
<div class="metric-grid">
${cards}
</div>
</section>`
  }).join('\n')
  return `<div class="metric-groups">
${blocks}
</div>`
}
