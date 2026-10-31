"use client";

/**
 * 新建上游账号弹窗（管理员）。
 *
 * 接口：`POST /api/accounts`（要管理员权限；路径**不带** `admin` 前缀）。
 *
 * ## 分组依据（借鉴 sub2api / new-api 的渠道表单信息架构，不复制代码）
 *
 * 表单按「管理员填的顺序」分四组：
 * 1. **身份**：提供商 / 类型 / 名称 —— 决定这个账号是什么；
 * 2. **连接**：Base URL / 协议 / 邮箱 / 账号标识 —— 决定怎么连上去；
 * 3. **模型**：对外模型名 / 模型映射 —— 决定它对外提供什么；
 * 4. **凭据与调度**：凭据格式 / 凭据内容 / 优先级 / 启用。
 *
 * sub2api 的渠道表单把「基础信息 / 模型 / 调度」分开，new-api 的 Channel 表单把
 * 「类型 / 密钥 / 模型 / 分组 / 优先级 / 权重」分开 —— 共同点是**先说这是什么，
 * 再说它能做什么，最后才是调度细节**。这里照这个顺序排。
 *
 * ## 五条纪律
 *
 * - **凭据明文只走 POST body**：不进 URL、不回显、不写 localStorage、不打 console。
 *   提交成功后立刻清空输入框。
 * - **`custom` provider 只能配 `api_key`**：选 kind 时动态收窄 provider 列表，
 *   不让用户选出服务端会拒的组合（`assertProviderKind`）。
 * - **凭据不重复声明 provider / kind**：服务端以账号的 provider / kind 为准，
 *   重复声明且不一致会报 `ACCOUNT_ADMIN_IMPORT_CONFLICT`。
 * - **所有下拉用自研 `Select`**，不碰浏览器原生 `<select>`。
 * - **字段级校验在前端先做一遍**：非法组合不发请求（服务端也会拒，但先撞服务端体验差）。
 */
import { useState } from "react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, adminUsers, ApiError } from "@/lib/api";

import {
  accountCreateBodyOf,
  accountDraftError,
  credentialFormatLabel,
  emptyAccountDraft,
  kindLabel,
  protocolLabel,
  providerLabel,
  providersForKind,
  type AccountDraft,
  type AccountKind,
  type AccountProtocol,
  type AccountProvider,
  type CredentialFormat,
} from "./account-create-logic";

const PROTOCOLS: readonly AccountProtocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
];

const CREDENTIAL_FORMATS: readonly CredentialFormat[] = [
  "auto",
  "claude-oauth",
  "openai-codex",
  "api-key",
  "identity-bundle",
];

/** 一组表单字段的标题（分组用，不是解释性小字）。 */
function GroupTitle({ children }: { children: string }) {
  return <div className="text-xs font-medium tracking-wide text-muted-foreground">{children}</div>;
}

