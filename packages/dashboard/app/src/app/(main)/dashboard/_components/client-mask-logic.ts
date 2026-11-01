/**
 * 客户端指纹档案的**纯逻辑**（不 import React / Next / UI，可单测）。
 *
 * ## 为什么这里有一套「和插件重复」的校验
 *
 * 真正说了算的是服务端（`packages/client-mask/src/template.ts`），它会把不合法的一律拒掉。
 * 前端这套只为**别让人白填**：受保护头、陌生占位符、像秘密的值，在输入时就给出人话提示。
 * 规则与插件**逐条对齐**（下面每个常量的注释都标了服务端出处），并由用例钉住两边一致。
 *
 * ## 三条最容易错的
 *
 * 1. **受保护头不许出现在档案里**（鉴权 / Host / Accept / Content-Type / UA / Cookie）：
 *    UA 有专用字段，用头重复声明会和 `userAgent` 打架；
 * 2. **值里只允许三个占位符**：多写一个 `{{token}}` 就等于开了「模板取秘密」的口子；
 * 3. **头值不许有控制字符**：`\r\n` 就是 HTTP 头注入。
 */

/** 允许的三个占位符（服务端 `ALLOWED_PLACEHOLDERS`）。 */
export const PLACEHOLDER_UUID = "{{uuid}}";
export const PLACEHOLDER_SESSION = "{{session}}";
export const PLACEHOLDER_TIMESTAMP = "{{timestamp}}";

export const ALLOWED_PLACEHOLDERS: readonly string[] = [
  PLACEHOLDER_UUID,
  PLACEHOLDER_SESSION,
  PLACEHOLDER_TIMESTAMP,
];

/**
 * 受保护的请求头（服务端 `PROTECTED_HEADERS`，Go 侧再校验一遍）。
 * 列表顺序与插件一致，便于对照。
 */
export const PROTECTED_HEADERS: readonly string[] = [
  "content-type",
  "content-length",
  "accept",
  "accept-encoding",
  "transfer-encoding",
  "host",
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "user-agent",
  "cookie",
  "set-cookie",
];

/** 服务端 `MAX_HEADERS_PER_PROFILE`。 */
export const MAX_HEADERS_PER_PROFILE = 24;
/** 服务端 `MAX_HEADER_NAME_BYTES` / `MAX_HEADER_VALUE_BYTES` / `MAX_PROFILE_ID_BYTES`。 */
const MAX_HEADER_NAME_BYTES = 128;
const MAX_HEADER_VALUE_BYTES = 512;
const MAX_PROFILE_ID_BYTES = 64;

/** HTTP token（RFC 7230 §3.2.6），与服务端 `TOKEN_PATTERN` 逐字一致。 */
const TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** 「像秘密」的形状（服务端 `SECRET_LIKE`）。宁可误拒，也不让秘密进档案。 */
const SECRET_LIKE: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /sk-[A-Za-z0-9_-]{8,}/, what: "API key（sk-…）" },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i, what: "Bearer 令牌" },
  { pattern: /gh[pousr]_[A-Za-z0-9]{16,}/, what: "GitHub 令牌" },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/, what: "GitHub 细粒度令牌" },
  { pattern: /AKIA[0-9A-Z]{16}/, what: "AWS access key" },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/, what: "Slack 令牌" },
  { pattern: /AIza[0-9A-Za-z_-]{30,}/, what: "Google API key" },
];

/** 字节数（浏览器与 node 都有的口径，别用 Buffer）。 */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** 一个头（草稿态：值都是字符串，来自 `<input>`）。 */
export interface ClientHeaderDraft {
  name: string;
  value: string;
}

/** 档案草稿。 */
export interface ClientDraft {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  userAgent: string;
  headers: ClientHeaderDraft[];
}

/** 从服务端档案造草稿。 */
export function clientDraftOf(profile: {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly userAgent: string | null;
  readonly headers: readonly { readonly name: string; readonly value: string }[];
}): ClientDraft {
  return {
    id: profile.id,
    label: profile.label,
    description: profile.description ?? "",
    enabled: profile.enabled,
    userAgent: profile.userAgent ?? "",
    headers: profile.headers.map((header) => ({ name: header.name, value: header.value })),
  };
}

/** 新建时的空草稿。 */
export function emptyClientDraft(): ClientDraft {
  return { id: "", label: "", description: "", enabled: true, userAgent: "", headers: [] };
}

// ───────────────────────────── 校验（与服务端逐条对齐） ─────────────────────────────

/** 档案 id：小写字母 / 数字 / 连字符 / 下划线，字母或数字开头（服务端 `validateProfileId`）。 */
export function clientProfileIdError(id: string): string | null {
  if (id.trim() === "") return "档案 id 不能为空";
  if (byteLength(id) > MAX_PROFILE_ID_BYTES) return `档案 id 太长（上限 ${String(MAX_PROFILE_ID_BYTES)} 字节）`;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    return "档案 id 只能用小写字母 / 数字 / 连字符 / 下划线，并且以字母或数字开头";
  }
  return null;
}

