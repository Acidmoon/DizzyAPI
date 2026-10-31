"use client";

/**
 * 批量导入上游账号弹窗（管理员）。
 *
 * 接口：
 * - `POST /api/accounts/import` → 按来源导入（`new-api` / `sub2api` / `plain-keys`）
 * - `POST /api/accounts/import/preview` → 预检（**不含凭据**，只有识别结果）
 *
 * ## 三种来源（服务端 `packages/account-admin/src/import-sources.ts`）
 *
 * | 来源 | payload 长什么样 |
 * |---|---|
 * | `new-api` | new-api 的 Channel 对象（`type` / `key` / `name` / `base_url` / `models` / `model_mapping` / `priority`） |
 * | `sub2api` | sub2api 的导出文件（`{ type: 'sub2api-data', version, proxies, accounts }`） |
 * | `plain-keys` | 一行一个 key |
 * | `auto` | 按 payload 形状自己推断 |
 *
 * ## 四条纪律
 *
 * - **payload 里全是凭据**：只走 POST body，绝不进 URL、不打 console、不写 storage。
 * - **预检不泄露凭据**：预检结果只有「识别成了什么、有哪些字段」，服务端保证不回显密钥。
 * - **导入结果逐项看**：成功 / 失败分开，失败的给稳定 `code` 与人话原因；
 *   一条失败不影响同批的其它项。
 * - **下拉用自研 `Select`**：来源与默认值都不碰浏览器原生控件。
 */
import { useState } from "react";

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
import { Textarea } from "@/components/ui/textarea";
import { api, adminUsers, ApiError } from "@/lib/api";

import { kindLabel, providerLabel, type AccountKind, type AccountProvider } from "./account-create-logic";

type ImportSource = "auto" | "new-api" | "sub2api" | "plain-keys";

const SOURCES: readonly ImportSource[] = ["auto", "new-api", "sub2api", "plain-keys"];

function sourceLabel(source: ImportSource): string {
  if (source === "auto") return "自动识别";
  if (source === "new-api") return "new-api 渠道 JSON";
  if (source === "sub2api") return "sub2api 导出文件";
  return "一行一个 key";
}

