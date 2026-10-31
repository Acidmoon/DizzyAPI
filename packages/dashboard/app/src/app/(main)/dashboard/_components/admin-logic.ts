/**
 * 管理台页面的**纯逻辑**（不 import React / Next / UI 组件）。
 *
 * 为什么单独一个文件：
 * 1. 仓库根的 `pnpm test`（`node --import tsx --test`）跑在**没有 React** 的环境里，
 *    直接 import `.tsx` 会在 `import * as React` 那一行就崩——所以可测的逻辑必须与渲染分离。
 * 2. 金额与并发上限的换算是最容易写错、错了最贵的一段（浮点、超 2^53、负号方向），
 *    它必须能被单测逐字钉住。
 *
 * 纪律（与 `@/lib/format` 一致）：
 * - 金额一律**字符串 / BigInt** 运算，`Number` 一次都不用。
 * - 「不限」是 `null`，不是 `0`：0 在服务端是非法值。
 * - 非法输入返回 `null` / `"invalid"`，不猜、不静默取 0。
 */

/** 用户可改的角色（与服务端 `PATCH /api/users/:id` 的枚举一致）。 */
export type UserRole = "admin" | "user";

/** 用户可改的状态（与 `UserStatusLike` 一致）。 */
export type UserStatus = "enabled" | "banned";

/** 角色 → 人话。**未知值原样返回**：宁可露出英文码，也不要显示成「普通用户」。 */
export function roleLabel(role: string): string {
  if (role === "admin") return "管理员";
  if (role === "user") return "普通用户";
  return role;
}

/** 状态 → 人话。同样不猜未知值。 */
export function statusLabel(status: string): string {
  if (status === "enabled") return "启用";
  if (status === "banned") return "封禁";
  return status;
}

/**
 * 账号状态 → 人话。
 *
 * `enabled` 与 `status` 是**两件事**：人手停用是 `enabled=false`（不管 status 是什么），
 * 系统自动停用才是 `status=auto_disabled`。两者互不覆盖，所以这里先判 `enabled`。
 */
export function accountStateLabel(enabled: boolean, status: string): string {
  if (!enabled) return "人为停用";
  if (status === "auto_disabled") return "系统自动停用";
  if (status === "needs_reauth") return "待重新授权";
  if (status === "active") return "可用";
  if (status === "error") return "异常";
  return status;
}

/**
 * 并发上限输入 → `number | null | "invalid"`。
 *
 * - 空串 = **不限**（`null`），不是 0；
 * - 只接受正整数，`0` / 负数 / 小数 / 带空格以外的字符都算非法；
 * - 超过 `Number.MAX_SAFE_INTEGER` 也算非法（服务端存的是整数）。
 */
export function parseConcurrencyLimit(text: string): number | null | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return "invalid";
  return value;
}

/**
 * 「元」的十进制字符串 → 微元十进制字符串（**字符串拼接，不经浮点**）。
 *
 * - `"10"` → `"10000000"`
 * - `"0.5"` → `"500000"`
 * - `"0.000001"` → `"1"`
 * - 非法（负数 / 多于 6 位小数 / 空 / 非数字）→ `null`，**不猜**。
 *
 * 只接受正数：方向（增加 / 扣减）由调用方用独立按钮决定，避免用户漏输负号变成反向操作。
 */
