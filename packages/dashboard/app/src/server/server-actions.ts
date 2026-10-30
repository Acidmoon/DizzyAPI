/**
 * 偏好持久化（DizzyAPI 定制版）。
 *
 * **为什么整份换掉**：上游这一份是 Server Action（`"use server"` + `next/headers` 的
 * `cookies()`）。静态导出（`output: "export"`）**没有服务端运行时**，任何 `cookies()`
 * / Server Action 都构建失败，而且 `next/headers` 会被打进客户端 bundle。
 *
 * 改成纯客户端实现：
 * - `getValueFromCookie` 从 `document.cookie` 读；
 * - `setValueToCookie` 写 `document.cookie`（`SameSite=Lax; Path=/`）。
 *
 * 上游的 `preferences-config.ts` 里所有偏好都是 `"client-cookie"` 持久化
 * （`server-cookie` 一个都没用），所以这不丢功能——原本就是客户端 cookie 存的，
 * 只是绕了一圈 Server Action。
 *
 * 布局相关的两个偏好（`sidebar_variant` / `sidebar_collapsible`）上游注释说
 * 「SSR 期间必须一致，所以不能用 localStorage」——现在没有 SSR 了，统一走 cookie；
 * 主题启动脚本（`ThemeBootScript`）在首帧就把它应用到 `<html>` 的 data 属性上，
 * 所以不会有闪烁。
 */
import {
  getPreferencePersistence,
  PREFERENCE_REGISTRY,
  type PreferenceKey,
  type PreferenceValueMap,
  parsePreference,
} from "@/lib/preferences/preferences-config";

/** 读一个 cookie 值；不存在或不可读时返回 undefined。 */
export function getValueFromCookie(key: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const prefix = `${encodeURIComponent(key)}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return undefined;
}

/** 写一个 cookie 值（默认 7 天，与上游一致）。 */
export function setValueToCookie(
  key: string,
  value: string,
  options: { path?: string; maxAge?: number } = {},
): void {
  if (typeof document === "undefined") return;
  const maxAge = options.maxAge ?? 60 * 60 * 24 * 7;
  const path = options.path ?? "/";
  document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value)}; path=${path}; max-age=${maxAge}; SameSite=Lax`;
}

/**
 * 读一个偏好值。
 *
 * 保留上游的签名与语义（非法值回落到默认值），只是数据源从服务端 cookie 变成
 * 浏览器 cookie。
 */
export function getPreference<K extends PreferenceKey>(key: K): PreferenceValueMap[K] {
  const definition = PREFERENCE_REGISTRY[key];
  const persistence = getPreferencePersistence(key);

  if (persistence !== "client-cookie" && persistence !== "server-cookie") {
    return definition.defaultValue as PreferenceValueMap[K];
  }

  return parsePreference(key, getValueFromCookie(key)?.trim());
}
