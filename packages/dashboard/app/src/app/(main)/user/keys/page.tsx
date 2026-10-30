"use client";

/**
 * API 密钥 `/user/keys`：列表 + 新建 / 改名 / 启停 / 轮换 / 删除。
 *
 * 三条纪律：
 * - 完整密钥**只在新建 / 轮换的那一次**出现（`KeySecretDialog`），关掉即清空；
 *   页面不复述明文、不写 URL、不落 storage、不打 console。
 * - 删除与轮换是危险动作 → `AlertDialog` 二次确认（不是 `window.confirm`，那是浏览器默认控件）。
 * - 启停走乐观更新：先改 UI、失败回滚（`交互` 的阶段 2 `mutations.ts` 落地前，这里用同一套语义的最小实现）。
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

import {
  createKey,
  fetchKeys,
  messageOfError,
  redirectToLogin,
  removeKey,
  rotateKey,
  updateKey,
} from "../_lib/api";
import type { ApiKeySummary } from "../_lib/types";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../_components/page-states";
import { KeyNameDialog } from "./_components/key-name-dialog";
import { KeySecretDialog } from "./_components/key-secret-dialog";

type NameDialogState =
  | { readonly mode: "create" }
  | { readonly mode: "rename"; readonly key: ApiKeySummary }
  | null;

export default function UserKeysPage() {
  const [keys, setKeys] = useState<readonly ApiKeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialogState>(null);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiKeySummary | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ApiKeySummary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setKeys(await fetchKeys());
    } catch (caught) {
      if ((caught as { unauthenticated?: boolean }).unauthenticated === true) {
        redirectToLogin();
        return;
      }
      setError(messageOfError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitName = async (name: string) => {
    if (nameDialog === null) return;
    setPending(true);
    setFormError(null);
    try {
      if (nameDialog.mode === "create") {
        const created = await createKey(name);
        setNameDialog(null);
        setSecret({ name: created.name, secret: created.secret });
        await load();
      } else {
        const updated = await updateKey(nameDialog.key.id, { name });
        setNameDialog(null);
        setKeys((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        toast.success("名称已更新");
      }
    } catch (caught) {
      setFormError(messageOfError(caught));
    } finally {
      setPending(false);
    }
  };

  const toggleEnabled = async (key: ApiKeySummary, enabled: boolean) => {
    // 乐观更新：先动 UI，失败回滚成原值并提示。
    setKeys((current) => current.map((item) => (item.id === key.id ? { ...item, enabled } : item)));
    try {
      const updated = await updateKey(key.id, { enabled });
      setKeys((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (caught) {
      setKeys((current) => current.map((item) => (item.id === key.id ? key : item)));
      toast.error(messageOfError(caught));
    }
  };

  const confirmDelete = async () => {
    if (deleteTarget === null) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await removeKey(target.id);
      setKeys((current) => current.filter((item) => item.id !== target.id));
      toast.success("已删除");
    } catch (caught) {
      toast.error(messageOfError(caught));
    }
  };

  const confirmRotate = async () => {
    if (rotateTarget === null) return;
    const target = rotateTarget;
    setRotateTarget(null);
    try {
      const rotated = await rotateKey(target.id);
      setSecret({ name: rotated.name, secret: rotated.secret });
      await load();
    } catch (caught) {
      toast.error(messageOfError(caught));
    }
  };

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">API 密钥</h1>
          <p className="text-sm text-muted-foreground">密钥等同于密码，请只放在服务端环境变量里</p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setFormError(null);
            setNameDialog({ mode: "create" });
          }}
        >
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
              <Button
                size="sm"
                onClick={() => {
                  setFormError(null);
                  setNameDialog({ mode: "create" });
                }}
              >
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
                    <TableCell className="font-mono text-xs text-muted-foreground">{key.maskedKey}</TableCell>
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
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setFormError(null);
                            setNameDialog({ mode: "rename", key });
                          }}
                        >
                          改名
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
        open={nameDialog !== null}
        mode={nameDialog?.mode ?? "create"}
        initialName={nameDialog?.mode === "rename" ? nameDialog.key.name : ""}
        pending={pending}
        error={formError}
        onOpenChange={(open) => {
          if (!open) setNameDialog(null);
        }}
        onSubmit={(name) => void submitName(name)}
      />

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
