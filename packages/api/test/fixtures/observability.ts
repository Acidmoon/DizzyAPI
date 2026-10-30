/**
 * 运维总览夹具与样例报告。
 *
 * 从 `test/fixtures.ts` 按域拆出（§5.6：测试文件 500 行上限）。行为逐字未改。
 */
import type {
  ObservabilityPort,
} from '../../src/types.ts'
import { DomainError } from './support.ts'

/** 运维总览的假实现：返回一份现成的报告，可让 observe 抛错。 */
export class FakeObservability implements ObservabilityPort {
  calls = 0
  /** 置 true 后 observe 抛领域错误（验证 5xx / 透传）。 */
  failCode: string | undefined
  report: unknown = sampleObservabilityReport()

  async observe(): Promise<unknown> {
    this.calls += 1
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：聚合失败')
    return this.report
  }
}

/** 一份「六块都有、金额是字符串、没有 bigint」的报告样本。 */
export function sampleObservabilityReport(): Record<string, unknown> {
  return {
    generatedAt: '2026-10-29T12:00:00.000Z',
    usage: {
      health: { state: 'ok', detail: '' },
      service: {
        records: 1234,
        polling: true,
        consecutiveFailures: 0,
        lastError: null,
        gapRecords: 17,
        rejectedCount: 2,
        rejectedPending: 1,
        pricingAvailable: true,
        epoch: 'epoch-1',
        lastSeq: 900,
      },
      gateway: {
        epoch: 'epoch-1',
        capacity: 32768,
        size: 120,
        firstSeq: 781,
        lastSeq: 900,
        dropped: 5,
        gap: 5,
      },
      gatewayHealth: { state: 'ok', detail: '' },
    },
    billing: {
      health: { state: 'ok', detail: '' },
      totals: {
        records: 100,
        settled: 90,
        pending: 3,
        settling: 0,
        noPrice: 3,
        noUser: 1,
        failed: 2,
        review: 1,
        overdrawn: 2,
      },
      chargedMicros: '12345678',
      today: { date: '2026-10-29', settled: 24, chargedMicros: '900000' },
    },
    quota: {
      health: { state: 'ok', detail: '' },
      ready: true,
      revision: 'rev-1',
      generation: 7,
      size: 3,
      ageMs: 1200,
      ttlMs: 15000,
      stale: false,
    },
    runtime: { health: { state: 'ok', detail: '' }, active: 4, cooling: 1 },
    audit: {
      health: { state: 'ok', detail: '' },
      total: 3,
      failed: 1,
      lastAt: '2026-10-29T11:00:00.000Z',
      recentActions: [{ action: 'user.balance.adjust', count: 2 }],
      windowLimit: 200,
      windowTruncated: false,
      latest: [
        {
          at: '2026-10-29T11:00:00.000Z',
          actor: 'user:1:admin',
          action: 'user.balance.adjust',
          targetType: 'user',
          targetId: '7',
          summary: '调整用户 #7 的余额',
          result: 'ok',
          errorCode: null,
        },
      ],
    },
    accounts: {
      health: { state: 'ok', detail: '' },
      total: 5,
      enabled: 4,
      unknown: 2,
      healthy: 1,
      degraded: 1,
      unhealthy: 1,
      autoDisabled: 1,
      lastPass: { checked: 5, healthy: 4, failed: 1, autoDisabled: 1, autoEnabled: 0 },
      lastPassAt: '2026-10-29T11:30:00.000Z',
      running: false,
    },
    warnings: ['USAGE_GAP', 'BILLING_REVIEW', 'QUOTA_SNAPSHOT_STALE'],
    degraded: true,
  }
}
