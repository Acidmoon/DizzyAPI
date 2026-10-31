"use client";

/**
 * 设置编辑弹窗：改一个命名空间里的可写字段。
 *
 * 接口：`POST /api/settings/:ns` + body `{ patch, expectedRevision? }`。
 *
 * 五条纪律：
 * - **只提交改了的字段**：服务端逐项 diff、逐项写审计。
 * - **patch 必须是嵌套对象**：服务端 `mergeConfig` 按普通对象递归合并，
 *   扁平的点分键能过校验但**不生效**（见 `settings-logic.ts` 的 `patchFromPaths`）。
 * - **乐观锁**：`expectedRevision` 带上服务端给的 revision；别人先改过会回
 *   409 `SETTINGS_CONFLICT`，那时要重新拉一次再改，不能覆盖别人的改动。
 * - **秘密字段不可写**：服务端只回「配没配」，秘密只能走凭据插件。
 * - **秘密值绝不进页面**：值根本不回传，页面也不许尝试显示。
 */
import { useEffect, useMemo, useState } from "react";

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
import { Switch } from "@/components/ui/switch";
import { api, adminOps, ApiError } from "@/lib/api";

import {
  fieldInputText,
  fieldValueText,
  integerFieldValue,
  patchFromPaths,
  stringArrayFieldValue,
  textFieldValue,
  type SettingsFieldLocal,
  type SettingsNamespaceLocal,
} from "./settings-logic";

/** 可写的**叶子**字段（`object` 字段本身不可直接写，只能改它的子字段）。 */
function writableLeaves(fields: readonly SettingsFieldLocal[]): SettingsFieldLocal[] {
  const out: SettingsFieldLocal[] = []
  for (const field of fields) {
    if (field.kind === "object") {
      if (field.children !== undefined) out.push(...writableLeaves(field.children))
      continue
    }
    if (field.writable && !field.secret) out.push(field)
  }
  return out
}

export function SettingsEditDialog({
  namespace,
  onClose,
  onSaved,
}: {
  namespace: SettingsNamespaceLocal | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const leaves = useMemo(
    () => (namespace === null ? [] : writableLeaves(namespace.fields)),
    [namespace],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [booleans, setBooleans] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (namespace === null) {
      setValues({});
      setBooleans({});
      return;
    }
    const nextValues: Record<string, string> = {};
    const nextBooleans: Record<string, boolean> = {};
    for (const field of leaves) {
      if (field.kind === "boolean") {
        nextBooleans[field.path] = field.value === true;
        continue;
      }
      nextValues[field.path] = fieldInputText(field.value);
    }
    setValues(nextValues);
    setBooleans(nextBooleans);
    setFieldError(null);
  }, [namespace, leaves]);

  if (namespace === null) return null;

  async function save(): Promise<void> {
    if (namespace === null) return;
    const edits: Record<string, unknown> = {};
    for (const field of leaves) {
      if (field.kind === "boolean") {
        const current = field.value === true;
        const next = booleans[field.path] ?? current;
        if (next !== current) edits[field.path] = next;
        continue;
      }
      const raw = values[field.path] ?? "";
      const currentText = fieldInputText(field.value);
      if (raw === currentText) continue;
      if (field.kind === "integer") {
        const parsed = integerFieldValue(raw)
        if (parsed === "invalid") {
          setFieldError(`「${field.label}」要填整数`)
          return
        }
        edits[field.path] = parsed
        continue
      }
      if (field.kind === "stringArray") {
        edits[field.path] = stringArrayFieldValue(raw)
        continue
      }
      edits[field.path] = textFieldValue(raw)
    }

    if (Object.keys(edits).length === 0) {
      toast.info("没有改动");
      onClose();
      return;
    }

    setSaving(true);
    setFieldError(null);
    try {
      await adminOps.updateSettings(
        api,
        namespace.ns,
        patchFromPaths(edits),
        namespace.revision ?? undefined,
      );
      toast.success("已保存，目标插件会软重启以应用新配置");
      onSaved();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "SETTINGS_CONFLICT") {
        setFieldError("设置已经被别人改过（版本对不上）。请关掉这个窗口重新打开再改。")
      } else {
        setFieldError(cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "保存失败")
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑设置「{namespace.ns}」</DialogTitle>
          <DialogDescription>
            只提交改动的字段；每项改动服务端都会记一条审计（只记字段名，不记值）。
            保存后目标插件会**软重启**以应用新配置。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {leaves.length === 0 ? (
            <p className="text-sm text-muted-foreground">这个命名空间没有可在运行期改写的字段。</p>
          ) : null}

          {leaves.map((field) =>
            field.kind === "boolean" ? (
              <div
                key={field.path}
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{field.label}</span>
                  <span className="text-xs text-muted-foreground">
                    当前：{fieldValueText(field.value)}
                    {field.unit === undefined ? "" : ` ${field.unit}`}
                  </span>
                </div>
                <Switch
                  checked={booleans[field.path] ?? field.value === true}
                  onCheckedChange={(checked) =>
                    setBooleans({ ...booleans, [field.path]: checked })
                  }
                  aria-label={field.label}
                />
              </div>
            ) : (
              <div key={field.path} className="grid gap-2">
                <Label htmlFor={`setting-${field.path}`}>{field.label}</Label>
                <Input
                  id={`setting-${field.path}`}
                  value={values[field.path] ?? ""}
                  onChange={(event) =>
                    setValues({ ...values, [field.path]: event.target.value })
                  }
                  placeholder={
                    field.kind === "stringArray" ? "每行一个…" : "留空表示清空…"
                  }
                  inputMode={field.kind === "integer" ? "numeric" : "text"}
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  {field.path}
                  {field.unit === undefined ? "" : ` · 单位 ${field.unit}`}
                  {field.min === undefined || field.max === undefined
                    ? ""
                    : ` · 范围 ${String(field.min)}..${String(field.max)}`}
                  {field.kind === "stringArray" ? " · 每行一个" : ""}
                </p>
              </div>
            ),
          )}

          {fieldError === null ? null : <p className="text-xs text-destructive">{fieldError}</p>}
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
