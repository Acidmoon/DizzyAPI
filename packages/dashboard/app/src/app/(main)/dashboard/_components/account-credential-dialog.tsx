"use client";

/**
 * 为已有账号**导入 / 重新授权凭据**（管理员）。
 *
 * 接口：`POST /api/accounts/:id/credentials`。
 *
 * ## 为什么需要它
 *
 * 新建账号时凭据可以留空（先建一个「尚未导入凭据」的账号，之后再导）。以前这条「之后再导」
 * 只能靠重建账号 —— 服务端一直有这条接口，页面没有入口（与「能建不能删」是同一类问题）。
 *
 * ## 秘密纪律（三步都不能省）
 *
 * 1. **明文只走 POST body**：不进 URL、不进查询串、不写 localStorage、不打 console；
 * 2. **不在页面上回显**：提交成功立刻清空输入框，弹窗关闭时也清空；
 * 3. **失败只报稳定 code**：服务端错误里没有凭据，前端也不把 payload 拼进提示文案。
 *
 * 凭据是「只写不读」的：这条路径**没有**回显/查看功能，也不显示现有的值。
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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, adminUsers, ApiError, type AccountViewLike } from "@/lib/api";

import { CREDENTIAL_FORMATS, credentialFormatLabel, type CredentialFormat } from "./account-create-logic";

export function AccountCredentialDialog({
  account,
  onClose,
  onImported,
}: {
  account: AccountViewLike;
  onClose: () => void;
  onImported: () => void;
}) {
  const [format, setFormat] = useState<CredentialFormat>("auto");
  const [payload, setPayload] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    setPayload("");
    setError(null);
    onClose();
  }

  async function submit(): Promise<void> {
    if (payload.trim() === "") {
      setError("凭据内容不能为空");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await adminUsers.importAccountCredentials(api, account.id, { payload, format });
      // 提交成功立刻清空：明文不在内存里多留一秒。
      setPayload("");
      toast.success(`已为「${account.label}」导入凭据`);
      onImported();
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "导入凭据失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) close();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>导入凭据</DialogTitle>
          <DialogDescription>{account.label} · #{account.id}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="account-cred-import-format">凭据格式</Label>
            <Select value={format} onValueChange={(value) => setFormat(value as CredentialFormat)}>
              <SelectTrigger id="account-cred-import-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {CREDENTIAL_FORMATS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {credentialFormatLabel(item)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="account-cred-import-payload">凭据内容</Label>
            <Textarea
              id="account-cred-import-payload"
              rows={6}
              value={payload}
              onChange={(event) => setPayload(event.target.value)}
              placeholder="API Key，或凭据 JSON…"
              className="font-mono text-xs"
              autoComplete="off"
            />
          </div>

          {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? "导入中…" : "导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
