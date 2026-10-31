"use client";

/**
 * 注册表单（**已接线**：`POST /api/auth/register/request` → `POST /api/auth/register/confirm`）。
 *
 * 服务端是**两步**：
 * 1. `request` 只发验证码（此时不建账号），返回 `{ email, expiresAt, resendAfterMs }`；
 * 2. `confirm` 用「邮箱 + 验证码」换会话 —— **密码不在第二步传**（第一步已经交上去了）。
 *
 * 三条纪律：
 * - 第一步成功后**立刻把密码从表单状态里清掉**（第二步用不到它，留在内存里没意义）。
 * - **验证码只走 POST body**，不进 URL / storage / console；提交后清空。
 * - 「验证码已发送」**不许假装发信成功**：生产上 `mailer` 可能配成 `log` 传输（码只进服务端日志），
 *   所以文案照实说明去哪取码（`CODE_SENT_NOTICE`）。
 *
 * 没做「重发验证码」按钮：重发要再带一次密码，而我们刚把密码清掉了 —— 与其在内存里留着密码，
 * 不如让用户「返回上一步」重新填（密码输入框还在，浏览器/密码管理器也能补）。
 */
import { useState } from "react";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api, auth as authApi } from "@/lib/api";

import {
  CODE_SENT_NOTICE,
  authErrorTextOf,
  homePathOf,
  isVerificationCode,
  toAuthIssue,
} from "./auth-logic";

const formSchema = z
  .object({
    email: z.email({ message: "请输入有效的邮箱地址。" }),
    password: z.string().min(6, { message: "密码至少 6 个字符。" }),
    confirmPassword: z.string().min(6, { message: "确认密码至少 6 个字符。" }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "两次输入的密码不一致。",
    path: ["confirmPassword"],
  });

type RegisterValues = z.infer<typeof formSchema>;

export function RegisterForm() {
  const router = useRouter();
  const [step, setStep] = useState<"request" | "confirm">("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<RegisterValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "",
      password: "",
      confirmPassword: "",
    },
  });

  async function requestCode(data: RegisterValues) {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const ticket = await authApi.requestRegistration(api, {
        email: data.email,
        password: data.password,
      });
      // 密码已经交给服务端了，第二步用不到 —— 立刻清掉，别留在内存里。
      form.reset({ email: ticket.email, password: "", confirmPassword: "" });
      setEmail(ticket.email);
      setCode("");
      setStep("confirm");
    } catch (cause) {
      setFailure(authErrorTextOf(toAuthIssue(cause)));
    } finally {
      setPending(false);
    }
  }

  async function confirmCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!isVerificationCode(code)) {
      setFailure("请输入收到的验证码（4～10 位数字）");
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const result = await authApi.confirmRegistration(api, { email, code });
      setCode("");
      router.replace(homePathOf(result.user.role === "admin"));
      router.refresh();
    } catch (cause) {
      setFailure(authErrorTextOf(toAuthIssue(cause)));
      setPending(false);
    }
  }

  if (step === "confirm") {
    return (
      <form noValidate onSubmit={confirmCode} className="flex flex-col gap-4">
        <FieldGroup className="gap-4">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="register-code">验证码</FieldLabel>
            <Input
              id="register-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              placeholder="例如 123456…"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-invalid={failure !== null}
            />
          </Field>
        </FieldGroup>
        <p className="text-muted-foreground text-sm" role="status" aria-live="polite">
          {`已提交注册信息：${email}。${CODE_SENT_NOTICE}`}
        </p>
        {failure === null ? null : (
          <p role="alert" aria-live="assertive" className="text-destructive text-sm">
            {failure}
          </p>
        )}
        <Button className="w-full" type="submit" aria-busy={pending} aria-disabled={pending}>
          {pending ? "提交中…" : "提交验证码"}
        </Button>
        <Button
          className="w-full"
          type="button"
          variant="ghost"
          onClick={() => {
            setFailure(null);
            setStep("request");
          }}
        >
          返回上一步
        </Button>
      </form>
    );
  }

  return (
    <form noValidate onSubmit={form.handleSubmit(requestCode)} className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        <Controller
          control={form.control}
          name="email"
          render={({ field, fieldState }) => (
            <Field className="gap-1.5" data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="register-email">邮箱</FieldLabel>
              <Input
                {...field}
                id="register-email"
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
              <FieldLabel htmlFor="register-password">密码</FieldLabel>
              <Input
                {...field}
                id="register-password"
                type="password"
                placeholder="••••••••"
                autoComplete="new-password"
                aria-invalid={fieldState.invalid}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="confirmPassword"
          render={({ field, fieldState }) => (
            <Field className="gap-1.5" data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="register-confirm-password">确认密码</FieldLabel>
              <Input
                {...field}
                id="register-confirm-password"
                type="password"
                placeholder="••••••••"
                autoComplete="new-password"
                aria-invalid={fieldState.invalid}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
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
        {pending ? "发送验证码…" : "注册并获取验证码"}
      </Button>
    </form>
  );
}