export function yuanTextToMicros(text: string): string | null {
  const trimmed = text.trim();
  const match = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(trimmed);
  if (match === null) return null;
  const whole = match[1] as string;
  const fraction = (match[2] ?? "").padEnd(6, "0");
  const combined = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

/** 取负（BigInt，不丢精度）。`"0"` 仍是 `"0"`。 */
export function negateMicros(micros: string): string {
  const value = BigInt(micros);
  return (value === 0n ? 0n : -value).toString();
}

/** 余额调整的最终 delta（方向 + 金额）。金额非法或为 0 时返回 `null`。 */
export function balanceDelta(direction: "add" | "subtract", yuanText: string): string | null {
  const micros = yuanTextToMicros(yuanText);
  if (micros === null) return null;
  if (BigInt(micros) === 0n) return null;
  return direction === "add" ? micros : negateMicros(micros);
}

// ───────────────────────────── 日期范围（毫秒区间）─────────────────────────────

const DAY_MS = 86_400_000

/**
 * `YYYY-MM-DD` → 当天零点（**UTC**）的毫秒时间戳。
 *
 * 为什么用 UTC 而不是本地时区：审计服务的时间窗是毫秒时间戳，SSR 旧版页面
 * （`packages/web/src/pages/admin_audit.ts`）也是按 UTC 切天的，两边口径必须一致，
 * 否则同一条记录在两个页面上会落在不同的天里。
 *
 * 非法日期返回 `null`（不猜、不取 0）。
 */
export function utcDayStartMs(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  // `Date.UTC(2026, 1, 30)` 会滚到 3 月 2 日；这里要的是「这个日子不存在就判非法」。
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return ms;
}

/**
 * 日期范围 → 审计接口要的毫秒区间。
 *
 * - 结束日**含当天**，所以右端是「当天零点 + 1 天」；
 * - 服务端的区间是**左闭右开** `[fromMs, toMs)`；
 * - 空串 = 不限（返回 `undefined`，调用方就不带这个键）；
 * - 非法日期按「不限」处理，但 `from > to` 时返回 `null`（区间反了，要报错而不是静默查空）。
 */
export function dateRangeMs(
  from: string,
  to: string,
): { readonly fromMs?: number; readonly toMs?: number } | null {
  const range: { fromMs?: number; toMs?: number } = {};
  if (from.trim() !== "") {
    const fromMs = utcDayStartMs(from);
    if (fromMs === null) return null;
    range.fromMs = fromMs;
  }
  if (to.trim() !== "") {
    const toMs = utcDayStartMs(to);
    if (toMs === null) return null;
    range.toMs = toMs + DAY_MS;
  }
  if (range.fromMs !== undefined && range.toMs !== undefined && range.fromMs >= range.toMs) {
    return null;
  }
  return range;
}

// ───────────────────────────── 结算状态 ─────────────────────────────

/**
 * 结算状态 → 人话（来源：`packages/billing/src/types.ts` 的 `SettleStatus`）。
 *
 * **未知值原样返回**：结算状态机以后加新状态时，页面不能把新状态显示成空。
 */
export function settleStatusLabel(status: string): string {
  if (status === "pending") return "待结算";
  if (status === "settling") return "结算中";
  if (status === "settled") return "已结算";
  if (status === "no-price") return "无价格";
  if (status === "no-user") return "无用户";
  if (status === "failed") return "失败";
  if (status === "review") return "待核查";
  return status;
}

/**
 * 结算状态是不是「需要人看一眼」的。
 *
 * `problem` 筛选（服务端一次拿到失败 / 待核查 / 结算中残留）就是按这个集合划的，
 * 页面上的「待处理」指标卡也用它——两处口径必须一致，否则数字对不上。
 */
export function isProblemSettleStatus(status: string): boolean {
  return status === "failed" || status === "review" || status === "settling";
}


// ───────────────────────────── 数据源健康度与告警 ─────────────────────────────

/**
 * 数据源健康度 → 人话（`ok` / `degraded` / `unavailable`）。
 *
 * `degraded` 与 `unavailable` 必须分开说：`degraded` 是「这一块的数据不全」，
 * `unavailable` 是「这一块整块读不到」——运维处置方式不同。
 */
export function sourceHealthLabel(state: string): string {
  if (state === "ok") return "正常";
  if (state === "degraded") return "降级";
  if (state === "unavailable") return "不可用";
  return state;
}

/**
 * 运维告警码 → 人话（来源：`packages/observability/src/service.ts` 的 `warningsOf`）。
 *
 * 告警码是**稳定英文码**（页面据此高亮），中文标签只是给人看的；
 * 没映射的码原样返回——宁可露出英文码，也不要让人以为「这条没事」。
 */
export function warningLabel(code: string): string {
  if (code === "USAGE_GAP") return "用量链路有缺口（记录被跳过）";
  if (code === "USAGE_POLL_FAILING") return "用量轮询连续失败";
  if (code === "USAGE_REJECTED_PENDING") return "有被隔离的用量待处理";
  if (code === "USAGE_RING_DROPPED") return "Go 环形缓冲丢过记录";
  if (code === "BILLING_REVIEW") return "有结算待人工核查";
  if (code === "BILLING_FAILED") return "有结算失败";
  if (code === "BILLING_OVERDRAWN") return "有账户透支";
  if (code === "QUOTA_SNAPSHOT_STALE") return "余额快照已过期";
  if (code === "ACCOUNTS_COOLING") return "有账号正在冷却";
  if (code === "AUDIT_FAILED_ACTIONS") return "有失败的管理操作";
  if (code === "ACCOUNTS_UNHEALTHY") return "有账号健康异常";
  if (code === "ACCOUNTS_AUTO_DISABLED") return "有账号被系统自动停用";
  return code;
}

/**
 * 用户编辑弹窗要提交的 patch：**只放真正改了的字段**。
 *
 * 服务端按字段逐项 diff、逐项写审计；把没改的字段也发过去会让审计里多出
 * 一堆「把 X 改成 X」的噪声。
 */
export interface UserPatch {
  name?: string;
  role?: UserRole;
  status?: UserStatus;
  balanceEnabled?: boolean;
  concurrencyLimit?: number | null;
}

export interface UserDraftLike {
  readonly name: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly balanceEnabled: boolean;
  readonly concurrency: string;
}

export interface UserBeforeLike {
  readonly name: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly balanceEnabled: boolean;
  readonly concurrencyLimit: number | null;
}

/** 算出 patch；并发上限非法返回 `"invalid"`，什么都没改返回 `{}`。 */
export function userPatchOf(draft: UserDraftLike, before: UserBeforeLike): UserPatch | "invalid" {
  const concurrency = parseConcurrencyLimit(draft.concurrency);
  if (concurrency === "invalid") return "invalid";
  const trimmedName = draft.name.trim();
  if (trimmedName === "") return "invalid";
  const patch: UserPatch = {};
  if (trimmedName !== before.name) patch.name = trimmedName;
  if (draft.role !== before.role) patch.role = draft.role;
  if (draft.status !== before.status) patch.status = draft.status;
  if (draft.balanceEnabled !== before.balanceEnabled) patch.balanceEnabled = draft.balanceEnabled;
  if (concurrency !== before.concurrencyLimit) patch.concurrencyLimit = concurrency;
  return patch;
}
