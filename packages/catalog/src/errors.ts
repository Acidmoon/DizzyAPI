export type CatalogErrorCode =
  | 'CATALOG_PLUGIN_NOT_FOUND'
  | 'CATALOG_QUERY_INVALID'
  | 'CATALOG_INVALID_CONFIG'

export class CatalogError extends Error {
  readonly code: CatalogErrorCode

  constructor(code: CatalogErrorCode, message: string) {
    super(message)
    this.name = 'CatalogError'
    this.code = code
  }
}

export function isCatalogError(value: unknown): value is CatalogError {
  return value instanceof CatalogError
}
