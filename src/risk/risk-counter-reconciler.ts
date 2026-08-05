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
 *
 * ---
 * **对账范围 MUST 按归属收敛**（change scope-risk-reconcile-to-owned-accounts）。
 *
 * `risk_counters` 是 dev / ol **共用且不带 `execution_target`** 的既成事实账本（design D4
 * 「分裂的是写权限，不分裂的是事实」），而内存计数只在**本进程自己记账**时递增。于是对「归属在另一个
 * target 的账号」，两者结构上不可能相等：对面在真干活往共用账本里写行，本进程那份内存快照一动不动。
 *
 * 而本进程为什么会持有这些账号的内存计数——**面板 / 客户端的只读用量与配额查询会顺手物化 controller**。
 * 一次纯只读的查询就此把一个自己根本不驱动的账号拖进了对账范围。
 *
 * 2026-08-05 生产实测：dev 报的 4 个账号归属全是 ol，ol 报的 5 个账号归属全是 dev，两边零交集、
 * 与归属完全反相关；日志数值签名同样吻合（本轮「内存」恰等于上轮「库」——重建过、此后本进程一次没加）。
 * 每 5 分钟、每账号、每动作各刷一条 P1，把这条**刻意做成零容忍**的信号淹进了常态噪音。
 *
 * 三态 MUST NOT 压成两态（见本 change design D2）：归属＝本 target ⇒ 对账；归属＝另一 target ⇒ 跳过；
 * **读不到 / 读失败 ⇒ 跳过并计数，MUST NOT 默认按本 target 处理**（「未知」不等于「是我的」）。
 */
import type { DeploymentTarget } from '../deployment-target.js';
import type { ExecutionTargetResolution } from '../kernel/account-ownership-port.js';
import { shanghaiDayStartMs } from '../time/shanghai-day.js';
import type { RiskControllerRegistry } from './risk-controller-registry.js';
import { RISK_ACTIONS, type ActionQuota, type RiskAction } from './types.js';

