"use client";

/**
 * 客户端指纹档案管理（`/dashboard/clients`）。
 *
 * ## 左列表、右表单
 *
 * 左栏按**内置 / 自定义**分组（内置可改、可停用、可恢复出厂，但**不能删**）；
 * 右栏是当前选中档案的表单，`新建档案` 切到空表单。
 *
 * ## 为什么这块要存在
 *
 * 有的上游按客户端指纹判定来源：不带 `x-opencode-session` 的裸 HTTP 请求会被
 * `HTTP 400: Request is missing x-opencode-session and cannot be routed efficiently` 直接拒。
 * 档案 = 一组要贴到上游请求上的头 + 一个 UA；账号在编辑弹窗里挑一档挂上。
 *
 * ## 三条纪律
 *
 * - **档案里没有秘密**：只有头名与头值模板（`{{uuid}}` / `{{session}}` / `{{timestamp}}`），
 *   受保护头（鉴权 / Host / Accept / Content-Type / UA / Cookie）服务端一律拒，前端先提示；
 * - **只发改了的键**：`clientUpdatePatchOf` 算出补丁，一个键都没变就不发请求；
 * - 删除 / 恢复出厂都走二次确认（不可撤销）。
 */
import { useCallback, useEffect, useState } from "react";

import { Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, adminClients, ApiError, type ClientProfileView } from "@/lib/api";

import { ClientProfileForm } from "./client-profile-form";
import { ClientProfileConfirmDialog, type ClientProfileAction } from "./client-profile-confirm-dialog";
import {
  clientCreateBodyOf,
  clientDraftIssues,
  clientDraftOf,
  clientMaskSummary,
  clientUpdatePatchOf,
  emptyClientDraft,
  groupProfiles,
  profileSubtitle,
  type ClientDraft,
} from "./client-mask-logic";
import { DataState } from "./data-state";
import { useResource } from "./use-resource";

/** 新建模式的选择标记（真实档案 id 不会以 `__` 开头：服务端要求小写字母/数字开头）。 */
const NEW_MARK = "__new__";

export function ClientsBoard() {
  const load = useCallback(() => adminClients.listClientMasks(api), []);
  const { data, error, loading, reload } = useResource(load);
  const items = data?.items ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ClientDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<{ action: ClientProfileAction; profile: ClientProfileView } | null>(null);

  const isNew = selectedId === NEW_MARK;
  const selected = items.find((profile) => profile.id === selectedId) ?? null;

  const selectProfile = useCallback((profile: ClientProfileView): void => {
    setSelectedId(profile.id);
    setDraft(clientDraftOf(profile));
  }, []);

  // 首次取到数据就选第一条，避免右栏一进来是空的。
  useEffect(() => {
    if (draft !== null || items.length === 0) return;
    selectProfile(items[0] as ClientProfileView);
  }, [draft, items, selectProfile]);

  function startNew(): void {
    setSelectedId(NEW_MARK);
    setDraft(emptyClientDraft());
  }

  async function save(): Promise<void> {
    if (draft === null) return;
    if (isNew) {
      const body = clientCreateBodyOf(draft);
      if (body === "invalid") return;
      setSaving(true);
      try {
        const created = await adminClients.createClientMask(api, body as Parameters<typeof adminClients.createClientMask>[1]);
        toast.success(`已新建档案「${created.profile.label}」`);
        selectProfile(created.profile);
        reload();
      } catch (cause) {
        toast.error(cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "保存失败");
      } finally {
        setSaving(false);
      }
      return;
    }

    if (selected === null) return;
    const patch = clientUpdatePatchOf(draft, selected);
    if (patch === "invalid") return;
    if (Object.keys(patch).length === 0) {
      toast.info("没有改动");
      return;
    }
    setSaving(true);
    try {
      const updated = await adminClients.updateClientMask(
        api,
        selected.id,
        patch as Parameters<typeof adminClients.updateClientMask>[2],
      );
      toast.success(`已保存档案「${updated.profile.label}」`);
      selectProfile(updated.profile);
      reload();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? `${cause.message}（${cause.code}）` : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  const issues = draft === null ? [] : clientDraftIssues(draft, isNew);
  const groups = groupProfiles(items);

  function ProfileRow({ profile }: { profile: ClientProfileView }) {
    const active = profile.id === selectedId;
    return (
      <button
        type="button"
        onClick={() => selectProfile(profile)}
        aria-current={active ? "true" : undefined}
        className={`flex w-full flex-col items-start gap-1 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
          active ? "border-primary bg-muted/60" : "hover:bg-muted/40"
        }`}
      >
        <span className="flex w-full items-center justify-between gap-2">
          <span className="font-medium">{profile.label}</span>
          {profile.enabled ? null : (
            <Badge variant="outline" className="bg-muted text-muted-foreground">
              已停用
            </Badge>
          )}
        </span>
        <span className="text-xs text-muted-foreground">{profileSubtitle(profile)}</span>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">客户端档案</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={reload}>
            <RefreshCw /> 刷新
          </Button>
          <Button onClick={startNew}>
            <Plus /> 新建档案
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">
            {clientMaskSummary(data === null ? null : data.status)}
          </CardTitle>
        </CardHeader>
      </Card>

      <DataState
        loading={loading}
        error={error}
        empty={items.length === 0 && !isNew}
        onRetry={reload}
        emptyTitle="还没有客户端档案"
        emptyDescription="点右上角「新建档案」，或者刷新一次让插件补齐内置预置。"
      >
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">档案</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {groups.builtin.length === 0 ? null : (
                <div className="grid gap-1">
                  <span className="text-xs font-medium tracking-wide text-muted-foreground">内置</span>
                  {groups.builtin.map((profile) => (
                    <ProfileRow key={profile.id} profile={profile} />
                  ))}
                </div>
              )}
              {groups.custom.length === 0 ? null : (
                <div className="grid gap-1">
                  <span className="text-xs font-medium tracking-wide text-muted-foreground">自定义</span>
                  {groups.custom.map((profile) => (
                    <ProfileRow key={profile.id} profile={profile} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">
                {isNew ? "新建档案" : (selected?.label ?? "选择左侧档案")}
              </CardTitle>
              <div className="flex flex-wrap gap-2">
                {isNew || selected === null ? null : (
                  <>
                    {selected.builtin ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setConfirm({ action: "reset", profile: selected })}
                      >
                        恢复出厂
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setConfirm({ action: "delete", profile: selected })}
                      >
                        删除
                      </Button>
                    )}
                  </>
                )}
                <Button size="sm" onClick={() => void save()} disabled={saving || draft === null || issues.length > 0}>
                  {saving ? "保存中…" : "保存"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {draft === null ? (
                <p className="text-sm text-muted-foreground">左侧选一个档案，或者点「新建档案」。</p>
              ) : (
                <div className="flex flex-col gap-3">
                  <ClientProfileForm
                    draft={draft}
                    isNew={isNew}
                    issues={issues}
                    onChange={(patch) => setDraft((current) => (current === null ? current : { ...current, ...patch }))}
                  />
                  {issues.length === 0 ? null : (
                    <p className="text-xs text-destructive">{issues[0]?.message}</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </DataState>

      {confirm === null ? null : (
        <ClientProfileConfirmDialog
          action={confirm.action}
          profile={confirm.profile}
          onClose={() => setConfirm(null)}
          onDone={() => {
            setConfirm(null);
            setDraft(null);
            setSelectedId(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