/** 头名（服务端 `validateHeaderName`）。 */
export function clientHeaderNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "头名不能为空";
  if (byteLength(trimmed) > MAX_HEADER_NAME_BYTES) return `头名太长（上限 ${String(MAX_HEADER_NAME_BYTES)} 字节）`;
  if (!TOKEN_PATTERN.test(trimmed)) return `头名含非法字符：${trimmed}`;
  if (PROTECTED_HEADERS.includes(trimmed.toLowerCase())) {
    return `头 ${trimmed} 由网关自己决定，档案不许覆盖`;
  }
  return null;
}

/** 头值（服务端 `validateHeaderValue`）。 */
export function clientHeaderValueError(value: string): string | null {
  if (byteLength(value) > MAX_HEADER_VALUE_BYTES) return `头值太长（上限 ${String(MAX_HEADER_VALUE_BYTES)} 字节）`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return "头值不能含控制字符（换行会导致头注入）";
  const leftovers = value.replace(/\{\{(uuid|session|timestamp)\}\}/g, "");
  if (leftovers.includes("{{") || leftovers.includes("}}")) {
    return `头值里有不认识的占位符（只允许 ${ALLOWED_PLACEHOLDERS.join(" / ")}）`;
  }
  for (const rule of SECRET_LIKE) {
    if (rule.pattern.test(value)) return `头值看起来是${rule.what} —— 档案里不许出现秘密值`;
  }
  return null;
}

/** User-Agent（服务端 `validateUserAgent`：不许控制字符、不许像秘密）。 */
export function clientUserAgentError(value: string): string | null {
  if (byteLength(value) > MAX_HEADER_VALUE_BYTES) return `User-Agent 太长（上限 ${String(MAX_HEADER_VALUE_BYTES)} 字节）`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return "User-Agent 不能含控制字符";
  for (const rule of SECRET_LIKE) {
    if (rule.pattern.test(value)) return `User-Agent 看起来是${rule.what} —— 不许出现秘密值`;
  }
  return null;
}

/** 一个字段的错误；`field` 用来在表单上就近显示。 */
export interface ClientDraftIssue {
  readonly field: string;
  readonly message: string;
}

/**
 * 草稿的全部问题。
 *
 * `isNew` 只影响 `id` 是否参与校验（改已有档案时 id 不可改，也不该报 id 错）。
 */
export function clientDraftIssues(draft: ClientDraft, isNew: boolean): ClientDraftIssue[] {
  const issues: ClientDraftIssue[] = [];
  if (isNew) {
    const idError = clientProfileIdError(draft.id);
    if (idError !== null) issues.push({ field: "id", message: idError });
  }
  if (draft.label.trim() === "") issues.push({ field: "label", message: "名称不能为空" });
  const uaError = clientUserAgentError(draft.userAgent);
  if (uaError !== null) issues.push({ field: "userAgent", message: uaError });

  if (draft.headers.length > MAX_HEADERS_PER_PROFILE) {
    issues.push({
      field: "headers",
      message: `一个档案最多 ${String(MAX_HEADERS_PER_PROFILE)} 个头`,
    });
  }
  draft.headers.forEach((header, index) => {
    const nameError = clientHeaderNameError(header.name);
    if (nameError !== null) issues.push({ field: `headers.${String(index)}.name`, message: `第 ${String(index + 1)} 行：${nameError}` });
    const valueError = clientHeaderValueError(header.value);
    if (valueError !== null) issues.push({ field: `headers.${String(index)}.value`, message: `第 ${String(index + 1)} 行：${valueError}` });
  });
  return issues;
}

/** 第一条错误（放按钮旁边的人话）。 */
export function clientDraftError(draft: ClientDraft, isNew: boolean): string | null {
  return clientDraftIssues(draft, isNew)[0]?.message ?? null;
}

// ───────────────────────────── 请求体 ─────────────────────────────

/** 头草稿 → 请求体（去掉首尾空白；空名字的行整行丢掉，允许「点多了加一行」）。 */
export function clientHeadersOf(draft: readonly ClientHeaderDraft[]): { name: string; value: string }[] {
  return draft
    .filter((header) => header.name.trim() !== "")
    .map((header) => ({ name: header.name.trim(), value: header.value }));
}

/** 新建 / 全量替换的请求体（与 `adminClients.createClientMask` 的入参同形）。 */
export interface ClientCreateBody {
  id: string;
  label: string;
  enabled: boolean;
  headers: { name: string; value: string }[];
  description?: string;
  userAgent?: string;
}

/** 局部修改的补丁（与 `adminClients.updateClientMask` 的入参同形；只含改了的键）。 */
export interface ClientPatchBody {
  label?: string;
  description?: string | null;
  enabled?: boolean;
  userAgent?: string | null;
  headers?: { name: string; value: string }[];
}

