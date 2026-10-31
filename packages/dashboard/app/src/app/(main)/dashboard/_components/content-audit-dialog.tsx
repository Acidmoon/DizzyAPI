"use client";

/**
 * 内容审核规则的编辑弹窗：新增 / 修改一条规则。
 *
 * 接口：
 * - `POST /api/admin/content-audit` → `{ rule }`（新建）
 * - `PATCH /api/admin/content-audit/:id` → `{ rule }`（修改）
 *
 * 四条纪律：
 * - **`pattern` 是关键词**，只做大小写不敏感子串匹配，**不是正则**——页面必须写清，
 *   否则管理员会写 `^违规.*` 然后发现一个字都拦不住。
 * - **只提交改了的字段**：服务端按字段逐项 diff、逐项写审计。
 * - **`category` / `note` 传 `null` = 清空**（服务端的 `Object.hasOwn` 判「给了没」），
 *   所以清空要显式发 `null`，不能靠「不发这个键」——不发就是不改。
 * - **`action` 只有两种**：`block`（命中拒绝）/ `log`（只记日志）。用自研下拉，不碰原生 select。
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
import { api, adminOps, ApiError, type ContentAuditRuleView } from "@/lib/api";

import { contentAuditActionLabel, createRuleInputOf, draftOf, rulePatchOf, type RuleDraft } from "./content-audit-logic";

export function ContentAuditRuleDialog({
  target,
  onClose,
  onSaved,
}: {
  /** `null` = 关闭；`"new"` = 新建；规则对象 = 编辑。 */
  target: ContentAuditRuleView | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(target === null ? null : draftOf(target === "new" ? null : target));
    setFieldError(null);
  }, [target]);

  if (target === null || draft === null) return null;

  const isNew = target === "new";
  // props 的窄化**不会**带进闭包（`target` 在 `save` 里又变回可空），所以先取一个局部常量。
  const rule = isNew ? null : target;

  async function save(): Promise<void> {
    if (draft === null) return;
    setSaving(true);
    setFieldError(null);
    try {
      if (rule === null) {
        await adminOps.createContentAuditRule(api, createRuleInputOf(draft));
        toast.success("已新增规则");
      } else {
        const patch = rulePatchOf(draft, rule);
        if (patch === "invalid") {
          setFieldError("关键词不能为空");
          setSaving(false);
          return;
        }
        if (Object.keys(patch).length === 0) {
          toast.info("没有改动");
          onClose();
          return;
        }
        await adminOps.updateContentAuditRule(api, rule.id, patch);
        toast.success("已保存");
      }
      onSaved();
    } catch (cause) {
      setFieldError(cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? "新增内容审核规则" : "编辑内容审核规则"}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="rule-pattern">关键词</Label>
            <Input
              id="rule-pattern"
              value={draft.pattern}
              onChange={(event) => setDraft({ ...draft, pattern: event.target.value })}
              placeholder="例如 违禁词…"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              用户输入里包含这段文字就命中（不区分大小写）。不要写正则。
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="rule-action">命中动作</Label>
              <Select
                value={draft.action}
                onValueChange={(value) => setDraft({ ...draft, action: value as "block" | "log" })}
              >
                <SelectTrigger id="rule-action">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="block">{contentAuditActionLabel("block")}（403 CONTENT_BLOCKED）</SelectItem>
                    <SelectItem value="log">{contentAuditActionLabel("log")}（只记日志与计数）</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rule-category">分类</Label>
              <Input
                id="rule-category"
                value={draft.category}
                onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                placeholder="可留空…"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="rule-note">备注</Label>
            <Input
              id="rule-note"
              value={draft.note}
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              placeholder="可留空…"
              autoComplete="off"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="flex flex-col">
              <span className="text-sm font-medium">启用</span>
              <span className="text-xs text-muted-foreground">
                关掉后这条规则不参与匹配，但会留在列表里。
              </span>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })}
              aria-label="启用这条规则"
            />
          </div>

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
