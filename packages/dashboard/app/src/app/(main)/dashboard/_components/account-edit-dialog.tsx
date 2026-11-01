"use client";

/**
 * 编辑上游账号弹窗（管理员）。
 *
 * 接口：`PATCH /api/accounts/:id`（要管理员权限；路径**不带** `admin` 前缀）。
 *
 * ## 提交形状（这是本文件最容易错的地方）
 *
 * `enabled` 与元数据**平级但分属两条服务端路径**：服务端把 `label / email / …` 归到
 * `account.update`（一笔审计），把 `enabled` 归到 `account.enable / account.disable`（另一笔审计）。
 * 所以这里**永远不把 `enabled` 塞进 patch 对象**，只在 body 顶层带上。
 *
 * **清空用 `null`**：服务端用 `Object.hasOwn` 判「给了没」，`null` = 清空为未声明、
 * 省略 = 不改（`account-edit-logic.ts` 只把真变了的字段放进 patch）。
 *
 * ## 三条纪律
 *
 * - 凭据**不在这里改**：凭据是「只写不读」的独立动作（`POST /:id/credentials`），
 *   编辑弹窗一个字节都不碰，也不显示有没有配（列表里有专门的凭据状态）。
 * - 下拉一律自研 `Select`，不用浏览器原生 `<select>`。
 * - 字段级校验先在前端做一遍，非法不发请求。
 */
import { useEffect, useState } from "react";

import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { api, adminClients, adminUsers, ApiError, type AccountViewLike, type ClientProfileView } from "@/lib/api";

import { accountStateLabel } from "./admin-logic";
import { protocolLabel, type AccountProtocol } from "./account-create-logic";
import {
  accountEditError,
  accountEditDraftOf,
  accountEditPlanOf,
  changedFieldLabels,
  isNoopPlan,
  type AccountEditDraft,
} from "./account-edit-logic";

const PROTOCOLS: readonly AccountProtocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
];

function GroupTitle({ children }: { children: string }) {
  return <div className="text-xs font-medium tracking-wide text-muted-foreground">{children}</div>;
}

