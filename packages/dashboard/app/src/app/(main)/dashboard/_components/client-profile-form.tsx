"use client";

/**
 * 客户端档案的编辑表单（右栏）。
 *
 * 只负责「把草稿画出来、把改动交上去」，**不自己发请求**：保存 / 删除 / 恢复出厂都在
 * `clients-board.tsx` 里做，错误也在那里统一提示。
 *
 * 三条：
 * - 头是**一行一个 name / value**，末行空着也算「没填」（提交时丢掉空名字的行）；
 * - 字段级错误就近显示（服务端也会拒，这里只是别让人白填）；
 * - 下拉与开关全用自研控件，不出现原生 `<select>` / `window.confirm`。
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import {
  addHeaderRow,
  MAX_HEADERS_PER_PROFILE,
  removeHeaderRow,
  updateHeaderRow,
  type ClientDraft,
  type ClientDraftIssue,
} from "./client-mask-logic";

/** 取某个字段的错误文案（没有就 null）。 */
function issueOf(issues: readonly ClientDraftIssue[], field: string): string | null {
  return issues.find((issue) => issue.field === field)?.message ?? null;
}

/** 就近显示的错误行。 */
function FieldError({ message }: { message: string | null }) {
  return message === null ? null : <p className="text-xs text-destructive">{message}</p>;
}

export function ClientProfileForm({
  draft,
  isNew,
  issues,
  onChange,
}: {
  draft: ClientDraft;
  isNew: boolean;
  issues: readonly ClientDraftIssue[];
  onChange: (patch: Partial<ClientDraft>) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="client-profile-id">档案 id</Label>
          <Input
            id="client-profile-id"
            value={draft.id}
            readOnly={!isNew}
            disabled={!isNew}
            onChange={(event) => onChange({ id: event.target.value })}
            placeholder="例如 opencode…"
            autoComplete="off"
            className="font-mono"
          />
          <FieldError message={issueOf(issues, "id")} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="client-profile-label">名称</Label>
          <Input
            id="client-profile-label"
            value={draft.label}
            onChange={(event) => onChange({ label: event.target.value })}
            placeholder="例如 opencode 客户端…"
            autoComplete="off"
          />
          <FieldError message={issueOf(issues, "label")} />
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="client-profile-description">说明</Label>
        <Input
          id="client-profile-description"
          value={draft.description}
          onChange={(event) => onChange({ description: event.target.value })}
          placeholder="给自己看的备注，可留空…"
          autoComplete="off"
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="client-profile-user-agent">User-Agent</Label>
        <Input
          id="client-profile-user-agent"
          value={draft.userAgent}
          onChange={(event) => onChange({ userAgent: event.target.value })}
          placeholder="留空 = 沿用网关默认…"
          autoComplete="off"
          className="font-mono text-xs"
        />
        <FieldError message={issueOf(issues, "userAgent")} />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
        <span className="text-sm font-medium">启用</span>
        <Switch
          checked={draft.enabled}
          onCheckedChange={(checked) => onChange({ enabled: checked })}
          aria-label="启用这个客户端档案"
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <span className="text-sm font-medium">请求头</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onChange({ headers: addHeaderRow(draft.headers) })}
            disabled={draft.headers.length >= MAX_HEADERS_PER_PROFILE}
          >
            添加一行
          </Button>
        </div>
        <FieldError message={issueOf(issues, "headers")} />

        {draft.headers.length === 0 ? (
          <p className="text-xs text-muted-foreground">还没有请求头：这个档案只改 User-Agent。</p>
        ) : null}

        <div className="flex flex-col gap-2">
          {draft.headers.map((header, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <div className="grid gap-1">
                <Input
                  aria-label={`第 ${String(index + 1)} 行头名`}
                  value={header.name}
                  onChange={(event) =>
                    onChange({ headers: updateHeaderRow(draft.headers, index, { name: event.target.value }) })
                  }
                  placeholder="例如 x-opencode-session…"
                  autoComplete="off"
                  className="font-mono text-xs"
                />
                <FieldError message={issueOf(issues, `headers.${String(index)}.name`)} />
              </div>
              <div className="grid gap-1">
                <Input
                  aria-label={`第 ${String(index + 1)} 行头值`}
                  value={header.value}
                  onChange={(event) =>
                    onChange({ headers: updateHeaderRow(draft.headers, index, { value: event.target.value }) })
                  }
                  placeholder="例如 {{session}}…"
                  autoComplete="off"
                  className="font-mono text-xs"
                />
                <FieldError message={issueOf(issues, `headers.${String(index)}.value`)} />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => onChange({ headers: removeHeaderRow(draft.headers, index) })}
              >
                删除行
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="client-profile-preview">展开示例</Label>
        <Textarea
          id="client-profile-preview"
          rows={3}
          readOnly
          value={draft.headers
            .filter((header) => header.name.trim() !== "")
            .map((header) => `${header.name.trim()}: ${header.value}`)
            .join("\n")}
          placeholder="填了请求头这里会显示贴到上游的样子…"
          className="font-mono text-xs"
        />
      </div>
    </div>
  );
}
