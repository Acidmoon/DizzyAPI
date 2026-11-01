/**
 * 内置的客户端指纹预置。
 *
 * ## 这些值是「起点」，不是「事实」
 *
 * 上游要求的指纹头会变（新版本客户端加头 / 改头），我们**不可能**保证某个版本号永远正确。
 * 所以每条预置都是：**一份看起来合理的默认值 + 一段说明它想解决什么问题的描述**，
 * 管理员在管理页改或直接停用。**用例只钉形状（值合法、占位符合法、id 合法），不钉具体 UA 串**
 * —— 钉死版本号等于把「随时会变的现实」写进断言。
 *
 * ## 许可证纪律
 *
 * sub2api（LGPL-3.0）里有类似功能的实现，**只读了它的设计**（按用户消息算稳定 session id、
 * 头部档案按账号挂载），**没有复制任何代码**。这里的头名来自各客户端公开的协议行为
 * （opencode 的错误信息本身点名了 `x-opencode-session`）。
 */
import type { ClientHeader, ClientProfile } from './types.ts'

/** 预置的 id 清单（用例与管理页都按它判断「这是不是内置的」）。 */
export const PRESET_IDS = ['opencode', 'codex', 'claude-cli', 'browser', 'none'] as const

export type PresetId = (typeof PRESET_IDS)[number]

interface PresetSpec {
  readonly label: string
  readonly description: string
  readonly userAgent: string | null
  readonly headers: readonly ClientHeader[]
  /** 默认是否启用。`none` 是「不伪装」，默认也启用（它等价于空档案）。 */
  readonly enabled: boolean
}

const PRESETS: Readonly<Record<PresetId, PresetSpec>> = {
  /**
   * owner 2026-11-01 撞到的那个上游：不带 `x-opencode-session` 会被回
   * `HTTP 400: Request is missing x-opencode-session and cannot be routed efficiently`。
   * 它要的是**会话亲和**，所以这里用 `{{session}}`（稳定值）而不是 `{{uuid}}`。
   */
  opencode: {
    label: 'opencode 客户端',
    description:
      '模仿 opencode 官方客户端：带会话头让它能把请求路由到同一个会话上（缺这个头会被 400）。'
      + '会话 id 按「账号 + 首条用户消息」稳定生成，同一段对话重复请求拿到同一个值。',
    userAgent: 'opencode/0.4.2 (cli; linux x64)',
    headers: [
      { name: 'x-opencode-session', value: '{{session}}' },
      { name: 'x-opencode-client', value: 'cli' },
    ],
    enabled: true,
  },
  codex: {
    label: 'Codex CLI',
    description: '模仿 Codex CLI：`originator` 表明来源，会话 id 与对话绑定（同一段对话稳定）。',
    userAgent: 'codex_cli_rs/0.20.0 (Linux x86_64) codex-rs',
    headers: [
      { name: 'originator', value: 'codex_cli_rs' },
      { name: 'session_id', value: '{{session}}' },
    ],
    enabled: true,
  },
  'claude-cli': {
    label: 'Claude CLI',
    description: '模仿 Anthropic 官方 CLI：`x-app: cli` 与固定的 `anthropic-version`。'
      + '注意它只在 Anthropic 系上游上有意义。',
    userAgent: 'claude-cli/1.0.0 (external, cli)',
    headers: [
      { name: 'x-app', value: 'cli' },
      { name: 'anthropic-version', value: '2023-06-01' },
    ],
    enabled: true,
  },
  browser: {
    label: '浏览器',
    description: '模仿桌面浏览器：常见 Chrome UA 与 `accept-language`。适合只按浏览器 UA 做白名单的上游。',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/141.0.0.0 Safari/537.36',
    headers: [{ name: 'accept-language', value: 'zh-CN,zh;q=0.9,en;q=0.8' }],
    enabled: true,
  },
  /** 显式的「不伪装」：账号可以显式挂它，好过把「没选」和「选了空」混在一起。 */
  none: {
    label: '不伪装',
    description: '什么都不加：请求头完全由网关自己决定（等价于没挂档案）。',
    userAgent: null,
    headers: [],
    enabled: true,
  },
}

/** 全部预置（顺序稳定：管理页按这个顺序列）。 */
export function presetProfiles(): ClientProfile[] {
  return PRESET_IDS.map((id) => {
    const spec = PRESETS[id]
    return {
      id,
      label: spec.label,
      description: spec.description,
      enabled: spec.enabled,
      userAgent: spec.userAgent,
      headers: spec.headers.map((header) => ({ ...header })),
      builtin: true,
    }
  })
}

/** 单个预置；不是内置 id 返回 `undefined`。 */
export function presetProfile(id: string): ClientProfile | undefined {
  if (!(PRESET_IDS as readonly string[]).includes(id)) return undefined
  return presetProfiles().find((profile) => profile.id === id)
}

/** 这个 id 是不是内置预置。 */
export function isPresetId(id: string): id is PresetId {
  return (PRESET_IDS as readonly string[]).includes(id)
}