/** 新建 / 全量替换的请求体；不合法返回 `"invalid"`。 */
export function clientCreateBodyOf(draft: ClientDraft): ClientCreateBody | "invalid" {
  if (clientDraftError(draft, true) !== null) return "invalid";
  const body: ClientCreateBody = {
    id: draft.id.trim(),
    label: draft.label.trim(),
    enabled: draft.enabled,
    headers: clientHeadersOf(draft.headers),
  };
  const description = draft.description.trim();
  if (description !== "") body.description = description;
  const userAgent = draft.userAgent.trim();
  if (userAgent !== "") body.userAgent = userAgent;
  return body;
}

/**
 * 局部修改的补丁：**只发真的变了的键**。
 *
 * 省略 = 不改，`null` = 清空（服务端 `Object.hasOwn` / `=== undefined` 口径），
 * 所以「原来有 UA、现在清空」要发 `userAgent: null`，不是省略。
 */
export function clientUpdatePatchOf(
  draft: ClientDraft,
  profile: {
    readonly label: string;
    readonly description: string | null;
    readonly enabled: boolean;
    readonly userAgent: string | null;
    readonly headers: readonly { readonly name: string; readonly value: string }[];
  },
): ClientPatchBody | "invalid" {
  if (clientDraftError(draft, false) !== null) return "invalid";
  const patch: ClientPatchBody = {};

  const label = draft.label.trim();
  if (label !== profile.label) patch.label = label;

  const description = draft.description.trim();
  const descriptionValue = description === "" ? null : description;
  if (descriptionValue !== (profile.description ?? null)) patch.description = descriptionValue;

  const userAgent = draft.userAgent.trim();
  const userAgentValue = userAgent === "" ? null : userAgent;
  if (userAgentValue !== (profile.userAgent ?? null)) patch.userAgent = userAgentValue;

  if (draft.enabled !== profile.enabled) patch.enabled = draft.enabled;

  const headers = clientHeadersOf(draft.headers);
  const current = profile.headers.map((header) => ({ name: header.name, value: header.value }));
  if (!sameHeaders(headers, current)) patch.headers = headers;

  return patch;
}

/** 两组头是否等价（顺序有意义：贴头的顺序就是发送顺序）。 */
export function sameHeaders(
  left: readonly { readonly name: string; readonly value: string }[],
  right: readonly { readonly name: string; readonly value: string }[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((header, index) => header.name === right[index]?.name && header.value === right[index]?.value);
}

// ───────────────────────────── 头行操作 ─────────────────────────────

/** 末尾加一行空头。 */
export function addHeaderRow(headers: readonly ClientHeaderDraft[]): ClientHeaderDraft[] {
  return [...headers.map((header) => ({ ...header })), { name: "", value: "" }];
}

/** 删掉第 index 行。 */
export function removeHeaderRow(headers: readonly ClientHeaderDraft[], index: number): ClientHeaderDraft[] {
  return headers.filter((_, current) => current !== index).map((header) => ({ ...header }));
}

/** 改第 index 行的某个字段。 */
export function updateHeaderRow(
  headers: readonly ClientHeaderDraft[],
  index: number,
  patch: Partial<ClientHeaderDraft>,
): ClientHeaderDraft[] {
  return headers.map((header, current) => (current === index ? { ...header, ...patch } : { ...header }));
}

// ───────────────────────────── 列表分组与文案 ─────────────────────────────

/** 内置 / 自定义分开列（页面左栏两个分组）。 */
export function groupProfiles<T extends { readonly builtin: boolean }>(
  items: readonly T[],
): { readonly builtin: readonly T[]; readonly custom: readonly T[] } {
  return {
    builtin: items.filter((item) => item.builtin),
    custom: items.filter((item) => !item.builtin),
  };
}

/** 顶部状态一句话（总闸 + 数量）。 */
export function clientMaskSummary(
  status: {
    readonly enabled: boolean;
    readonly profiles: number;
    readonly builtin: number;
    readonly custom: number;
    readonly enabledProfiles: number;
  } | null,
): string {
  if (status === null) return "档案读取中…";
  const gate = status.enabled ? "伪装总闸开启" : "伪装总闸关闭";
  return `${gate} · 共 ${String(status.profiles)} 档（内置 ${String(status.builtin)} / 自定义 ${String(status.custom)}）· 已启用 ${String(status.enabledProfiles)}`;
}

/** 一个档案在左栏的副标题（id + 头数）。 */
export function profileSubtitle(profile: {
  readonly id: string;
  readonly headers: readonly unknown[];
  readonly enabled: boolean;
}): string {
  const headers = `${String(profile.headers.length)} 个头`;
  return profile.enabled ? `${profile.id} · ${headers}` : `${profile.id} · ${headers} · 已停用`;
}
