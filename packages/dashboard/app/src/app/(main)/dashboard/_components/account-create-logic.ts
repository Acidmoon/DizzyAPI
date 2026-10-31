/**
 * 新建上游账号的**纯逻辑**（不 import React / Next / UI 组件）。
 *
 * 为什么单独一个文件：字段多、约束多，而且是「错了就建出坏账号」的那一段。
 * 仓库根的 `pnpm test` 跑在**没有 React** 的环境里，所以可测的逻辑必须与渲染分离。
 *
 * ## 三条硬约束（全部来自服务端源码，不是猜的）
 *
 * 1. **`provider` × `kind` 有组合约束**：`packages/account-admin/src/importers.ts`
 *    的 `assertProviderKind` 明确 —— **`custom` 只能用于 `api_key`**，
 *    OAuth 账号必须显式给出 `claude` 或 `openai`。
 *    选 `custom` + `oauth` 会被服务端拒（`ACCOUNT_ADMIN_INPUT_INVALID`），
 *    所以前端在选 kind 时就**动态收窄** provider 列表，不让用户选出一个非法组合。
 * 2. **`label` 必填且 ≤ 200 字符**（`normalizeLabel`）。
 * 3. **`credential` 是可选的**：不填就建一个「尚未导入凭据」的账号。
 *    `credential.provider` / `credential.kind` 若与账号冲突，服务端报
 *    `ACCOUNT_ADMIN_IMPORT_CONFLICT` —— 所以**前端绝不重复声明**这两个字段，
 *    只让服务端以账号的 provider / kind 为准。
 */

/** 上游账号的提供商（服务端 `AccountProvider`）。 */
export type AccountProvider = "claude" | "openai" | "custom";

/** 上游账号的类型（服务端 `AccountKind`）。 */
export type AccountKind = "oauth" | "api_key";

/** 上游协议（服务端 `AccountProtocol`）。 */
export type AccountProtocol = "openai-chat" | "openai-responses" | "anthropic" | "gemini";

/** 凭据格式（服务端 `CredentialImportFormat`）。 */
export type CredentialFormat = "auto" | "claude-oauth" | "openai-codex" | "api-key" | "identity-bundle";

/** provider 的中文标签。 */
export function providerLabel(provider: AccountProvider): string {
  if (provider === "claude") return "Claude";
  if (provider === "openai") return "OpenAI";
  return "自定义上游";
}

/** kind 的中文标签。 */
export function kindLabel(kind: AccountKind): string {
  if (kind === "oauth") return "OAuth 订阅账号";
  return "API Key 账号";
}

/** protocol 的中文标签。 */
export function protocolLabel(protocol: AccountProtocol): string {
  if (protocol === "openai-chat") return "OpenAI Chat";
  if (protocol === "openai-responses") return "OpenAI Responses";
  if (protocol === "anthropic") return "Anthropic Messages";
  return "Gemini";
}

/** 凭据格式的中文标签。 */
export function credentialFormatLabel(format: CredentialFormat): string {
  if (format === "auto") return "自动识别";
  if (format === "claude-oauth") return "Claude OAuth 凭据";
  if (format === "openai-codex") return "OpenAI Codex 凭据";
  if (format === "api-key") return "API Key";
  return "identity 凭据包";
}

/**
 * 给定 kind，可选的 provider 列表。
 *
 * `custom` 只能配 `api_key`（服务端的 `assertProviderKind`）；反过来
 * `claude` / `openai` 两种 kind 都能配。
 */
export function providersForKind(kind: AccountKind): readonly AccountProvider[] {
  if (kind === "oauth") return ["claude", "openai"];
  return ["claude", "openai", "custom"];
}

/**
 * provider 能不能配这个 kind。非法组合返回 `false`。
 *
 * 与服务端的 `assertProviderKind` **逐字对齐**：只有 `custom` + `oauth` 是非法的。
 */
export function isProviderKindValid(provider: AccountProvider, kind: AccountKind): boolean {
  return !(kind === "oauth" && provider === "custom");
}

/** 新建账号表单的草稿。 */
export interface AccountDraft {
  provider: AccountProvider;
  kind: AccountKind;
  label: string;
  email: string;
  subject: string;
  baseUrl: string;
  protocol: AccountProtocol | "";
  models: string;
  modelMap: string;
  priority: string;
  enabled: boolean;
  credentialFormat: CredentialFormat;
  credentialPayload: string;
}

