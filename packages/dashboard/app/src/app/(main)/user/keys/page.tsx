"use client";

/**
 * API 密钥 `/user/keys`：列表 + 新建 / 编辑（名称 / 启用 / 三个上限）/ 启停 / 轮换 / 删除 / 复制。
 *
 * 四条纪律：
 * - 完整密钥**只经剪贴板出去**：列表里显示的是掩码（`KeyCopyCell`），明文既不打进
 *   页面文本、也不进 URL / storage / console；新建与轮换的一次性明文只走 `KeySecretDialog`。
 * - 行上只留「编辑 / 轮换 / 删除」；名称、启用、过期时间、金额上限、并发上限全在编辑弹窗里
 *   （owner 的口径：操作收进编辑，不把表单摊在行上）。
 * - 删除与轮换是危险动作 → `AlertDialog` 二次确认（不是 `window.confirm`，那是浏览器默认控件）。
 * - 启停留用乐观更新：先改 UI、失败回滚。
 */

import { useCallback, useEffect, useState } from "react";

import { KeyRound, Plus } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

import { api, errorMessage, keys as keysApi, type ApiKeySummaryView } from "@/lib/api";

import { isUnauthenticated, redirectToLogin } from "../_lib/session";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../_components/page-states";
import { KeyCopyCell } from "./_components/key-copy-cell";
import { KeyEditDialog } from "./_components/key-edit-dialog";
import { KeyNameDialog } from "./_components/key-name-dialog";
import { KeySecretDialog } from "./_components/key-secret-dialog";

export default function UserKeysPage() {
  const [keys, setKeys] = useState<readonly ApiKeySummaryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiKeySummaryView | null>(null);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiKeySummaryView | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ApiKeySummaryView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setKeys((await keysApi.listKeys(api)).items);
    } catch (caught) {
      if (isUnauthenticated(caught)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitCreate = async (name: string) => {
    setPending(true);
    setFormError(null);
    try {
      const created = await keysApi.createKey(api, { name });
      setCreateOpen(false);
      setSecret({ name: created.name, secret: created.secret });
      await load();
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  /** 编辑弹窗保存成功后：用它返回的权威条目替换本行（不整表重取，避免闪一次 loading）。 */
  const applyUpdated = (updated: ApiKeySummaryView) => {
    setEditTarget(null);
    setKeys((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  };

  const toggleEnabled = async (key: ApiKeySummaryView, enabled: boolean) => {
    // 乐观更新：先动 UI，失败回滚成原值并提示。
    setKeys((current) => current.map((item) => (item.id === key.id ? { ...item, enabled } : item)));
    try {
      const updated = await keysApi.updateKey(api, key.id, { enabled });
      setKeys((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (caught) {
      setKeys((current) => current.map((item) => (item.id === key.id ? key : item)));
      toast.error(errorMessage(caught));
    }
  };

  const confirmDelete = async () => {
    if (deleteTarget === null) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await keysApi.deleteKey(api, target.id);
      setKeys((current) => current.filter((item) => item.id !== target.id));
      toast.success("已删除");
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const confirmRotate = async () => {
    if (rotateTarget === null) return;
    const target = rotateTarget;
    setRotateTarget(null);
    try {
      const rotated = await keysApi.rotateKey(api, target.id);
      setSecret({ name: rotated.name, secret: rotated.secret });
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const openCreate = () => {
    setFormError(null);
    setCreateOpen(true);
  };

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">API 密钥</h1>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-3.5" />
          新建密钥
        </Button>
      </div>

      {error === null ? null : <ErrorBlock message={error} onRetry={() => void load()} />}

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>我的密钥</CardTitle>
          <CardDescription>停用后该密钥立即失效；删除不可恢复</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <LoadingBlock rows={5} label="正在加载密钥列表…" /> : null}
          {!loading && error === null && keys.length === 0 ? (
            <EmptyBlock title="还没有 API 密钥" description="新建一把，然后用它调用 /v1/chat/completions">
              <Button size="sm" onClick={openCreate}>
                <KeyRound className="size-3.5" />
                新建密钥
              </Button>
            </EmptyBlock>
          ) : null}
          {!loading && keys.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>密钥</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>最后使用</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">
                      {key.name === "" ? "（未命名）" : key.name}
                      {key.appManaged ? (
                        <Badge variant="outline" className="ml-2">
                          应用托管
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <KeyCopyCell maskedKey={key.maskedKey} secret={key.secret} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={key.enabled}
                          aria-label={`${key.name} 启用开关`}
                          onCheckedChange={(checked) => void toggleEnabled(key, checked)}
                        />
                        <span className="text-xs text-muted-foreground">{key.enabled ? "启用" : "停用"}</span>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(key.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {key.lastUsedAt === null ? "从未使用" : formatDateTime(key.lastUsedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setEditTarget(key)}>
                          编辑
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRotateTarget(key)}>
                          轮换
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          onClick={() => setDeleteTarget(key)}
                        >
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>

      <KeyNameDialog
        open={createOpen}
        initialName=""
        pending={pending}
        error={formError}
        onOpenChange={(open) => {
          if (!open) setCreateOpen(false);
        }}
        onSubmit={(name) => void submitCreate(name)}
      />

      <KeyEditDialog apiKey={editTarget} onClose={() => setEditTarget(null)} onSaved={applyUpdated} />

      <KeySecretDialog secret={secret} onClose={() => setSecret(null)} />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => (open ? undefined : setDeleteTarget(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{deleteTarget?.name ?? ""}」？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后使用这把密钥的调用会立刻收到 401，且无法恢复。确定要删除吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={rotateTarget !== null} onOpenChange={(open) => (open ? undefined : setRotateTarget(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>轮换「{rotateTarget?.name ?? ""}」？</AlertDialogTitle>
            <AlertDialogDescription>
              旧密钥会立刻失效，需要把新密钥替换到所有调用方，否则请求会 401。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmRotate()}>轮换</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
