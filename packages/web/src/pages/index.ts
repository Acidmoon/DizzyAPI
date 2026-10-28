/** 页面注册表：一页一个文件，这里只做汇总与排序。 */
import type { PageModule } from '../layout.ts'
import { loginPage } from './login.ts'
import { registerPage } from './register.ts'
import { usagePage } from './usage.ts'
import { keysPage } from './keys.ts'
import { topUpPage } from './top_up.ts'
import { redeemPage } from './redeem.ts'
import { transactionsPage } from './transactions.ts'
import { profilePage } from './profile.ts'
import { adminUsersPage } from './admin_users.ts'
import { adminAccountsPage } from './admin_accounts.ts'
import { adminAccountDetailPage } from './admin_account_detail.ts'
import { adminCatalogPage } from './admin_catalog.ts'
import { adminSettingsPage } from './admin_settings.ts'
import { adminUsagePage } from './admin_usage.ts'
import { adminPricingPage } from './admin_pricing.ts'
import { adminRedeemCodesPage } from './admin_redeem_codes.ts'

export const PAGES: readonly PageModule[] = [
  loginPage,
  registerPage,
  usagePage,
  keysPage,
  topUpPage,
  redeemPage,
  transactionsPage,
  profilePage,
  adminUsersPage,
  adminAccountsPage,
  adminAccountDetailPage,
  adminCatalogPage,
  adminSettingsPage,
  adminUsagePage,
  adminPricingPage,
  adminRedeemCodesPage,
]
