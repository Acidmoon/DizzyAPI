/**
 * API key（用户侧）。
 *
 * 服务端来源：`views/account.ts` 的 `normalizeKeyList()` / `normalizeKeySummary()` /
 * `normalizeCreatedKey()`，条目类型是 `ApiKeySummaryView`（可 import，直接复用）。
 *
 * **一次性 secret 的纪律**：`create` / `rotate` 的响应里有完整 key `secret`，
 * 它只在这一次响应里出现——只展示一次给用户复制，**不落 localStorage / URL / 日志**。
 */
import type { ApiKeySummaryView } from '@dizzyapi/plugin-api'

export type { ApiKeySummaryView } from '@dizzyapi/plugin-api'

/** `POST /api/keys` 与 `POST /api/keys/:id/rotate` 的响应。 */
export interface CreatedApiKeyView extends ApiKeySummaryView {
  /** **完整 key，只此一次**。 */
  readonly secret: string
}

/** `GET /api/keys` 的响应。 */
export interface KeyListView {
  readonly items: readonly ApiKeySummaryView[]
}