/** 导入结果的一项（服务端 `BulkOperationItemResult` 的形状）。 */
interface ImportItem {
  readonly index: number;
  readonly ok: boolean;
  readonly account: { readonly id: string; readonly label: string } | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

/** 导入的整体结果（服务端 `BulkImportResult` 的形状）。 */
interface ImportResult {
  readonly total: number;
  readonly created: number;
  readonly failed: number;
  readonly items: readonly ImportItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把服务端的返回收窄成导入结果；形状对不上返回 `null`。 */
function importResultOf(value: unknown): ImportResult | null {
  if (!isRecord(value)) return null;
  const itemsRaw = Array.isArray(value.items) ? value.items : [];
  const items: ImportItem[] = [];
  for (const raw of itemsRaw) {
    if (!isRecord(raw)) continue;
    const accountRaw = isRecord(raw.account) ? raw.account : null;
    const errorRaw = isRecord(raw.error) ? raw.error : null;
    items.push({
      index: typeof raw.index === "number" ? raw.index : items.length,
      ok: raw.ok === true,
      account:
        accountRaw !== null && typeof accountRaw.id === "string"
          ? { id: accountRaw.id, label: typeof accountRaw.label === "string" ? accountRaw.label : accountRaw.id }
          : null,
      error:
        errorRaw !== null && typeof errorRaw.message === "string"
          ? {
              code: typeof errorRaw.code === "string" ? errorRaw.code : "",
              message: errorRaw.message,
            }
          : null,
    });
  }
  return {
    total: typeof value.total === "number" ? value.total : items.length,
    created: typeof value.created === "number" ? value.created : items.filter((item) => item.ok).length,
    failed: typeof value.failed === "number" ? value.failed : items.filter((item) => !item.ok).length,
    items,
  };
}

export function AccountImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [source, setSource] = useState<ImportSource>("auto");
  const [payload, setPayload] = useState("");
  const [provider, setProvider] = useState<AccountProvider>("openai");
  const [kind, setKind] = useState<AccountKind>("api_key");
  const [labelPrefix, setLabelPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  function reset(): void {
    setPayload("");
    setFieldError(null);
    setResult(null);
  }

  async function submit(): Promise<void> {
    if (payload.trim() === "") {
      setFieldError("要导入的内容不能为空");
      return;
    }
    setBusy(true);
    setFieldError(null);
    try {
      const raw = await adminUsers.importAccounts(api, {
        source,
        payload,
        defaults: {
          provider,
          kind,
          ...(labelPrefix.trim() === "" ? {} : { labelPrefix: labelPrefix.trim() }),
        },
      });
      const parsed = importResultOf(raw);
      if (parsed === null) {
        setFieldError("导入结果看不懂（服务端返回了预期外的形状）");
        return;
      }
      setResult(parsed);
      if (parsed.created > 0) {
        toast.success(`已导入 ${String(parsed.created)} 个账号`);
        onImported();
      } else {
        toast.error("一个都没导入成功");
      }
    } catch (cause) {
      setFieldError(cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "导入失败");
    } finally {
      setBusy(false);
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>批量导入上游账号</DialogTitle>
          <DialogDescription>
            支持 new-api 渠道 JSON、sub2api 导出文件、一行一个 key。内容只随这一次请求发送。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="import-source">来源</Label>
              <Select value={source} onValueChange={(value) => setSource(value as ImportSource)}>
                <SelectTrigger id="import-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {SOURCES.map((item) => (
                      <SelectItem key={item} value={item}>
                        {sourceLabel(item)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="import-label-prefix">名称前缀</Label>
              <Input
                id="import-label-prefix"
                value={labelPrefix}
                onChange={(event) => setLabelPrefix(event.target.value)}
                placeholder="可留空…"
                autoComplete="off"
              />
            </div>
          </div>

          {source === "plain-keys" || source === "auto" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="import-provider">默认提供商</Label>
                <Select
                  value={provider}
                  onValueChange={(value) => setProvider(value as AccountProvider)}
                >
                  <SelectTrigger id="import-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="claude">{providerLabel("claude")}</SelectItem>
                      <SelectItem value="openai">{providerLabel("openai")}</SelectItem>
                      <SelectItem value="custom">{providerLabel("custom")}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="import-kind">默认类型</Label>
                <Select value={kind} onValueChange={(value) => setKind(value as AccountKind)}>
                  <SelectTrigger id="import-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="api_key">{kindLabel("api_key")}</SelectItem>
                      <SelectItem value="oauth">{kindLabel("oauth")}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor="import-payload">要导入的内容</Label>
            <Textarea
              id="import-payload"
              rows={8}
              value={payload}
              onChange={(event) => setPayload(event.target.value)}
              placeholder={"new-api 渠道 JSON / sub2api 导出文件 / 一行一个 key…"}
              className="font-mono text-xs"
              autoComplete="off"
            />
          </div>

          {fieldError === null ? null : <p className="text-xs text-destructive">{fieldError}</p>}

          {result === null ? null : (
            <div className="grid gap-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline" className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                  成功 {String(result.created)}
                </Badge>
                {result.failed > 0 ? (
                  <Badge variant="outline" className="bg-destructive/15 text-destructive">
                    失败 {String(result.failed)}
                  </Badge>
                ) : null}
                <span className="text-xs text-muted-foreground">共 {String(result.total)} 项</span>
              </div>
              {result.items
                .filter((item) => !item.ok)
                .slice(0, 10)
                .map((item) => (
                  <p key={item.index} className="text-xs text-destructive">
                    第 {String(item.index + 1)} 项：{item.error?.message ?? "失败"}
                    {item.error?.code === undefined || item.error.code === "" ? "" : `（${item.error.code}）`}
                  </p>
                ))}
              {result.failed > 10 ? (
                <p className="text-xs text-muted-foreground">还有 {String(result.failed - 10)} 项失败未列出。</p>
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={busy}
          >
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "导入中…" : "导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
