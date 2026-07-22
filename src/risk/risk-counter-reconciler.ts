/**
 * 内存计数 ↔ 库内事实对账（change risk-state-cross-process-integrity，design D6）。
 *
 * 单写者成立时内存计数是对的；它出错的方式是「**有别的东西往库里写了行而我不知道**」——归属变更、
 * 运维手工 SQL、另一个 target 的历史遗留行。改动前这件事完全不可观测：内存计数只在 controller
 * 创建时回放一次，之后只累加本进程自己写的那些，而准入判定读的就是这份内存计数。
 *
 * **判据是「偏差是否为零」，MUST NOT 引入容忍阈值**——一旦允许阈值，这个信号就退化成噪声，
 * 而它要守的恰恰是「差 1 次点赞也是多发了一次真实平台动作」。
 *
 * 只对**已物化**的 controller 做（账号量级几十），且只查当日窗口总量（走
 * `idx_risk_counters_account_action_time`）。绝不因对账而物化新 controller。
 */
import { shanghaiDayStartMs } from '../time/shanghai-day.js';
import type { RiskControllerRegistry } from './risk-controller-registry.js';
import { RISK_ACTIONS, type ActionQuota, type RiskAction } from './types.js';

export interface RiskCounterReconcilerDeps {
  registry: Pick<RiskControllerRegistry, 'materializedAccountIds' | 'peek'>;
  /** 库内当日总量。用 PgRiskStore.totalsForAccountSince。 */
  totalsSince: (accountId: string, since: number) => Promise<ActionQuota>;
  onDrift?: (info: {
    accountId: string;
    action: RiskAction;
    memory: number;
    database: number;
  }) => void | Promise<void>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  clock?: () => number;
  /** 对账周期。默认 5 分钟，AIDCP_RISK_RECONCILE_INTERVAL_MS 可配。 */
  intervalMs?: number;
}

export interface ReconcileDrift {
  accountId: string;
  action: RiskAction;
  memory: number;
  database: number;
}

export class RiskCounterReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: RiskCounterReconcilerDeps) {}

  start(): void {
    const interval = Math.max(10_000, this.deps.intervalMs ?? 5 * 60_000);
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) =>
        this.deps.logger?.warn?.(
          `[risk-reconcile] 对账失败: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 跑一轮对账。偏差非零 → 告警（带 accountId / 动作 / 内存值 / 库值）并**以库为准重建**该账号计数。
   * 返回本轮检出的全部偏差项（空数组 = 逐项相等）。
   */
  async runOnce(): Promise<ReconcileDrift[]> {
    if (this.running) return [];
    this.running = true;
    const drifts: ReconcileDrift[] = [];
    try {
      const now = this.deps.clock?.() ?? Date.now();
      // 窗口口径 MUST 与内存 day 窗一致：SlidingWindowCounter 的 day 是**上海自然日**
      // （sliding-window-counter.ts 的 eventInWindow），不是 24 小时滑动窗。取错口径会制造
      // 恒定非零的假偏差，把这个信号变成噪声——正是 design D6 拒绝阈值时要避免的那种退化。
      const since = shanghaiDayStartMs(now);
      for (const accountId of this.deps.registry.materializedAccountIds()) {
        const pending = this.deps.registry.peek(accountId);
        if (!pending) continue;
        const controller = await pending;
        const database = await this.deps.totalsSince(accountId, since);
        const memory = controller.counts().day;
        const accountDrifts: ReconcileDrift[] = [];
        for (const action of RISK_ACTIONS) {
          if ((memory[action] ?? 0) !== (database[action] ?? 0)) {
            accountDrifts.push({ accountId, action, memory: memory[action] ?? 0, database: database[action] ?? 0 });
          }
        }
        if (accountDrifts.length === 0) continue;
        drifts.push(...accountDrifts);
        for (const drift of accountDrifts) {
          this.deps.logger?.warn?.(
            `[risk-reconcile] 计数偏差 account=${drift.accountId} action=${drift.action} 内存=${drift.memory} 库=${drift.database}`,
          );
          try {
            await this.deps.onDrift?.(drift);
          } catch {
            // 告警链路故障绝不阻断重建——带着偏差继续做准入判定才是真正危险的那一侧。
          }
        }
        // 以库为准重建：MUST NOT 静默沿用偏差计数继续做准入判定。
        await controller.reloadCounters();
      }
    } finally {
      this.running = false;
    }
    return drifts;
  }
}
