/**
 * 应用：把覆盖盖到基线（app.yml 里人写的 config）上。规则三条：
 *
 * 1. 两边都是普通对象 → 逐键递归（所以只写 `smtp.host` 不会把 `smtp.user` 弄丢）；
 * 2. 覆盖里某个键的值是 **null → 删掉基线上的这个键**。这是必须的：基线里写了
 *    `smtp.passEnv`，要换成 `smtp.passRef` 就得能把前者删掉，否则两个同时存在，
 *    而它们是互斥的——那份配置永远校验不过；
 * 3. 其余（标量、数组）一律覆盖胜：数组整体替换，不做合并。
 */
export function mergeConfig(baseline: unknown, override: unknown): Record<string, unknown> {
  const base = isPlainObject(baseline) ? baseline : {}
  const patch = isPlainObject(override) ? override : {}
  return applyPatch(base, patch)
}

/**
 * 累积：把一次 patch 并进**已存的覆盖**里。
 *
 * 与 `mergeConfig` 的唯一区别是 null 的处理，而这个区别是关键：
 * patch 里的 null 要**原样存下来当墓碑**，不能就地删掉。否则
 * 「把基线里的 replyTo 删掉」这条指令会在存储那一步消失，下次应用时
 * 基线里的 replyTo 又回来了——删了等于没删。真正执行删除的是 `mergeConfig`。
 */
export function mergePatch(previous: unknown, patch: unknown): Record<string, unknown> {
  const base = isPlainObject(previous) ? previous : {}
  const addition = isPlainObject(patch) ? patch : {}
  return accumulate(base, addition)
}

function applyPatch(
  base: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key]
      continue
    }
    const current = out[key]
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = applyPatch(current, value)
      continue
    }
    out[key] = value
  }
  return out
}

function accumulate(
  base: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = accumulate(current, value)
      continue
    }
    out[key] = value
  }
  return out
}

/** 普通对象：排除 null 与数组（数组要整体替换，不能当对象递归）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
