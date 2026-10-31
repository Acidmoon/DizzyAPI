"use client";

/**
 * 受保护路由段（`/dashboard/**` 与 `/user/**`）的**会话闸门**。
 *
 * 为什么在客户端判：这块前端是**静态导出 SPA**（`output: "export"`），没有 Node 服务端
 * 可以读 cookie，所以「未登录」只能在浏览器里发现 —— 静态页先回 **200 + SPA 外壳**，
 * 拿到 `401` 再 `router.replace` 到登录页。**没有服务端 302**，部署清单也是按这个口径写的，
 * 别改回「302 期望」。
 *
 * 三件事只有这里做一次（页面不许各写一套）：
 * 1. **会话获取**：`GET /api/session`，401 → 跳登录页并带上 `?next=`；其余错误 → 就地报错 + 重试。
 * 2. **管理员闸门**：`/dashboard/**` 要求 `permissions.admin`；普通用户访问会被送回 `/user`
 *    （不是白屏、也不是 403 空态 —— 那会让用户以为系统坏了）。
 * 3. **会话上下文**：`useSession()` 给侧栏用户菜单等组件读真实用户名 / 邮箱 / 头像，
 *    并提供 `signOut()`（幂等：服务端 token 无效也算登出成功）。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { usePathname, useRouter } from "next/navigation";

import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, auth as authApi, type SessionView } from "@/lib/api";

import { homePathOf, loginPathWithNext, LOGIN_PATH } from "./auth-logic";

/** 会话上下文：受保护路由段内一定非空。 */
export interface SessionContextValue {
  readonly session: SessionView;
  /** 登出（幂等；失败也照常回登录页）。 */
  readonly signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** 读当前会话；在闸门之外调用返回 `null`（认证页就没有会话）。 */
export function useSession(): SessionContextValue | null {
  return useContext(SessionContext);
}

/** 把任意异常归一成 `ApiError`（组件只处理一种错误类型）。 */
function toApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  return new ApiError({
    code: "CLIENT_UNEXPECTED",
    message: cause instanceof Error ? cause.message : "未知错误",
    status: 0,
  });
}

/** `/dashboard/**` 需要管理员；`/user/**` 只要登录。 */
function requiresAdmin(pathname: string | null): boolean {
  return pathname !== null && (pathname === "/dashboard" || pathname.startsWith("/dashboard/"));
}

function CheckingState() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-3 p-6" aria-busy="true" aria-live="polite">
      <Skeleton className="h-2 w-40" />
      <span className="text-muted-foreground text-sm">正在校验登录状态…</span>
    </div>
  );
}

function FailureState({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Alert variant="destructive" className="max-w-md">
        <AlertTriangle />
        <AlertTitle>无法确认登录状态</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span>
            请求失败（<code className="font-mono text-xs">{error.code}</code>）。请检查网络后重试。
          </span>
          <Button variant="outline" size="sm" className="w-fit" onClick={onRetry}>
            重试
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}

export function SessionGuard({ children }: { readonly children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  // 跳转中：先别渲染内容，免得「未登录的页面闪一下再被踢走」。
  const [leaving, setLeaving] = useState(false);
  // 取数只跟 `attempt` 走；路径用 ref 读，避免每次侧栏切换都重拉一次会话。
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    let alive = true;
    setError(null);
    authApi
      .fetchSession(api)
      .then((result) => {
        if (!alive) return;
        setSession(result);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        const issue = toApiError(cause);
        if (issue.isUnauthorized) {
          setLeaving(true);
          router.replace(loginPathWithNext(pathnameRef.current));
          return;
        }
        setError(issue);
      });
    return () => {
      alive = false;
    };
  }, [attempt, router]);

  // 管理员闸门：普通用户不该停在 `/dashboard`（那里全是管理面接口，页面会一片 403）。
  useEffect(() => {
    if (session === null || leaving) return;
    if (requiresAdmin(pathname) && !session.permissions.admin) {
      setLeaving(true);
      router.replace(homePathOf(false));
    }
  }, [session, pathname, leaving, router]);

  const signOut = useCallback(async () => {
    try {
      await authApi.logout(api);
    } catch {
      // 登出是幂等的：服务端 token 已失效也算成功，别把用户卡在页面上。
    }
    setLeaving(true);
    router.replace(LOGIN_PATH);
    router.refresh();
  }, [router]);

  if (leaving) return <CheckingState />;
  if (error !== null) {
    return (
      <FailureState
        error={error}
        onRetry={() => {
          setAttempt((value) => value + 1);
        }}
      />
    );
  }
  if (session === null) return <CheckingState />;
  if (requiresAdmin(pathname) && !session.permissions.admin) return <CheckingState />;

  return <SessionContext.Provider value={{ session, signOut }}>{children}</SessionContext.Provider>;
}
