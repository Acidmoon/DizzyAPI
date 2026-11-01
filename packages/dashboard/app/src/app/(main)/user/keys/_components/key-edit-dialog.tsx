"use client";

/**
 * 编辑 API 密钥弹窗：名称 / 启用 / 过期时间 / 金额上限 / 并发上限。
 *
 * 三条纪律：
 * - **只提交变了的字段**（`keyEditPatchOf`）；一个字段没改就不发请求，改了多少发多少。
 * - 「不限」一律是 `null`：空输入框 = 清空上限，不是 0（0 在服务端是非法值）。
 * - 日期控件是**自研**的（`Popover` + `Calendar`），不用原生 `<input type="date">`——
 *   原生浮层由浏览器绘制，CSS 碰不到，深色主题下会是一块白板（owner 明确禁止）。
 */

import { useEffect, useState } from "react";

import { CalendarIcon } from "lucide-react";
import { toast } from "sonner";
import { zhCN } from "date-fns/locale";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ApiError, api, keys as keysApi, type ApiKeySummaryView } from "@/lib/api";

import {
  keyEditDraftOf,
  keyEditError,
  keyEditPatchOf,
  localDayDate,
  localDayTextOf,
  type KeyEditDraft,
} from "./key-edit-logic";

/** 单个日期选择（自研控件；`""` = 不设过期）。 */
function ExpiryPicker({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          id="key-expires-at"
          className="w-full justify-start font-normal"
          aria-label="过期时间"
        >
          <CalendarIcon className="size-3.5" />
          {value === "" ? "永不过期" : value}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          locale={zhCN}
          selected={localDayDate(value) ?? undefined}
          onSelect={(date) => {
            if (date === undefined) return;
            onChange(localDayTextOf(date));
            setOpen(false);
          }}
        />
        <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5">
          <span className="text-xs text-muted-foreground">{value === "" ? "永不过期" : `${value} 当天有效`}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
          >
            清空
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function KeyEditDialog({
  apiKey,
  onClose,
  onSaved,
}: {
  readonly apiKey: ApiKeySummaryView | null;
  readonly onClose: () => void;
  readonly onSaved: (updated: ApiKeySummaryView) => void;
}) {
  const [draft, setDraft] = useState<KeyEditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setDraft(apiKey === null ? null : keyEditDraftOf(apiKey));
    setFailure(null);
  }, [apiKey]);

  if (apiKey === null || draft === null) return null;

  const save = async (): Promise<void> => {
    const patch = keyEditPatchOf(draft, apiKey);
    if (patch === "invalid") {
      setFailure(keyEditError(draft) ?? "请检查填写的值");
      return;
    }
    if (Object.keys(patch).length === 0) {
      toast.info("没有改动");
      onClose();
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      const updated = await keysApi.updateKey(api, apiKey.id, patch);
      toast.success("已保存");
      onSaved(updated);
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑密钥「{apiKey.name === "" ? "（未命名）" : apiKey.name}」</DialogTitle>
          <DialogDescription>上限留空表示不限；密钥本身不变（换密钥用「轮换」）。</DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field>
            <FieldLabel htmlFor="key-edit-name">名称</FieldLabel>
            <Input
              id="key-edit-name"
              value={draft.name}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              placeholder="例如：本地调试…"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <FieldDescription>最多 64 个字符</FieldDescription>
          </Field>

          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="flex flex-col">
              <span className="text-sm font-medium">启用</span>
              <span className="text-xs text-muted-foreground">{draft.enabled ? "当前启用" : "当前停用"}</span>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })}
              aria-label="启用开关"
            />
          </div>

          <Field>
            <FieldLabel htmlFor="key-expires-at">过期时间</FieldLabel>
            <ExpiryPicker value={draft.expiresOn} onChange={(next) => setDraft({ ...draft, expiresOn: next })} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="key-spending-limit">金额上限（元）</FieldLabel>
              <Input
                id="key-spending-limit"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={draft.spendingYuan}
                placeholder="留空表示不限…"
                onChange={(event) => setDraft({ ...draft, spendingYuan: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="key-concurrency">并发上限</FieldLabel>
              <Input
                id="key-concurrency"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                value={draft.concurrency}
                placeholder="留空表示不限…"
                onChange={(event) => setDraft({ ...draft, concurrency: event.target.value })}
              />
            </Field>
          </div>

          {failure === null ? null : <FieldError>{failure}</FieldError>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
