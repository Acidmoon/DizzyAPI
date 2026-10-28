/**
 * 测试基建：拿一个「fetch 打得到」的临时端口。
 *
 * 背景（2026-10 反复咬人的假失败）：用例用 `port: 0` 让 OS 随机分配，偶尔会分到
 * **fetch 规范屏蔽端口**（WHATWG fetch spec 的 bad port 列表，如 6665–6669、6697、
 * 10080…）。undici 在真正发请求前就抛 `bad port`，于是单独复跑必绿、全量并行偶发红。
 *
 * 这里不猜 OS 会分什么：`mount` 照旧用 `port: 0` 起服务，拿到实际端口后检查是否落在
 * 屏蔽集合；命中就关掉重来（最多 attempts 次）。每个测试文件各自独立起服务，所以并发
 * 跑也不会共用端口；屏蔽端口在随机端口里占比极低，重来一两次即可收敛。
 *
 * 断言仍然发生在测试里：本模块只负责「怎么拿端口」，不要把 `fetch` 包进 try/catch。
 */

/**
 * fetch 规范屏蔽端口（WHATWG fetch：port blocking）。
 *
 * 与 undici / Node 内置 fetch 的实现一致；含 0 与 6665–6669 这个区间。
 */
const BLOCKED_PORTS: readonly number[] = [
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]

const BLOCKED = new Set<number>(BLOCKED_PORTS)

/** 这个端口能不能被 fetch 直接访问（false = undici 会抛 bad port）。 */
export function isFetchBlockedPort(port: number): boolean {
  return BLOCKED.has(port)
}

/** `mount` 起好的临时服务。`app` 是调用方想要的载荷（ctx、假服务等）。 */
export interface StartedListener<T> {
  readonly app: T
  readonly port: number
  close(): Promise<void>
}

export interface FetchableListener<T> extends StartedListener<T> {
  /** `http://127.0.0.1:<port>`，直接拼路径即可。 */
  readonly base: string
}

/**
 * 起一个 fetch 可访问的临时服务：端口落在屏蔽集合里就关掉重来。
 *
 * @param mount 每次调用都完整起一份（含 `port: 0`），返回实际端口与关闭函数。
 * @param attempts 重试上限；连续命中说明测试基建本身有问题，明确失败而不是死循环。
 */
export async function listenFetchable<T>(
  mount: () => Promise<StartedListener<T>>,
  attempts = 12,
): Promise<FetchableListener<T>> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const started = await mount()
    if (!isFetchBlockedPort(started.port)) {
      return { ...started, base: `http://127.0.0.1:${started.port}` }
    }
    await started.close()
  }
  throw new Error(
    `连续 ${attempts} 次都拿到 fetch 屏蔽端口（bad port），测试基建需要检查：` +
      '临时服务没有真正随机分配端口？',
  )
}