export interface RiskCounterReconcilerDeps {
  registry: Pick<RiskControllerRegistry, 'materializedAccountIds' | 'peek'>;
  /** 库内当日总量。用 PgRiskStore.totalsForAccountSince。 */
  totalsSince: (accountId: string, since: number) => Promise<ActionQuota>;
  /**
   * 本进程的部署目标。与 `ownerTargetFor` **成对注入**：缺任一个 ⇒ 不按归属过滤、全量对账
   * （逐字回到本 change 之前的行为，见 design D4）。
   */
  executionTarget?: DeploymentTarget;
  /**
   * 账号归属的三态读。**MUST 复用风控条件写在用的那一口**（`AccountOwnershipPort.resolveExecutionTarget`），
   * MUST NOT 在这里另起一套读法——两份读法漂开的现形方式不是报错，而是「条件写认为账号是我的、
   * 对账认为不是」，且没有任何机械手段会提醒。
   *
   * 这里只接一个窄函数、不认识那个接口类型，单测因此可以完全脱库。
   */
  ownerTargetFor?: (accountId: string) => Promise<ExecutionTargetResolution>;
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

/**
 * 一轮对账的完整结果。
 *
 * 四个计数 MUST 在返回值里（不只打日志）：这道归属过滤自己最危险的失效模式，是**过滤条件写错导致
 * 一条告警都不发**——而「一条告警都不发」和「一切正常」在现有信号面上完全一样（判例：同批加的守卫
 * 只覆盖作者在治的那条道，另半边全绿 6 天无人发现）。`materialized > 0 && reconciled === 0`
 * 是这条失效模式的现形通道，`runOnce` 会就此响亮记录一次。
 */
export interface ReconcileRound {
  /** 本轮检出的全部偏差项（空数组 = 逐项相等）。 */
  drifts: ReconcileDrift[];
  /** 本进程内存里已物化的账号数。 */
  materialized: number;
  /** 实际参与对账的账号数（归属＝本 target）。 */
  reconciled: number;
  /** 因归属在另一个 target 而跳过的账号数。 */
  skippedForeign: number;
  /** 因归属读不到 / 读失败而跳过的账号数。 */
  skippedUnknown: number;
}

export class RiskCounterReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: RiskCounterReconcilerDeps) {}

  /** 是否按归属过滤对账范围。两个依赖成对注入才算数（design D4）。 */
  private get ownershipScoped(): boolean {
    return Boolean(this.deps.executionTarget && this.deps.ownerTargetFor);
  }

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
   *
   * 归属不是本 target 的账号（含读不到的）**只跳过、不告警、也不重建**：它们的内存快照本就只是面板
   * 只读查询留下的副产品，拿它跟共用账本比对没有意义。
   */
  async runOnce(): Promise<ReconcileRound> {
    if (this.running) return { drifts: [], materialized: 0, reconciled: 0, skippedForeign: 0, skippedUnknown: 0 };
    this.running = true;
    const drifts: ReconcileDrift[] = [];
    let materialized = 0;
    let reconciled = 0;
    let skippedForeign = 0;
    let skippedUnknown = 0;
    try {
      const now = this.deps.clock?.() ?? Date.now();
      // 窗口口径 MUST 与内存 day 窗一致：SlidingWindowCounter 的 day 是**上海自然日**
      // （sliding-window-counter.ts 的 eventInWindow），不是 24 小时滑动窗。取错口径会制造
      // 恒定非零的假偏差，把这个信号变成噪声——正是 design D6 拒绝阈值时要避免的那种退化。
      const since = shanghaiDayStartMs(now);
      for (const accountId of this.deps.registry.materializedAccountIds()) {
        materialized += 1;
        const scope = await this.scopeFor(accountId);
        if (scope === 'foreign') {
          skippedForeign += 1;
          continue;
        }
        if (scope === 'unknown') {
          skippedUnknown += 1;
          continue;
        }
        const pending = this.deps.registry.peek(accountId);
        if (!pending) continue;
        reconciled += 1;
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
    // 过滤器把对账做成死代码的现形通道（design D3）：物化了账号却一个都没对上，
    // 与「逐项相等、无偏差」在观测上必须可区分。
    if (materialized > 0 && reconciled === 0) {
      this.deps.logger?.warn?.(
        `[risk-reconcile] 本轮无账号参与对账：已物化=${materialized} 实际对账=0 ` +
          `他target跳过=${skippedForeign} 归属未知跳过=${skippedUnknown}` +
          (this.ownershipScoped ? '' : '（未按归属过滤——此形态下不该出现，请检查注册表）'),
      );
    }
    return { drifts, materialized, reconciled, skippedForeign, skippedUnknown };
  }

  /**
   * 该账号在本轮里的处置：`own` 对账 / `foreign` 跳过 / `unknown` 跳过并计数。
   *
   * 归属读抛错 MUST NOT 中断整轮——一个账号读不到，不该让其余账号一并失去这道保护。
   */
  private async scopeFor(accountId: string): Promise<'own' | 'foreign' | 'unknown'> {
    const { executionTarget, ownerTargetFor } = this.deps;
    // 归属口缺席（AIDCP_RISK_OWNERSHIP_ENFORCE=false 或未装配）⇒ 归属强制本身已关，
    // 此时对账器单方面把自己关成静默，只会在保护最弱的时候再摘掉一层观测（design D4）。
    if (!executionTarget || !ownerTargetFor) return 'own';
    let resolution: ExecutionTargetResolution;
    try {
      resolution = await ownerTargetFor(accountId);
    } catch (err) {
      this.deps.logger?.warn?.(
        `[risk-reconcile] 归属读失败 account=${accountId}，本轮跳过: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'unknown';
    }
    if (resolution.outcome !== 'owned') return 'unknown';
    return resolution.target === executionTarget ? 'own' : 'foreign';
  }
}
