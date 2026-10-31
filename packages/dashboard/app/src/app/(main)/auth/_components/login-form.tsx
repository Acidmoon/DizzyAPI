"use client";

/**
 * 登录表单（**已接线**：`POST /api/auth/login`）。
 *
 * 纪律：
 * - **密码只走 POST body**：不进 URL、不进 `localStorage` / `sessionStorage`、不进 `console`；
 *   登录成功后立刻把密码从表单状态里清掉，别留在内存里。
 * - **文案按稳定 `code` 翻中文**（`auth-logic.ts` 的 `authErrorTextOf`），
 *   不把服务端原文直接弹给用户。
 * - **落地页按角色分流**：管理员 `/dashboard`、普通用户 `/user`；若 URL 带了站内 `next`
 *   就回原地（`next` 走白名单，防开放重定向）。
 * - **提交中按钮变「登录中…」**（整宽按钮，宽度不变、布局不跳）并 `aria-busy`；
 *   重复提交在处理函数里挡掉，不用 `disabled`（免得表单值从提交数据里消失）。
 */
import { useState } from "react";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api, auth as authApi } from "@/lib/api";

import { authErrorTextOf, homePathOf, nextPathOf, toAuthIssue } from "./auth-logic";

const formSchema = z.object({
  email: z.email({ message: "请输入有效的邮箱地址。" }),
  password: z.string().min(6, { message: "密码至少 6 个字符。" }),
  remember: z.boolean().optional(),
});

type LoginValues = z.infer<typeof formSchema>;

export function LoginForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<LoginValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "",
      password: "",
      remember: false,
    },
  });

  async function onSubmit(data: LoginValues) {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await authApi.login(api, { email: data.email, password: data.password });
      // 密码用完即弃；失败时保留，方便用户只改邮箱重试。
      form.reset({ email: data.email, password: "", remember: data.remember });
      const next = nextPathOf(window.location.search);
      router.replace(next ?? homePathOf(result.user.role === "admin"));
      router.refresh();
    } catch (cause) {
      setFailure(authErrorTextOf(toAuthIssue(cause)));
      setPending(false);
    }
  }

  return (
    <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        <Controller
          control={form.control}
          name="email"
          render={({ field, fieldState }) => (
            <Field className="gap-1.5" data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="login-email">邮箱</FieldLabel>
              <Input
                {...field}
                id="login-email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                spellCheck={false}
                aria-invalid={fieldState.invalid}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="password"
          render={({ field, fieldState }) => (
            <Field className="gap-1.5" data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="login-password">密码</FieldLabel>
              <Input
                {...field}
                id="login-password"
                type="password"
                placeholder="••••••••"
                autoComplete="current-password"
                aria-invalid={fieldState.invalid}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="remember"
          render={({ field, fieldState }) => (
            <Field orientation="horizontal" data-invalid={fieldState.invalid}>
              <Checkbox
                id="login-remember"
                name={field.name}
                checked={field.value}
                onCheckedChange={(checked) => field.onChange(Boolean(checked))}
                aria-invalid={fieldState.invalid}
              />
              <FieldContent>
                <FieldLabel htmlFor="login-remember" className="font-normal">
                  记住我 30 天
                </FieldLabel>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </FieldContent>
            </Field>
          )}
        />
      </FieldGroup>
      {failure === null ? null : (
        <p role="alert" aria-live="assertive" className="text-destructive text-sm">
          {failure}
        </p>
      )}
      <Button className="w-full" type="submit" aria-busy={pending} aria-disabled={pending}>
        {pending ? "登录中…" : "登录"}
      </Button>
    </form>
  );
}
