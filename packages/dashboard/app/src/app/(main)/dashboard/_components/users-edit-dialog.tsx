"use client";

/**
 * 用户编辑弹窗：名称 / 角色 / 状态 / 余额展示开关 / 并发上限。
 *
 * 三条纪律：
 * - **只提交变了的字段**（服务端按字段逐项 diff、逐项写审计）；一个字段没改就不发请求。
 * - 并发上限的「不限」是 `null`，**不是 0**：0 会被服务端当成非法值。
 * - 409 / 403 / 503 都按 `ApiError.code` 分支提示，不猜状态码。
 */
import { useEffect, useState } from "react";

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
import { api, adminUsers, ApiError, type AdminUserView } from "@/lib/api";

import { parseConcurrencyLimit, userPatchOf, type UserDraftLike } from "./admin-logic";

export function UserEditDialog({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUserView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<UserDraftLike | null>(null);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(
      user === null
        ? null
        : {
            name: user.name,
            role: user.role,
            status: user.status,
            balanceEnabled: user.balanceEnabled,
            concurrency: user.concurrencyLimit === null ? "" : String(user.concurrencyLimit),
          },
    );
    setFieldError(null);
  }, [user]);

  if (user === null || draft === null) return null;

  async function save(): Promise<void> {
    if (user === null || draft === null) return;
    // 只提交真正改过的字段：服务端逐项 diff、逐项写审计，多发一个没变的字段
    // 就会在审计里多一条「把 X 改成 X」的噪声。
    const patch = userPatchOf(draft, user);
    if (patch === "invalid") {
      setFieldError("名称不能为空；并发上限要留空（不限）或填正整数");
      return;
    }

    if (Object.keys(patch).length === 0) {
      toast.info("没有改动");
      onClose();
      return;
    }
    setSaving(true);
    setFieldError(null);
    try {
      await adminUsers.updateUser(api, user.id, patch);
      toast.success("已保存");
      onSaved();
    } catch (cause) {
      const failure = cause instanceof ApiError ? cause : null;
      toast.error(failure?.message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑用户「{user.name}」</DialogTitle>
          <DialogDescription>只提交改动的字段；每项改动服务端都会记一条审计。</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="user-name">名称</Label>
            <Input
              id="user-name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              autoComplete="off"
              placeholder="显示名称…"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="user-role">角色</Label>
              <Select
                value={draft.role}
                onValueChange={(value) => setDraft({ ...draft, role: value as "admin" | "user" })}
              >
                <SelectTrigger id="user-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="user">普通用户</SelectItem>
                    <SelectItem value="admin">管理员</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="user-status">状态</Label>
              <Select
                value={draft.status}
                onValueChange={(value) => setDraft({ ...draft, status: value as "enabled" | "banned" })}
              >
                <SelectTrigger id="user-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="enabled">启用</SelectItem>
                    <SelectItem value="banned">封禁</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="user-concurrency">并发上限</Label>
            <Input
              id="user-concurrency"
              inputMode="numeric"
              value={draft.concurrency}
              onChange={(event) => setDraft({ ...draft, concurrency: event.target.value })}
              placeholder="留空表示不限…"
              autoComplete="off"
            />
            {fieldError === null ? null : <p className="text-xs text-destructive">{fieldError}</p>}
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="flex flex-col">
              <span className="text-sm font-medium">余额展示</span>
              <span className="text-xs text-muted-foreground">关闭后该用户看不到自己的余额。</span>
            </div>
            <Switch
              checked={draft.balanceEnabled}
              onCheckedChange={(checked) => setDraft({ ...draft, balanceEnabled: checked })}
              aria-label="余额展示开关"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
