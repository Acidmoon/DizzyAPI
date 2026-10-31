"use client";

/**
 * 个人资料 `/user/profile`：改名 / 头像 / 改密码。
 *
 * 三条纪律：
 * - **密码只走 POST body**：不进 URL、不进 localStorage、不打 console；
 *   输入框 `type="password"`、`autoComplete` 按用途给对（当前密码 / 新密码），
 *   提交成功后**立刻清空输入框**（不留在 React state 里）。
 * - **头像只接受 http(s)**（服务端校验）；留空表示清除，不是「不改」。
 * - 界面偏好（字号 / 字距）不在这里：那是旧 `web` 插件的服务端 CSS 生成，新前端走模板自己的
 *   主题 / 密度控件（页头右侧），所以本页**不重复造一套**。
 */

import { useCallback, useEffect, useState } from "react";

import { KeyRound, UserRound } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api, auth, errorMessage, profile } from "@/lib/api";

import { formatLocalDateTime } from "../_lib/labels";
import { ErrorBlock, LoadingBlock } from "../_components/page-states";

/** 新建密码的最短长度（与 `packages/auth` 的校验一致）。 */
const MIN_PASSWORD_LENGTH = 8;

export default function UserProfilePage() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof auth.fetchSession>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await auth.fetchSession(api);
      setSession(next);
      setName(next.user.name);
      setAvatar(next.user.avatar ?? "");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveProfile = async () => {
    setProfileError(null);
    const trimmed = name.trim();
    if (trimmed === "") {
      setProfileError("用户名不能为空");
      return;
    }
    setSavingProfile(true);
    try {
      // 头像留空 = 清除（服务端收 null），不是「不改」。
      const updated = await profile.updateProfile(api, {
        name: trimmed,
        avatar: avatar.trim() === "" ? null : avatar.trim(),
      });
      setSession((current) => (current === null ? current : { ...current, user: updated }));
      toast.success("资料已保存");
    } catch (caught) {
      setProfileError(errorMessage(caught));
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async () => {
    setPasswordError(null);
    if (currentPassword === "") {
      setPasswordError("请输入当前密码");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`新密码至少 ${MIN_PASSWORD_LENGTH} 位`);
      return;
    }
    setSavingPassword(true);
    try {
      await profile.changePassword(api, { currentPassword, newPassword });
      // 立刻清空：密码不留在内存里。
      setCurrentPassword("");
      setNewPassword("");
      toast.success("密码已更新");
    } catch (caught) {
      setPasswordError(errorMessage(caught));
    } finally {
      setSavingPassword(false);
    }
  };

  const initials = (session?.user.name ?? "?").slice(0, 1).toUpperCase();

  return (
    <div className="@container/main flex min-w-0 flex-col gap-4 md:gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">个人资料</h1>
      </div>

      {error === null ? null : <ErrorBlock message={error} onRetry={() => void load()} />}

      {loading ? (
        <Card className="min-w-0 overflow-hidden">
          <CardContent className="pt-6">
            <LoadingBlock rows={5} label="正在加载账户信息…" />
          </CardContent>
        </Card>
      ) : session === null ? null : (
        <>
          <Card className="min-w-0 overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserRound className="size-4" />
                账户
              </CardTitle>
              <CardDescription>这些是账号级信息，改不了</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-4">
              <Avatar className="size-12">
                {session.user.avatar === null ? null : <AvatarImage src={session.user.avatar} alt="" />}
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <span className="font-medium">{session.user.name}</span>
                <span className="text-muted-foreground">{session.email ?? "（未设置邮箱）"}</span>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Badge variant="outline">{session.permissions.admin ? "管理员" : "普通用户"}</Badge>
                  <Badge variant="secondary">
                    {session.user.balanceEnabled ? "余额已启用" : "余额未启用"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    用户 ID {session.user.id} · 注册于 {formatLocalDateTime(session.user.createdAt)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="min-w-0 overflow-hidden">
            <CardHeader>
              <CardTitle>基本资料</CardTitle>
              <CardDescription>头像只接受 http(s) 链接，留空表示清除</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-wrap items-start gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveProfile();
                }}
              >
                <Field className="w-56">
                  <FieldLabel htmlFor="profile-name">用户名</FieldLabel>
                  <Input
                    id="profile-name"
                    value={name}
                    maxLength={64}
                    autoComplete="nickname"
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                <Field className="w-80">
                  <FieldLabel htmlFor="profile-avatar">头像 URL</FieldLabel>
                  <Input
                    id="profile-avatar"
                    value={avatar}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://…"
                    onChange={(event) => setAvatar(event.target.value)}
                  />
                  <FieldDescription>留空并保存 = 清除头像</FieldDescription>
                </Field>
                <div className="pt-5">
                  <Button type="submit" disabled={savingProfile}>
                    {savingProfile ? "保存中…" : "保存资料"}
                  </Button>
                </div>
              </form>
              {profileError === null ? null : <FieldError className="mt-2">{profileError}</FieldError>}
            </CardContent>
          </Card>

          <Card className="min-w-0 overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="size-4" />
                修改密码
              </CardTitle>
              <CardDescription>需要先验证当前密码；新密码至少 {MIN_PASSWORD_LENGTH} 位</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-wrap items-start gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void savePassword();
                }}
              >
                <Field className="w-56">
                  <FieldLabel htmlFor="current-password">当前密码</FieldLabel>
                  <Input
                    id="current-password"
                    type="password"
                    value={currentPassword}
                    autoComplete="current-password"
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                </Field>
                <Field className="w-56">
                  <FieldLabel htmlFor="new-password">新密码</FieldLabel>
                  <Input
                    id="new-password"
                    type="password"
                    value={newPassword}
                    autoComplete="new-password"
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                  <FieldDescription>至少 {MIN_PASSWORD_LENGTH} 位</FieldDescription>
                </Field>
                <div className="pt-5">
                  <Button type="submit" variant="outline" disabled={savingPassword}>
                    {savingPassword ? "更新中…" : "更新密码"}
                  </Button>
                </div>
              </form>
              {passwordError === null ? null : <FieldError className="mt-2">{passwordError}</FieldError>}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
