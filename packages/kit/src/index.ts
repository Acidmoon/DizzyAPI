export {
  describeError,
  isFileNotFound,
  jsonFileStore,
  memoryStore,
  type JsonCodec,
  type JsonStore,
} from './store.ts'

export {
  checkConfigObject,
  isIssueList,
  issue,
  readBoolean,
  readPositiveInteger,
  readString,
  readStringArray,
  standardSchema,
  type ObjectCheck,
  type StandardIssue,
  type StandardSchema,
} from './schema.ts'

/** 当前时间的 ISO 8601 字符串；集中一处，方便将来换成可注入的时钟。 */
export function nowIso(): string {
  return new Date().toISOString()
}

export function addMilliseconds(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}

export function isExpired(iso: string, at: string = nowIso()): boolean {
  return Date.parse(iso) <= Date.parse(at)
}
