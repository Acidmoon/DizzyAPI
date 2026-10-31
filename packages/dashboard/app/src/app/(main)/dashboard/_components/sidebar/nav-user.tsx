"use client";

/**
 * 页脚用户菜单（**已接线**：真实会话 + 登出）。
 *
 * 数据来源是 `SessionGuard` 提供的会话上下文（`useSession()`）：用户名 / 邮箱 / 头像来自
 * `GET /api/session` 的 `user`，登出调 `POST /api/auth/logout`（**幂等**，服务端 token 已失效
 * 也算成功）然后回登录页。
 *
 * 为什么不再用 `<a href="/auth/v2/login">` 假装登出：那样**会话 cookie 还在**，
 * 用户以为退出了、实际点回 `/dashboard` 又能进 —— 这是安全错觉，必须真的打登出接口。
 *
 * 没有会话上下文时（例如把菜单单独渲染在认证页）退回占位文案，不报错。
 */
import { CircleUser, EllipsisVertical, KeyRound, LogOut } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { getInitials } from "@/lib/utils";

import { useSession } from "@/app/(main)/auth/_components/session-guard";

interface NavUserInfo {
  readonly name: string;
  readonly email: string;
  readonly avatar: string;
}

const PLACEHOLDER_USER: NavUserInfo = {
  name: "未登录",
  email: "—",
  avatar: "",
};

export function NavUser({ user }: { readonly user?: NavUserInfo }) {
  const { isMobile } = useSidebar();
  const session = useSession();

  const info: NavUserInfo =
    user ??
    (session === null
      ? PLACEHOLDER_USER
      : {
          name: session.session.user.name,
          email: session.session.email ?? "—",
          avatar: session.session.user.avatar ?? "",
        });

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="h-8 w-8 rounded-lg">
                <AvatarImage src={info.avatar || undefined} alt={info.name} />
                <AvatarFallback className="rounded-lg">{getInitials(info.name)}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{info.name}</span>
                <span className="text-muted-foreground truncate text-xs">{info.email}</span>
              </div>
              <EllipsisVertical className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-lg">
                  <AvatarImage src={info.avatar || undefined} alt={info.name} />
                  <AvatarFallback className="rounded-lg">{getInitials(info.name)}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{info.name}</span>
                  <span className="text-muted-foreground truncate text-xs">{info.email}</span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <a href="/user/profile">
                  <CircleUser />
                  个人资料
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href="/user/keys">
                  <KeyRound />
                  API 密钥
                </a>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                // 真的打登出接口（幂等），失败也回登录页 —— 别把用户卡在这里。
                if (session !== null) void session.signOut();
              }}
            >
              <LogOut />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
