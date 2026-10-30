"use client";

/**
 * 管理台页面共用的取数 hook（**只此一份**，页面不许各写一套 useEffect + fetch）。
 *
 * 为什么是客户端取数：这块前端是**静态导出 SPA**（`output: "export"`），
 * 没有 Node 服务端可以读 cookie，所以页面在浏览器里通过 `@/lib/api` 取数。
 *
 * 四条约定：
 * - `loading` 与 `error` **同时**是状态：重新加载时先清旧错，避免「上次的错误 + 这次的数据」同屏。
 * - `error` 是 `ApiError`（带稳定 `code`），页面按 `isUnauthorized` / `isForbidden` / `isUnavailable` 分支，
 *   不去猜 HTTP 状态码。
 * - **401 / 403 不当成普通错误**：`onAuthIssue` 交给上层决定是跳登录页还是渲染「无权限」。
 * - 请求竞态：每次 reload 递增 `token`，只认最后一次的响应（快速切筛选时不会出现旧数据盖新数据）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "@/lib/api";

export interface ResourceState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** 重新取数（筛选变化后调用）。 */
  reload: () => void;
}

/** 把任意异常归一成 `ApiError`（页面永远只处理一种错误类型）。 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError({
    code: "CLIENT_UNEXPECTED",
    message: error instanceof Error ? error.message : "未知错误",
    status: 0,
  });
}

/**
 * 取数 hook。
 *
 * `load` 必须是**稳定引用**（页面里用 `useCallback` 包一层，依赖写筛选条件），
 * 否则每次渲染都会重新发请求。
 */
export function useResource<T>(load: () => Promise<T>): ResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const tokenRef = useRef(0);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    const token = tokenRef.current + 1;
    tokenRef.current = token;
    let alive = true;
    setLoading(true);
    setError(null);
    load()
      .then((result) => {
        if (!alive || tokenRef.current !== token) return;
        setData(result);
      })
      .catch((cause: unknown) => {
        if (!alive || tokenRef.current !== token) return;
        setError(toApiError(cause));
      })
      .finally(() => {
        if (!alive || tokenRef.current !== token) return;
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [load, nonce]);

  return { data, error, loading, reload };
}
