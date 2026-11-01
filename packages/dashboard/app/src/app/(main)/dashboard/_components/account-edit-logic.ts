/**
 * 编辑上游账号的**纯逻辑**（不 import React / Next / UI，可单测）。
 *
 * 与 `account-create-logic.ts` 的复用关系：字段解析（模型名 / 模型映射 / 优先级 / Base URL）
 * 直接沿用那边的一批纯函数，**不复制第二套解析** —— 两套解析慢慢漂移是这类表单的典型事故。
 *
 * ## 三条来自服务端源码的规则
 *
 * 1. **`enabled` 与元数据是两条通道**：`PATCH /api/accounts/:id` 里 `enabled` 走
 *    `enable / disable`，与字段更新是**两笔独立审计**。所以这里把 `enabled` 单独返回，
 *    提交时分别发送（`patch` 里绝不出现 `enabled`）。
 * 2. **清空用 `null`，不是省略键**：服务端用 `Object.hasOwn` 判「给了没」——
 *    `null` = 清空为未声明，省略 = 不改。所以这里只把**真的变了**的字段放进 patch。
 * 3. **`label` 必填且 ≤ 200 字符**（`normalizeLabel`）；`priority` 是 0..1000 的整数。
 *
 * 空 != 不变：`email` 原来是 `"a@b"`、现在清空 → 发 `null`（真清空）；
 * 原来是 `null`、现在还是空 → **不发**（发了也只是多一条空审计）。
 */

import {
  parseBaseUrl,
  parseModelList,
  parseModelMap,
  parsePriority,
  type AccountProtocol,
} from "./account-create-logic";

/** 编辑表单要读的账号字段（`AccountViewLike` 的子集，避免逻辑文件依赖 api 类型）。 */
export interface AccountEditSource {
  readonly label: string;
  readonly email: string | null;
  readonly subject: string | null;
  readonly baseUrl: string | null;
  readonly protocol: string | null;
  readonly models: readonly string[] | null;
  readonly modelMap: Readonly<Record<string, string>> | null;
  readonly priority: number;
  /** 客户端指纹档案 id；`null` = 不伪装。 */
  readonly clientProfile: string | null;
  readonly enabled: boolean;
}

/** 编辑表单的草稿（全部是字符串，因为来自 `<input>`）。 */
export interface AccountEditDraft {
  label: string;
  email: string;
  subject: string;
  baseUrl: string;
  /** `""` = 同提供商默认（提交时发 `null`）。 */
  protocol: AccountProtocol | "";
  models: string;
  modelMap: string;
  priority: string;
  /** `""` = 不伪装（提交时发 `null`）。 */
  clientProfile: string;
  enabled: boolean;
}

/** 可改的元数据字段（`enabled` 不在这里，见文件头第 1 条）。 */
export interface AccountMetaPatch {
  label?: string;
  email?: string | null;
  subject?: string | null;
  baseUrl?: string | null;
  protocol?: string | null;
  models?: string[] | null;
  modelMap?: Record<string, string> | null;
  priority?: number;
  /** 客户端指纹档案 id；`null` = 清空（不伪装）。 */
  clientProfile?: string | null;
}

/** 一次编辑的结果：元数据补丁 + 启停（`null` = 没动）。 */
export interface AccountEditPlan {
  readonly patch: AccountMetaPatch;
  readonly enabled: boolean | null;
}

/** 字段的中文名（提示「改了哪些」用）。 */
const FIELD_LABELS: Readonly<Record<keyof AccountMetaPatch, string>> = {
  label: "名称",
  email: "邮箱",
  subject: "账号标识",
  baseUrl: "Base URL",
  protocol: "上游协议",
  models: "对外模型名",
  modelMap: "模型映射",
  priority: "优先级",
  clientProfile: "客户端档案",
};

const PROTOCOLS: readonly AccountProtocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
];

/** 账号 → 编辑草稿。`models` / `modelMap` 摊成多行文本，与服务端口径一致。 */
export function accountEditDraftOf(account: AccountEditSource): AccountEditDraft {
  const protocol = account.protocol;
  return {
    label: account.label,
    email: account.email ?? "",
    subject: account.subject ?? "",
    baseUrl: account.baseUrl ?? "",
    protocol:
      protocol !== null && (PROTOCOLS as readonly string[]).includes(protocol)
        ? (protocol as AccountProtocol)
        : "",
    models: (account.models ?? []).join("\n"),
    modelMap: Object.entries(account.modelMap ?? {})
      .map(([from, to]) => `${from}=${to}`)
      .join("\n"),
    priority: String(account.priority),
    clientProfile: account.clientProfile ?? "",
    enabled: account.enabled,
  };
}