/** 空草稿（新建时的默认值）。 */
export function emptyAccountDraft(): AccountDraft {
  return {
    provider: "claude",
    kind: "oauth",
    label: "",
    email: "",
    subject: "",
    baseUrl: "",
    protocol: "",
    models: "",
    modelMap: "",
    priority: "0",
    enabled: true,
    credentialFormat: "auto",
    credentialPayload: "",
  };
}

/** 由草稿造出的 POST body（**不含**空的可选项，服务端把 `undefined` 当「没给」）。 */
export interface AccountCreateBody {
  provider: AccountProvider;
  kind: AccountKind;
  label: string;
  email?: string;
  subject?: string;
  baseUrl?: string;
  protocol?: AccountProtocol;
  models?: string[];
  modelMap?: Record<string, string>;
  priority?: number;
  enabled: boolean;
  credential?: { format: CredentialFormat; payload: string };
}

/** 一行一模型名 → 模型名数组；空行忽略。 */
export function parseModelList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * `对外名 → 上游名` 的映射文本 → 对象。
 *
 * 每行一条，格式 `对外名=上游名`（也接受 `对外名 上游名` 与 `对外名: 上游名`）。
 * **格式不对的行直接报错**，不静默跳过——静默跳过会让人以为映射已经建好。
 */
export function parseModelMap(
  text: string,
): Record<string, string> | "invalid" {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = /^(.+?)\s*[=:：]\s*(.+)$/.exec(line);
    const parts = match === null ? line.split(/\s+/) : null;
    const from = match === null ? parts?.[0]?.trim() : (match[1] as string).trim();
    const to = match === null ? parts?.[1]?.trim() : (match[2] as string).trim();
    if (from === undefined || to === undefined || from === "" || to === "") return "invalid";
    out[from] = to;
  }
  return out;
}

/** 优先级：0..1000 的整数；非法返回 `"invalid"`。 */
export function parsePriority(text: string): number | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000) return "invalid";
  return value;
}

/** Base URL：必须是 http(s) 的合法 URL；空串表示不填。 */
export function parseBaseUrl(text: string): string | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid";
  return trimmed;
}

/**
 * 草稿 → POST body；非法返回 `"invalid"`。
 *
 * 空的必填项（`label`）与非法组合（`custom` + `oauth`）在这里就被挡住，
 * **不发出请求**——服务端会拒，但让用户先撞一次服务端错误体验很差。
 */
export function accountCreateBodyOf(draft: AccountDraft): AccountCreateBody | "invalid" {
  const label = draft.label.trim();
  if (label === "") return "invalid";
  if (label.length > 200) return "invalid";
  if (!isProviderKindValid(draft.provider, draft.kind)) return "invalid";

  const priority = parsePriority(draft.priority);
  if (priority === "invalid") return "invalid";

  const baseUrl = parseBaseUrl(draft.baseUrl);
  if (baseUrl === "invalid") return "invalid";

  const modelMap = parseModelMap(draft.modelMap);
  if (modelMap === "invalid") return "invalid";

  const body: AccountCreateBody = {
    provider: draft.provider,
    kind: draft.kind,
    label,
    enabled: draft.enabled,
  };
  const email = draft.email.trim();
  if (email !== "") body.email = email;
  const subject = draft.subject.trim();
  if (subject !== "") body.subject = subject;
  if (baseUrl !== "") body.baseUrl = baseUrl;
  if (draft.protocol !== "") body.protocol = draft.protocol;
  const models = parseModelList(draft.models);
  if (models.length > 0) body.models = models;
  if (Object.keys(modelMap).length > 0) body.modelMap = modelMap;
  body.priority = priority;

  // 凭据是可选的；给了就一起建。**只走 body，绝不进 URL、不回显、不落 storage。**
  const payload = draft.credentialPayload.trim();
  if (payload !== "") {
    body.credential = { format: draft.credentialFormat, payload };
  }
  return body;
}

/** 弹窗里的字段级错误提示（给用户看的人话）。 */
export function accountDraftError(draft: AccountDraft): string | null {
  if (draft.label.trim() === "") return "名称不能为空";
  if (draft.label.trim().length > 200) return "名称最长 200 个字符";
  if (!isProviderKindValid(draft.provider, draft.kind)) {
    return "自定义上游只能用于 API Key 账号";
  }
  if (parsePriority(draft.priority) === "invalid") return "优先级要填 0..1000 的整数";
  if (parseBaseUrl(draft.baseUrl) === "invalid") return "Base URL 要填 http(s) 开头的合法地址";
  if (parseModelMap(draft.modelMap) === "invalid") {
    return "模型映射每行要写成「对外名=上游名」";
  }
  return null;
}
