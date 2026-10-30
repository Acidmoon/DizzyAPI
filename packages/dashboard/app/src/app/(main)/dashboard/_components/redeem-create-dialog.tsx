"use client";

/**
 * 生成兑换码批次：填名称 / 面额 / 张数 → 生成 → **明文只显示这一次**。
 *
 * 三条纪律：
 * - 面额是**整数微元**：用户填「元」，这里用字符串换算（`yuanTextToMicros`，不经浮点），
 *   绝不 `Number(元) * 1_000_000`（浮点 + 超 2^53）。
 * - 明文码**只在生成响应里**：关掉弹窗即消失；不写 localStorage / sessionStorage、不进 URL、不打 console。
 * - 生成成功后**不自动关闭**（否则用户手一抖就再也拿不到明文），必须点「我已保存好」。
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
import { api, adminCommerce, ApiError, type CreatedRedeemBatchView } from "@/lib/api";
import { formatMicrosAsYuan } from "@/lib/format";

import { yuanTextToMicros } from "./admin-logic";

export function RedeemCreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [count, setCount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedRedeemBatchView | null>(null);
  const [copied, setCopied] = useState(false);

  function reset(): void {
    setName("");
    setAmount("");
    setCount("");
    setError(null);
    setCreated(null);
    setCopied(false);
  }

  async function submit(): Promise<void> {
    if (name.trim() === "") {
      setError("批次名不能为空");
      return;
    }
    const micros = yuanTextToMicros(amount);
    if (micros === null || BigInt(micros) === 0n) {
      setError("面额要写成正数、最多 6 位小数");
      return;
    }
    if (!/^\d+$/.test(count.trim())) {
      setError("张数要填正整数（服务端限 1..100）");
      return;
    }
    const total = Number(count.trim());
    if (!Number.isSafeInteger(total) || total < 1 || total > 100) {
      setError("张数必须在 1..100 之间");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await adminCommerce.createRedeemBatch(api, {
        name: name.trim(),
        amountMicro: micros,
        count: total,
      });
      // 明文只落到这一次 state 里；不写 storage、不进 URL。
      setCreated(result);
      toast.success(`已生成 ${String(total)} 张兑换码`);
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "生成失败");
    } finally {
      setSaving(false);
    }
  }

  async function copyAll(): Promise<void> {
    if (created === null) return;
    try {
      await navigator.clipboard.writeText(created.codes.join("\n"));
      setCopied(true);
      toast.success("已复制全部兑换码");
    } catch {
      toast.error("复制失败，请手动选中复制");
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{created === null ? "生成兑换码批次" : "生成成功：明文只显示这一次"}</DialogTitle>
          <DialogDescription>
            {created === null
              ? "面额与张数都会落库；明文码只在生成响应里出现，之后列表只有掩码。"
              : "关掉这个窗口就再也看不到明文了（服务端只存 sha256 与末 4 位）。请先复制保存。"}
          </DialogDescription>
        </DialogHeader>

        {created === null ? (
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="redeem-name">批次名</Label>
              <Input
                id="redeem-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：十月活动…"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="redeem-amount">面额（元）</Label>
                <Input
                  id="redeem-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="例如 10…"
                  autoComplete="off"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="redeem-count">张数</Label>
                <Input
                  id="redeem-count"
                  inputMode="numeric"
                  value={count}
                  onChange={(event) => setCount(event.target.value)}
                  placeholder="1 ~ 100…"
                  autoComplete="off"
                />
              </div>
            </div>
            {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid gap-1 rounded-lg border bg-muted/40 p-3 text-sm">
              <span>
                批次：<span className="font-medium">{created.batch.name}</span>
              </span>
              <span>
                面额：<span className="font-mono">{formatMicrosAsYuan(created.batch.amountMinor)}</span> 元 · 共{" "}
                {String(created.batch.codeCount)} 张
              </span>
            </div>
            <pre className="max-h-56 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
              {created.codes.join("\n")}
            </pre>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => void copyAll()}>
                {copied ? "已复制" : "复制全部"}
              </Button>
            </div>
            {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {created === null ? (
            <>
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
                {saving ? "生成中…" : "生成"}
              </Button>
            </>
          ) : (
            <Button
              onClick={() => {
                reset();
                onCreated();
              }}
            >
              我已保存好，关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
