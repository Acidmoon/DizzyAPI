import {
  Activity,
  BadgeDollarSign,
  BookOpen,
  Bot,
  CircleUser,
  ClipboardList,
  FileText,
  Gauge,
  KeyRound,
  LayoutDashboard,
  ReceiptText,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Tags,
  Ticket,
  UserRound,
  type LucideIcon,
  Users,
  Wallet,
} from "lucide-react";

/**
 * 侧栏信息架构的**唯一源**：侧栏（nav-main）、搜索弹窗（search-dialog）、
 * 面包屑都从这里取数据。新增页面先在这里登记，不要在页面里手写导航。
 *
 * 路由前缀约定（别的批次写页面时按这个来，别自己另起一套）：
 * - `/dashboard/*`     管理员侧（`仪表盘` 是 `/dashboard` 本身）
 * - `/user/*`  普通用户侧
 */

export type NavBadge = "new" | "updated" | "soon";

export interface NavSubItem {
  id: string;
  title: string;
  url: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}

interface NavItemBase {
  id: string;
  title: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}

export interface NavMainLinkItem extends NavItemBase {
  url: string;
  subItems?: never;
}

export interface NavMainParentItem extends NavItemBase {
  subItems: NavSubItem[];
}

export type NavMainItem = NavMainLinkItem | NavMainParentItem;

export interface NavGroup {
  id: number;
  label?: string;
  items: NavMainItem[];
}

export const sidebarItems: NavGroup[] = [
  {
    id: 1,
    label: "管理员",
    items: [
      { id: "dashboard", title: "仪表盘", url: "/dashboard", icon: LayoutDashboard },
      { id: "users", title: "用户", url: "/dashboard/users", icon: Users },
      { id: "roles", title: "角色", url: "/dashboard/roles", icon: ShieldCheck },
      { id: "accounts", title: "上游账号", url: "/dashboard/accounts", icon: Server },
      { id: "pricing", title: "模型价格", url: "/dashboard/pricing", icon: Tags },
      { id: "redeem", title: "兑换码", url: "/dashboard/redeem", icon: Ticket },
      { id: "topup", title: "充值订单", url: "/dashboard/topup", icon: ShoppingCart },
      { id: "usage", title: "用量明细", url: "/dashboard/usage", icon: Gauge },
      { id: "billing", title: "结算", url: "/dashboard/billing", icon: BadgeDollarSign },
      { id: "audit", title: "审计", url: "/dashboard/audit", icon: ScrollText },
      { id: "content-audit", title: "内容审核", url: "/dashboard/content-audit", icon: ClipboardList },
      { id: "observability", title: "运维总览", url: "/dashboard/observability", icon: Activity },
      { id: "settings", title: "设置", url: "/dashboard/settings", icon: Settings },
    ],
  },
  {
    id: 2,
    label: "用户",
    items: [
      { id: "me-overview", title: "概览", url: "/user", icon: CircleUser },
      { id: "me-usage", title: "用量", url: "/user/usage", icon: Gauge },
      { id: "me-keys", title: "API 密钥", url: "/user/keys", icon: KeyRound },
      { id: "me-topup", title: "充值", url: "/user/topup", icon: Wallet },
      { id: "me-redeem", title: "兑换码", url: "/user/redeem", icon: Ticket },
      { id: "me-models", title: "模型广场", url: "/user/models", icon: Bot },
      { id: "me-pricing", title: "价格表", url: "/user/pricing", icon: ReceiptText },
      { id: "me-docs", title: "API 文档", url: "/user/docs", icon: BookOpen },
      { id: "me-profile", title: "个人资料", url: "/user/profile", icon: UserRound },
    ],
  },
];
