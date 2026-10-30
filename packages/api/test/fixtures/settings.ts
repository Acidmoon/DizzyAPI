/**
 * 运行期设置夹具。
 *
 * 从 `test/fixtures.ts` 按域拆出（§5.6：测试文件 500 行上限）。行为逐字未改。
 */
import type {
  SettingsPort,
} from '../../src/types.ts'
import { DomainError } from './support.ts'

export class FakeSettings implements SettingsPort {
  readonly calls: { method: string; args: unknown[] }[] = []
  readonly namespaces = [{ ns: 'mailer', plugin: '@dizzyapi/plugin-mailer', writable: true, fields: [] }]
  /** 设置后 update / reset 抛带这个 code 的领域错误（验证失败路径）。 */
  failCode: string | undefined

  async describe(): Promise<unknown> {
    this.calls.push({ method: 'describe', args: [] })
    // 真实 settings 服务的形状；HTTP 层必须原样透传 `{ namespaces }`。
    return { namespaces: this.namespaces }
  }

  async update(actor: string, ns: string, patch: Record<string, unknown>, expectedRevision?: string): Promise<unknown> {
    this.calls.push({ method: 'update', args: [actor, ns, patch, expectedRevision] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：设置写入失败')
    return { ns, revision: 'rev-2', patch }
  }

  async reset(actor: string, ns: string): Promise<unknown> {
    this.calls.push({ method: 'reset', args: [actor, ns] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：设置重置失败')
    return { ns, overridden: false }
  }
}
