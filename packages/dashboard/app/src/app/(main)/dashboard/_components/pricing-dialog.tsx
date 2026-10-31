"use client";

/**
 * 价格编辑弹窗（新增与改价共用一个表单）。
 *
 * 纪律：
 * - 四个单价都是**元字符串**，原样透传给服务端（服务端判合法性）。
 * - 新增时模型名由管理员填；改价时模型名只读（改名 = 删了再建，不做隐式改名）。
 * - 只提交改动过的字段（改价时），新增时四个价都要给。
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
import { api, ApiError, pricing, type ModelPriceView } from "@/lib/api";

interface Draft {
  model: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

const EMPTY: Draft = { model: "", input: "", output: "", cacheRead: "", cacheWrite: "" };

function draftOf(price: ModelPriceView): Draft {
  return {
    model: price.model,
    input: price.inputPerMillion,
    output: price.outputPerMillion,
    cacheRead: price.cacheReadPerMillion,
    cacheWrite: price.cacheWritePerMillion,
  };
}

export function PriceDialog({
  target,
  onClose,
  onSaved,
}: {
  target: ModelPriceView | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(target === null || target === "new" ? EMPTY : draftOf(target));
    setError(null);
  }, [target]);

  if (target === null) return null;
  const isNew = target === "new";

  async function save(): Promise<void> {
    const model = isNew ? draft.model.trim() : (target as ModelPriceView).model;
    if (model === "") {
      setError("模型名不能为空");
      return;
    }
    if (draft.input.trim() === "" || draft.output.trim() === "") {
      setError("输入与输出单价必填");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await pricing.setModelPrice(api, model, {
        inputPerMillion: draft.input.trim(),
        outputPerMillion: draft.output.trim(),
        ...(draft.cacheRead.trim() === "" ? {} : { cacheReadPerMillion: draft.cacheRead.trim() }),
        ...(draft.cacheWrite.trim() === "" ? {} : { cacheWritePerMillion: draft.cacheWrite.trim() }),
      });
      toast.success(isNew ? `已添加 ${model}` : `已保存 ${model} 的价格`);
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? "添加模型价格" : `编辑 ${(target as ModelPriceView).model}`}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="price-model">模型名</Label>
            <Input
              id="price-model"
              value={draft.model}
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              placeholder="例如 deepseek-flash…"
              autoComplete="off"
              readOnly={!isNew}
              className={isNew ? undefined : "bg-muted"}
            />
            {isNew ? null : (
              <p className="text-xs text-muted-foreground">模型名不可改：要改名就删掉重建。</p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="price-input">输入 / 百万</Label>
              <Input
                id="price-input"
                value={draft.input}
                onChange={(event) => setDraft({ ...draft, input: event.target.value })}
                placeholder="必填…"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="price-output">输出 / 百万</Label>
              <Input
                id="price-output"
                value={draft.output}
                onChange={(event) => setDraft({ ...draft, output: event.target.value })}
                placeholder="必填…"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="price-cache-read">缓存读 / 百万</Label>
              <Input
                id="price-cache-read"
                value={draft.cacheRead}
                onChange={(event) => setDraft({ ...draft, cacheRead: event.target.value })}
                placeholder="留空表示 0…"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="price-cache-write">缓存写 / 百万</Label>
              <Input
                id="price-cache-write"
                value={draft.cacheWrite}
                onChange={(event) => setDraft({ ...draft, cacheWrite: event.target.value })}
                placeholder="留空表示 0…"
                autoComplete="off"
              />
            </div>
          </div>

          {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
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