export function AccountCreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [draft, setDraft] = useState<AccountDraft>(emptyAccountDraft);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  function reset(): void {
    setDraft(emptyAccountDraft());
    setFieldError(null);
  }

  function changeKind(kind: AccountKind): void {
    setDraft((current) => {
      // kind 变了，provider 可能变成非法组合 —— 换成该 kind 的第一个合法 provider。
      const allowed = providersForKind(kind);
      const provider = allowed.includes(current.provider) ? current.provider : (allowed[0] as AccountProvider);
      return { ...current, kind, provider };
    });
  }

  async function submit(): Promise<void> {
    const body = accountCreateBodyOf(draft);
    if (body === "invalid") {
      setFieldError(accountDraftError(draft) ?? "表单填得不对");
      return;
    }
    setSaving(true);
    setFieldError(null);
    try {
      await adminUsers.createAccount(api, body);
      toast.success(`已创建账号「${body.label}」`);
      reset();
      onCreated();
    } catch (cause) {
      setFieldError(cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "创建失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>新建上游账号</DialogTitle>
          <DialogDescription>
            凭据内容只随这一次请求发送，服务端存进凭据库，页面不回显、不保存。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <GroupTitle>身份</GroupTitle>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="account-kind">类型</Label>
              <Select value={draft.kind} onValueChange={(value) => changeKind(value as AccountKind)}>
                <SelectTrigger id="account-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="oauth">{kindLabel("oauth")}</SelectItem>
                    <SelectItem value="api_key">{kindLabel("api_key")}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account-provider">提供商</Label>
              <Select
                value={draft.provider}
                onValueChange={(value) => setDraft({ ...draft, provider: value as AccountProvider })}
              >
                <SelectTrigger id="account-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {providersForKind(draft.kind).map((provider) => (
                      <SelectItem key={provider} value={provider}>
                        {providerLabel(provider)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account-label">名称</Label>
              <Input
                id="account-label"
                value={draft.label}
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                placeholder="例如：主力 Claude…"
                autoComplete="off"
              />
            </div>
          </div>

          <GroupTitle>连接</GroupTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="account-baseurl">Base URL</Label>
              <Input
                id="account-baseurl"
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                placeholder="https://api.example.com/v1…"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account-protocol">上游协议</Label>
              <Select
                value={draft.protocol === "" ? "same" : draft.protocol}
                onValueChange={(value) =>
                  setDraft({ ...draft, protocol: value === "same" ? "" : (value as AccountProtocol) })
                }
              >
                <SelectTrigger id="account-protocol">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="same">同提供商默认</SelectItem>
                    {PROTOCOLS.map((protocol) => (
                      <SelectItem key={protocol} value={protocol}>
                        {protocolLabel(protocol)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account-email">邮箱</Label>
              <Input
                id="account-email"
                type="email"
                value={draft.email}
                onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                placeholder="可留空…"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account-subject">账号标识</Label>
              <Input
                id="account-subject"
                value={draft.subject}
                onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
                placeholder="可留空…"
                autoComplete="off"
              />
            </div>
          </div>

          <GroupTitle>模型</GroupTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="account-models">对外模型名</Label>
              <Textarea
                id="account-models"
                rows={4}
                value={draft.models}
                onChange={(event) => setDraft({ ...draft, models: event.target.value })}
                placeholder={"每行一个，例如：\ndeepseek-chat\ndeepseek-reasoner"}
                className="font-mono text-xs"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account-modelmap">模型映射</Label>
              <Textarea
                id="account-modelmap"
                rows={4}
                value={draft.modelMap}
                onChange={(event) => setDraft({ ...draft, modelMap: event.target.value })}
                placeholder={"每行一条「对外名=上游名」，例如：\ndeepseek-chat=deepseek-v3"}
                className="font-mono text-xs"
              />
            </div>
          </div>

          <GroupTitle>凭据与调度</GroupTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="account-cred-format">凭据格式</Label>
              <Select
                value={draft.credentialFormat}
                onValueChange={(value) =>
                  setDraft({ ...draft, credentialFormat: value as CredentialFormat })
                }
              >
                <SelectTrigger id="account-cred-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {CREDENTIAL_FORMATS.map((format) => (
                      <SelectItem key={format} value={format}>
                        {credentialFormatLabel(format)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account-priority">优先级</Label>
              <Input
                id="account-priority"
                inputMode="numeric"
                value={draft.priority}
                onChange={(event) => setDraft({ ...draft, priority: event.target.value })}
                placeholder="0…"
                autoComplete="off"
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="account-credential">凭据内容</Label>
            <Textarea
              id="account-credential"
              rows={5}
              value={draft.credentialPayload}
              onChange={(event) => setDraft({ ...draft, credentialPayload: event.target.value })}
              placeholder="可留空（先建账号，之后再导入凭据）。API Key 或凭据 JSON 都可以…"
              className="font-mono text-xs"
              autoComplete="off"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="flex flex-col">
              <span className="text-sm font-medium">创建后启用</span>
              <span className="text-xs text-muted-foreground">停用的账号不参与调度。</span>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })}
              aria-label="创建后启用"
            />
          </div>

          {fieldError === null ? null : <p className="text-xs text-destructive">{fieldError}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={saving}
          >
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? "创建中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
