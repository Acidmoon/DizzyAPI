import type { ReactNode } from "react";

import { cn } from "cn";

import { AppSidebar } from "@/app/(main)/dashboard/_components/sidebar/app-sidebar";
import { SessionGuard } from "@/app/(main)/auth/_components/session-guard";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

import { LayoutControls } from "./_components/header/layout-controls";
import { SearchDialog } from "./_components/header/search-dialog";
import { ThemeSwitcher } from "./_components/header/theme-switcher";

/**
 * 控制台外壳：侧栏 + 顶栏 + 内容区。
 *
 * 静态导出没有服务端运行时，所以这里**不读 cookie、不读服务端偏好**：
 * 首帧的 `data-*` 属性由 `RootLayout` 的默认值给出，`ThemeBootScript` 在
 * hydration 前按 cookie 覆盖，`usePreferencesStore` 之后同步。
 *
 * **会话闸门在最外层**（`SessionGuard`）：静态页先回 200 + 外壳，浏览器里调
 * `GET /api/session`，401 就跳登录页并带上 `?next=`；`/dashboard/**` 还要求管理员角色，
 * 普通用户会被送回 `/user`。`/user` 段的布局直接转接本文件（见 `user/layout.tsx`），
 * 所以两段共用同一个闸门，**没有第二份实现**。
 */
export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <SessionGuard>
      <SidebarProvider>
      <AppSidebar />
      <SidebarInset
        className={cn(
          "[html[data-content-layout=centered]_&>*]:mx-auto",
          "[html[data-content-layout=centered]_&>*]:w-full",
          "[html[data-content-layout=centered]_&>*]:max-w-screen-2xl",
          "peer-data-[variant=inset]:border",
          "[--dashboard-header-height:--spacing(12)]",
          "min-w-0 overflow-x-clip",
        )}
      >
        <header
          className={cn(
            "flex h-12 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12",
            // Handle sticky navbar style with conditional classes so blur, background, z-index, and rounded corners remain consistent across all SidebarVariant layouts.
            "[html[data-navbar-style=sticky]_&]:bg-background/50 [html[data-navbar-style=sticky]_&]:sticky [html[data-navbar-style=sticky]_&]:top-0 [html[data-navbar-style=sticky]_&]:z-50 [html[data-navbar-style=sticky]_&]:overflow-hidden [html[data-navbar-style=sticky]_&]:rounded-t-[inherit] [html[data-navbar-style=sticky]_&]:backdrop-blur-md",
          )}
        >
          <div className="flex w-full items-center justify-between px-4 lg:px-6">
            <div className="flex items-center gap-1 lg:gap-2">
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mx-2 data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center"
              />
              <SearchDialog />
            </div>
            <div className="flex items-center gap-2">
              <LayoutControls />
              <ThemeSwitcher />
            </div>
          </div>
        </header>
        {/* Pages can set data-content-padding="false" to render full-bleed app layouts. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden p-4 has-data-[content-padding=false]:p-0 md:p-6 md:has-data-[content-padding=false]:p-0">
          {children}
        </div>
      </SidebarInset>
      </SidebarProvider>
    </SessionGuard>
  );
}
