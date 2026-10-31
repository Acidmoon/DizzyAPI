/**
 * 饼图的**纯逻辑**：把服务端给的分组算成扇区与占比。
 *
 * **截断与「其他」归并在服务端做**（`packages/usage/src/breakdown.ts` 的 `topWithOther`）：
 * 服务端最多给 12 项（含「其他」），前端**不再截断** —— 否则会把服务端的「其他」
 * 再并一次，出现「其他 · 其他」。这条是 2026-10-31 与 `总工` 对齐的口径：
 * 归并只有一处实现，两边吃同一份数据。
 *
 * 为什么这个文件单独存在：
 * - 这是**金额算术**，硬边界是「整数微元、禁止浮点」。占比用 `bigint` 整数除法（万分比），
 *   展示时才转百分比字符串。
 * - 可被 node 测试逐字断言（`packages/dashboard/test/usage-pie.test.ts`），
 *   recharts 组件要真浏览器才测得准，两者不该混在一个文件里。
 */

/** 一项分组（模型 / API key / 用户都有 token 与费用）。 */
export interface PieGroup {
  /** 展示名。 */
  readonly label: string;
  /** 精确费用（整数微元的十进制字符串）。 */
  readonly costMicros: string;
  readonly tokens: number;
  readonly requests: number;
  /** 服务端标了这是尾部归并出来的「其他」。 */
  readonly other?: boolean;
}

/** 一个扇区。 */
export interface PieSlice {
  readonly label: string;
  readonly costMicros: string;
  readonly tokens: number;
  readonly requests: number;
  /** 占比，万分比整数（0..10000）。 */
  readonly share: number;
  /** 是否是「其他」。 */
  readonly other: boolean;
  /** 扇区配色（CSS 变量，随主题变）。 */
  readonly color: string;
}

/** 「其他」的展示名（服务端已经用它做 `label`，这里只做兜底）。 */
export const OTHER_LABEL = '其他';

/** 占比口径：按 token 总量，还是按费用。 */
export type PieMeasure = 'tokens' | 'cost';

/**
 * 占比的**分母**只要这两个字段。
 *
 * 服务端给的分母是 `totals`（形状 `UsageTotalsView`：requests / tokens / 四桶 / 费用），
 * 它**没有 `label`** —— 所以这里不能要求 `PieGroup`，否则调用方被迫给整份汇总编一个假名字。
 * `PieGroup` 结构上包含这两个字段，可以直接传。
 */
export interface PieTotal {
  /** 精确费用（整数微元的十进制字符串）。 */
  readonly costMicros: string;
  readonly tokens: number;
}

/**
 * 扇区配色：只用主题里的 `--chart-N`（**不硬编码颜色**，随浅色 / 深色变）。
 *
 * 只有 5 个主题色，而饼图最多 12 项，所以循环用；图例里带名字与占比，
 * 同色不会导致误读（这和「硬编码 12 个十六进制颜色」不同：后者在深色下会糊）。
 */
export const PIE_COLORS: readonly string[] = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];

/** 把十进制微元字符串解析成 bigint；非法值当 0（不炸页面）。 */
export function microsOf(value: string | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  const text = value.trim();
  if (!/^-?\d+$/.test(text)) return 0n;
  try {
    return BigInt(text);
  } catch {
    return 0n;
  }
}

/** 费用绝对值（费用不该为负，防御坏数据）。 */
function absMicros(value: string): bigint {
  const parsed = microsOf(value);
  return parsed < 0n ? -parsed : parsed;
}

/** 一份分组在指定口径下的度量值。 */
export function measureOf(group: PieTotal, measure: PieMeasure): bigint {
  return measure === 'cost' ? absMicros(group.costMicros) : BigInt(Math.max(group.tokens, 0));
}

/**
 * 分组 → 扇区（含占比）。
 *
 * `total` 是**服务端 totals 的同口径度量**：列表可能有上限，用列表之和当分母会让
 * 占比偷偷凑成 100%，实际却不是。不传则退化成列表之和（只适合「列表即全量」的场景）。
 */
export function toPieSlices(
  groups: readonly PieGroup[],
  measure: PieMeasure = 'tokens',
  total?: PieTotal,
): readonly PieSlice[] {
  const usable = groups
    .filter((group) => group.label !== "" && measureOf(group, measure) > 0n)
    // 展示顺序按度量从大到小（扇区与图例一致）；同值按名字，保证渲染稳定不闪。
    .sort((a, b) => {
      const left = measureOf(a, measure);
      const right = measureOf(b, measure);
      if (left === right) return a.label.localeCompare(b.label);
      return left > right ? -1 : 1;
    });
  if (usable.length === 0) return [];

  const measured = usable.reduce((sum, group) => sum + measureOf(group, measure), 0n);
  const denominator = total === undefined ? measured : measureOf(total, measure);
  if (denominator === 0n) {
    return usable.map((group, index) => ({
      ...toSlice(group, index),
      share: 0,
    }));
  }

  // 分母比列表之和大 = 列表被截断（服务端只给了前若干项）。
  // 这时**末项不能吃掉余数**：那会把「只占 10% 的一项」显示成 100%。
  const truncated = measured < denominator;

  // 逐项整数除法；列表完整时最后一项吃掉余数，保证合计正好 10000（不靠四舍五入凑）。
  let assigned = 0;
  return usable.map((group, index) => {
    const isLast = index === usable.length - 1 && !truncated;
    const raw = Number((measureOf(group, measure) * 10_000n) / denominator);
    const share = isLast ? Math.max(10000 - assigned, 0) : Math.max(raw, 0);
    assigned += share;
    return { ...toSlice(group, index), share };
  });
}

function toSlice(group: PieGroup, index: number): PieSlice {
  return {
    label: group.label,
    costMicros: group.costMicros,
    tokens: group.tokens,
    requests: group.requests,
    share: 0,
    other: group.other === true,
    color: PIE_COLORS[index % PIE_COLORS.length] as string,
  };
}

/** 占比（万分比）→ 百分比字符串（带一位小数）。 */
export function shareText(share: number): string {
  return `${(share / 100).toFixed(1)}%`;
}

/**
 * 这一项能不能当**筛选值 / 联动目标**？
 *
 * 「其他」是服务端把尾部多项归并出来的统计项，对应不到真实的模型名 / key id / 用户 id。
 * 拿它当筛选值有两种坏结果，都是「看着有反应、其实没数据」：
 * - 按模型：`model='其他'` 一条都查不到（模型名里根本没有这一项）；
 * - 按 key：`apiKeyId=''` 会把筛选静默清空（用户以为点了没生效）。
 *
 * 所以筛选下拉与饼图点选都只用 `isSelectable` 过滤，展示仍然照画（扇区和图例都要有它）。
 */
export function isSelectable(item: { readonly other?: boolean }): boolean {
  return item.other !== true;
}

