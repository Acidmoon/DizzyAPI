"use client";

/**
 * 余额调整弹窗。
 *
 * 关键口径（**别改**）：`delta` 必须是**整数微元的十进制字符串**，可负。
 * 不能在浏览器里 `Number(元) * 1_000_000`——那是浮点，也超过 `Number.MAX_SAFE_INTEGER` 的边界。
 * 所以这里把「元」按字符串拆成整数部分与最多 6 位小数，拼成微元字符串，全程 BigInt。
 *
 * 方向用「增加 / 扣减」两个明确按钮，不接受用户自己输负号——负号漏输会变成反向操作。
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
import { api, adminUsers, ApiError, type AdminUserView } from "@/lib/api";
import { formatMicrosAsYuan } from "@/lib/format";

import { balanceDelta } from "./admin-logic";

export function BalanceDialog({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUserView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"add" | "subtract">("add");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAmount("");
    setDirection("add");
    setReason("");
    setError(null);
  }, [user]);

  if (user === null) return null;

  async function submit(): Promise<void> {
    if (user === null) return;
    const delta = balanceDelta(direction, amount);
    if (delta === null) {
      setError("金额要写成正数、最多 6 位小数，且不能为 0");
      return;
    }
    if (reason.trim() === "") {
      setError("必须填理由（会记进审计）");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await adminUsers.adjustBalance(api, user.id, { delta, reason: reason.trim() });
      toast.success(`已调整，当前余额 ${formatMicrosAsYuan(result.balanceMinor)} 元`);
      onSaved();
    } catch (cause) {
      const failure = cause instanceof ApiError ? cause : null;
      setError(failure?.message ?? "调整失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>调整「{user.name}」的余额</DialogTitle>
          <DialogDescription>
            当前余额 {formatMicrosAsYuan(user.balanceMinor)} 元（整数微元）。余额允许为负，表示后付费欠款。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="balance-direction">方向</Label>
            <Select
              value={direction}
              onValueChange={(value) => setDirection(value as "add" | "subtract")}
            >
              <SelectTrigger id="balance-direction">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="add">增加</SelectItem>
                  <SelectItem value="subtract">扣减</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="balance-amount">金额（元）</Label>
            <Input
              id="balance-amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="例如 10 或 0.5…"
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="balance-reason">理由</Label>
            <Input
              id="balance-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例如：人工补发 / 对账修正…"
              autoComplete="off"
            />
          </div>
          {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? "提交中…" : "确认调整"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