export function AccountEditDialog({
  account,
  onClose,
  onSaved,
}: {
  account: AccountViewLike;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<AccountEditDraft>(() => accountEditDraftOf(account));
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  /** 可选档案：只列启用的；停用 / 已删的那个也要能显示（否则这一栏会静默变空）。 */
  const [profiles, setProfiles] = useState<readonly ClientProfileView[]>([]);

  useEffect(() => {
    let alive = true;
    adminClients
      .listClientMasks(api)
      .then((result) => {
        if (alive) setProfiles(result.items);
      })
      // 档案插件不在运行时选不到档，但**账号编辑本身照旧可用**（别把整张表单一起废掉）。
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  function patchDraft(next: Partial<AccountEditDraft>): void {
    setDraft((current) => ({ ...current, ...next }));
  }

  async function submit(): Promise<void> {
    const plan = accountEditPlanOf(draft, account);
    if (plan === "invalid") {
      setFieldError(accountEditError(draft) ?? "表单填得不对");
      return;
    }
    if (isNoopPlan(plan)) {
      toast.info("没有改动");
      return;
    }
    setSaving(true);
    setFieldError(null);
    try {
      const body = {
        ...plan.patch,
        ...(plan.enabled === null ? {} : { enabled: plan.enabled }),
      };
      await adminUsers.updateAccount(api, account.id, body);
      toast.success(`已保存：${changedFieldLabels(plan).join("、")}`);
      onSaved();
    } catch (cause) {
      setFieldError(cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  const autoDisabled = account.status === "auto_disabled";
  /**
   * 当前挂的档案若不在「已启用」列表里（被停用 / 被删），也要能显示出来：
   * 否则下拉会静默跳到「不伪装」，保存时把 `clientProfile` 冲掉。
   */
  const enabledProfiles = profiles.filter((profile) => profile.enabled);
  const currentProfileFallback =
    draft.clientProfile === "" || enabledProfiles.some((profile) => profile.id === draft.clientProfile)
      ? null
      : {
          id: draft.clientProfile,
          label: `${draft.clientProfile}（${profiles.some((profile) => profile.id === draft.clientProfile) ? "已停用" : "已删除"}）`,
        };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>编辑上游账号</DialogTitle>
          <DialogDescription>
            {account.label} · #{account.id}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <GroupTitle>身份</GroupTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="account-edit-label">名称</Label>
              <Input
                id="account-edit-label"
                value={draft.label}
                onChange={(event) => patchDraft({ label: event.target.value })}
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account-edit-priority">优先级</Label>
              <Input
                id="account-edit-priority"
                inputMode="numeric"
                value={draft.priority}
                onChange={(event) => patchDraft({ priority: event.target.value })}
                autoComplete="off"
              />
            </div>
          </div>

          <GroupTitle>连接</GroupTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="account-edit-baseurl">Base URL</Label>
              <Input
                id="account-edit-baseurl"
                value={draft.baseUrl}
                onChange={(event) => patchDraft({ baseUrl: event.target.value })}
                placeholder="留空 = 用提供商默认…"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account-edit-protocol">上游协议</Label>
              <Select
                value={draft.protocol === "" ? "same" : draft.protocol}
                onValueChange={(value) =>
                  patchDraft({ protocol: value === "same" ? "" : (value as AccountProtocol) })
                }
              >
                <SelectTrigger id="account-edit-protocol">
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
              <Label htmlFor="account-edit-email">邮箱</Label>
              <Input
                id="account-edit-email"
                type="email"
                value={draft.email}
                onChange={(event) => patchDraft({ email: event.target.value })}
                placeholder="留空 = 清空…"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account-edit-subject">账号标识</Label>
              <Input
                id="account-edit-subject"
                value={draft.subject}
                onChange={(event) => patchDraft({ subject: event.target.value })}
                placeholder="留空 = 清空…"
                autoComplete="off"
              />
            </div>
          </div>

          <GroupTitle>模型</GroupTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="account-edit-models">对外模型名</Label>
              <Textarea
                id="account-edit-models"
                rows={4}
                value={draft.models}
                onChange={(event) => patchDraft({ models: event.target.value })}
                placeholder={"每行一个；清空 = 不声明"}
                className="font-mono text-xs"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account-edit-modelmap">模型映射</Label>
              <Textarea
                id="account-edit-modelmap"
                rows={4}
                value={draft.modelMap}
                onChange={(event) => patchDraft({ modelMap: event.target.value })}
                placeholder={"每行「对外名=上游名」；清空 = 不改写"}
                className="font-mono text-xs"
              />
            </div>
          </div>

          <GroupTitle>调度</GroupTitle>
          <div className="grid gap-2">
            <Label htmlFor="account-client-profile">客户端档案</Label>
            <Select
              value={draft.clientProfile === "" ? "none" : draft.clientProfile}
              onValueChange={(value) => patchDraft({ clientProfile: value === "none" ? "" : value })}
            >
              <SelectTrigger id="account-client-profile">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="none">不伪装</SelectItem>
                  {enabledProfiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.label}
                    </SelectItem>
                  ))}
                  {currentProfileFallback === null ? null : (
                    <SelectItem value={currentProfileFallback.id}>{currentProfileFallback.label}</SelectItem>
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">启用</span>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{accountStateLabel(account.enabled, account.status)}</Badge>
                {autoDisabled ? (
                  <span className="text-xs text-destructive">
                    系统自动停用：这是系统的判断，上面这个开关是人手开关，两者互不覆盖。
                  </span>
                ) : null}
              </div>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(checked) => patchDraft({ enabled: checked })}
              aria-label="启用该账号"
            />
          </div>

          {fieldError === null ? null : <p className="text-xs text-destructive">{fieldError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
