"use client";

/**
 * 设置（`/dashboard/settings`）：各命名空间的运行期配置 + 可写字段的编辑弹窗。
 *
 * 接口（要管理员权限）：
 * - `GET /api/settings` → `{ namespaces }`
 * - `POST /api/settings/:ns` → 改设置（`{ patch, expectedRevision? }`）
 * - `DELETE /api/settings/:ns` → 重置成 `app.yml` 的基线
 *
 * 六条纪律：
 * - **秘密字段只显示「已配置 / 未配置」，绝不回显值**：服务端根本不返回秘密的值，
 *   页面也不许尝试显示。秘密只能走凭据插件改。
 * - **`app.yml` 是基线**：覆盖落在设置插件自己的文件里；「重置」是清掉覆盖、
 *   回到基线，**不会改 `app.yml`**（`app.yml` 是人写的，带注释）。
 * - **保存后目标插件软重启**：改的是运行期配置，不是重启整个进程。
 * - **乐观锁**：带 `expectedRevision`，别人先改过就 409，要重新拉一次再改。
 * - **只提交改了的字段**：服务端逐项 diff、逐项写审计。
 * - **`pending`（有覆盖但没能应用）要说清**：目标缺失 / 被禁用 / 尚未装载时，
 *   覆盖会留着等重放——管理员需要知道「改了但还没生效」。
 */
import { useCallback, useState } from "react";

import { Pencil, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, adminOps, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

import { DataState } from "./data-state";
import { SettingsEditDialog } from "./settings-edit-dialog";
import { fieldValueText, settingsNamespacesOf, type SettingsNamespaceLocal } from "./settings-logic";
import { useResource } from "./use-resource";

/** 命名空间的状态徽标：活动 / 未活动 / 被禁用 / 有覆盖 / 待应用。 */
function NamespaceBadges({ namespace }: { namespace: SettingsNamespaceLocal }) {
  return (
    <div className="flex flex-wrap gap-1">
      {namespace.active ? (
        <Badge variant="outline" className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
          活动
        </Badge>
      ) : (
        <Badge variant="outline" className="bg-muted text-muted-foreground">
          未活动
        </Badge>
      )}
      {namespace.disabled ? (
        <Badge variant="outline" className="bg-muted text-muted-foreground">
          已禁用
        </Badge>
      ) : null}
      {namespace.overridden ? (
        <Badge variant="outline" className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
          有覆盖
        </Badge>
      ) : null}
      {namespace.pending ? (
        <Badge variant="outline" className="bg-destructive/15 text-destructive">
          待应用
        </Badge>
      ) : null}
    </div>
  );
}

export function SettingsBoard() {
  const [editing, setEditing] = useState<SettingsNamespaceLocal | null>(null);
  const [resetting, setResetting] = useState<SettingsNamespaceLocal | null>(null);

  const load = useCallback(async () => {
    const raw = await adminOps.fetchSettings(api);
    return { namespaces: settingsNamespacesOf(raw) };
  }, []);
  const { data, error, loading, reload } = useResource(load);
  const namespaces = data?.namespaces ?? [];

  async function resetNamespace(namespace: SettingsNamespaceLocal): Promise<void> {
    try {
      await adminOps.resetSettings(api, namespace.ns);
      toast.success(`已把「${namespace.ns}」重置为 app.yml 的基线`);
      setResetting(null);
      reload();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "重置失败");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">设置</h1>
                  </div>
        <Button variant="outline" onClick={reload}>
          <RefreshCw /> 刷新
        </Button>
      </div>

      <DataState
        loading={loading}
        error={error}
        empty={namespaces.length === 0}
        onRetry={reload}
        emptyTitle="没有可展示的命名空间"
        emptyDescription="设置服务不在运行时会返回 503（SETTINGS_UNAVAILABLE）。"
      >
        <div className="flex flex-col gap-4">
          {namespaces.map((namespace) => (
            <Card key={namespace.ns}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <CardTitle className="text-base font-mono">{namespace.ns}</CardTitle>
                    <div className="flex flex-wrap items-center gap-2">
                      <NamespaceBadges namespace={namespace} />
                      <span className="text-xs text-muted-foreground">{namespace.plugin}</span>
                    </div>
                    {namespace.pending ? (
                      <p className="text-xs text-destructive">
                        有覆盖但**没能应用**：目标
                        {namespace.pendingReason === "missing"
                          ? "已不在插件树上"
                          : namespace.pendingReason === "disabled"
                            ? "被禁用"
                            : "尚未装载"}
                        。覆盖会留着，等它就绪后自动重放。
                      </p>
                    ) : null}
                    {namespace.revision === null ? null : (
                      <p className="text-xs text-muted-foreground">
                        revision <span className="font-mono">{namespace.revision}</span>
                        {namespace.updatedAt === null ? "" : ` · 更新于 ${formatDateTime(namespace.updatedAt)}`}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!namespace.writable}
                      onClick={() => setEditing(namespace)}
                    >
                      <Pencil /> 编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!namespace.overridden}
                      onClick={() => setResetting(namespace)}
                    >
                      <RotateCcw /> 重置
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="pl-4 py-2 font-normal">字段</th>
                        <th className="py-2 font-normal">名称</th>
                        <th className="py-2 font-normal">类型</th>
                        <th className="py-2 font-normal">当前值</th>
                        <th className="pr-4 py-2 font-normal">写</th>
                      </tr>
                    </thead>
                    <tbody>
                      {namespace.fields.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="pl-4 py-3 text-xs text-muted-foreground">
                            这个命名空间没有声明字段（整个配置面只读）。
                          </td>
                        </tr>
                      ) : null}
                      {namespace.fields.map((field) => (
                        <tr key={field.path} className="border-b last:border-b-0">
                          <td className="pl-4 py-2 font-mono text-xs">{field.path}</td>
                          <td className="py-2 text-sm">{field.label}</td>
                          <td className="py-2 text-xs text-muted-foreground">{field.kind}</td>
                          <td className="py-2 text-sm">
                            {field.secret ? (
                              <Badge
                                variant="outline"
                                className={
                                  field.configured === true
                                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                                    : "bg-muted text-muted-foreground"
                                }
                              >
                                {field.configured === true ? "已配置" : "未配置"}
                              </Badge>
                            ) : (
                              fieldValueText(field.value)
                            )}
                          </td>
                          <td className="pr-4 py-2">
                            {field.writable ? (
                              field.secret ? (
                                <span className="text-xs text-muted-foreground">只可走凭据插件</span>
                              ) : (
                                <Badge variant="outline" className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                                  可写
                                </Badge>
                              )
                            ) : (
                              <span className="text-xs text-muted-foreground">只读</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </DataState>

      <SettingsEditDialog
        namespace={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />

      <AlertDialog
        open={resetting !== null}
        onOpenChange={(open) => (open ? undefined : setResetting(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>把「{resetting?.ns ?? ""}」重置为基线？</AlertDialogTitle>
            <AlertDialogDescription>
              会清掉这个命名空间的**运行期覆盖**，回到 <code className="font-mono">app.yml</code> 里写的值。
              <code className="font-mono">app.yml</code> 本身不会被改。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (resetting !== null) void resetNamespace(resetting);
              }}
            >
              重置
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