/** 两个模型名数组是否等价（顺序无关：服务端只用来过滤候选，顺序没有语义）。 */
function sameList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((item, index) => item === b[index]);
}

/** 两个映射是否等价。 */
function sameMap(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const a = Object.entries(left).sort(([x], [y]) => x.localeCompare(y));
  const b = Object.entries(right).sort(([x], [y]) => x.localeCompare(y));
  if (a.length !== b.length) return false;
  return a.every(([key, value], index) => key === b[index]?.[0] && value === b[index]?.[1]);
}

/**
 * 草稿 + 原值 → 提交计划；非法返回 `"invalid"`（先在前端拦住，不发出坏请求）。
 *
 * **只把真的变了的字段放进 `patch`**：多发的字段会多记一条审计，
 * 而审计是给人看的，塞满「没改的字段」等于看不见真正改了什么。
 */
export function accountEditPlanOf(
  draft: AccountEditDraft,
  account: AccountEditSource,
): AccountEditPlan | "invalid" {
  const label = draft.label.trim();
  if (label === "" || label.length > 200) return "invalid";

  const priority = parsePriority(draft.priority);
  if (priority === "invalid") return "invalid";

  const baseUrl = parseBaseUrl(draft.baseUrl);
  if (baseUrl === "invalid") return "invalid";

  const modelMap = parseModelMap(draft.modelMap);
  if (modelMap === "invalid") return "invalid";

  const patch: AccountMetaPatch = {};

  if (label !== account.label) patch.label = label;

  const email = draft.email.trim();
  const emailValue = email === "" ? null : email;
  if (emailValue !== (account.email ?? null)) patch.email = emailValue;

  const subject = draft.subject.trim();
  const subjectValue = subject === "" ? null : subject;
  if (subjectValue !== (account.subject ?? null)) patch.subject = subjectValue;

  const baseUrlValue = baseUrl === "" ? null : baseUrl;
  if (baseUrlValue !== (account.baseUrl ?? null)) patch.baseUrl = baseUrlValue;

  const protocolValue: string | null = draft.protocol === "" ? null : draft.protocol;
  if (protocolValue !== (account.protocol ?? null)) patch.protocol = protocolValue;

  // 模型名与映射：空文本 = 清空（发 null）；与原值等价 = 不发。
  const models = parseModelList(draft.models);
  const currentModels = account.models ?? [];
  if (models.length === 0 && currentModels.length > 0) patch.models = null;
  else if (models.length > 0 && !sameList(models, currentModels)) patch.models = models;

  const currentMap = account.modelMap ?? {};
  if (Object.keys(modelMap).length === 0 && Object.keys(currentMap).length > 0) {
    patch.modelMap = null;
  } else if (
    Object.keys(modelMap).length > 0 &&
    !sameMap(modelMap, currentMap)
  ) {
    patch.modelMap = modelMap;
  }

  if (priority !== account.priority) patch.priority = priority;

  // 客户端档案：`""` = 不伪装（发 null）；没变就不发（少一条空审计）。
  const clientProfileValue: string | null = draft.clientProfile === "" ? null : draft.clientProfile;
  if (clientProfileValue !== (account.clientProfile ?? null)) patch.clientProfile = clientProfileValue;

  return { patch, enabled: draft.enabled === account.enabled ? null : draft.enabled };
}

/** 一次编辑里「真的要变」的字段中文名（给 toast / 结果提示用）。 */
export function changedFieldLabels(plan: AccountEditPlan): string[] {
  const labels = (Object.keys(plan.patch) as (keyof AccountMetaPatch)[]).map(
    (field) => FIELD_LABELS[field],
  );
  if (plan.enabled !== null) labels.push(plan.enabled ? "启用" : "停用");
  return labels;
}

/** 提交计划是不是「什么都没改」。 */
export function isNoopPlan(plan: AccountEditPlan): boolean {
  return Object.keys(plan.patch).length === 0 && plan.enabled === null;
}

/** 草稿的字段级错误提示（给用户看的人话）。 */
export function accountEditError(draft: AccountEditDraft): string | null {
  if (draft.label.trim() === "") return "名称不能为空";
  if (draft.label.trim().length > 200) return "名称最长 200 个字符";
  if (parsePriority(draft.priority) === "invalid") return "优先级要填 0..1000 的整数";
  if (parseBaseUrl(draft.baseUrl) === "invalid") return "Base URL 要填 http(s) 开头的合法地址";
  if (parseModelMap(draft.modelMap) === "invalid") {
    return "模型映射每行要写成「对外名=上游名」";
  }
  return null;
}
