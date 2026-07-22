/**
 * 待下发看门狗（change publish-approval-signal-to-database，task 4.4）。
 *
 * 判据只有一条：**没有原因的长时间待下发 = 执行侧静默失联**。
 * - 有 `dispatch_blocked_reason` 的不告警——那是已解释的等待（边缘离线 / 槽位排队 / 熔断 / 验证码暂停 /
 *   授权不可读），运营在界面上已经看得到原因。对它们告警只制造噪声。
 * - 无阻塞原因却待下发超过阈值的必须告警：这正是「运营点了通过、界面毫无变化、稿件永远发不出去」
 *   的那种形态，本项目红线明令禁止它静默存在。
 *
 * MUST 按本机 `execution_target` 过滤（DEV/OL 共库异步隔离，CLAUDE.md §2）。
 * 每条记录只告警一次（进程内已告警集合），阻塞原因出现或状态迁走即自然退出候选集。
 */

import type { DeploymentTarget } from '../deployment-target.js';
import type { ApprovalDecisionRow } from './publish-approval-store.js';

export interface PendingDispatchAlertSink {
  record(input: {
    severity: 'P0' | 'P1' | 'P2' | 'P3';
    type: string;
    accountId?: string;
    title: string;
    detail?: string;
  }): Promise<unknown>;
}

export interface PendingDispatchWatchdogDeps {
  executionTarget: DeploymentTarget;
  listStalePendingDispatch(executionTarget: DeploymentTarget, olderThanMs: number): Promise<ApprovalDecisionRow[]>;
  /** 落 alerts 表（缺省则只发飞书）。 */
  alertStore?: PendingDispatchAlertSink;
  /** 发飞书告警（缺省则只落库）。两者都缺 → 只记日志，并在日志里说明告警未送达。 */
  notify?: (input: { requestId: string; accountId: string | null; waitingMs: number }) => Promise<void> | void;
  /** 阈值，默认 15 分钟。 */
  thresholdMs?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  clock?: () => number;
}

export class PendingDispatchWatchdog {
  private readonly deps: PendingDispatchWatchdogDeps;
  private readonly thresholdMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly clock: () => number;
  private readonly alerted = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(deps: PendingDispatchWatchdogDeps) {
    this.deps = deps;
    this.thresholdMs = Math.max(60_000, Math.trunc(deps.thresholdMs ?? 15 * 60_000));
    this.logger = deps.logger ?? console;
    this.clock = deps.clock ?? Date.now;
  }

  /** 扫一轮。返回本轮真正发出的告警条数（测试断言用；MUST NOT 把「查失败」算成 0 条正常）。 */
  async sweep(): Promise<number> {
    let rows: ApprovalDecisionRow[];
    try {
      rows = await this.deps.listStalePendingDispatch(this.deps.executionTarget, this.thresholdMs);
    } catch (err) {
      this.logger.warn(
        `[pending-dispatch-watchdog] 待下发扫描失败（本轮未判定，绝不当作无异常）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
    const live = new Set(rows.map((row) => row.requestId));
    for (const requestId of this.alerted) {
      if (!live.has(requestId)) this.alerted.delete(requestId);
    }
    let sent = 0;
    for (const row of rows) {
      if (this.alerted.has(row.requestId)) continue;
      this.alerted.add(row.requestId);
      const waitingMs = Math.max(0, this.clock() - row.decidedAt);
      const accountId = row.envKey ?? null;
      const title = '已批准稿件长时间待下发（无阻塞原因）';
      const detail =
        `requestId=${row.requestId} candidateRef=${row.candidateRef} target=${row.executionTarget} ` +
        `decidedBy=${row.decidedBy} decidedVia=${row.decidedVia} waitingMs=${waitingMs} ` +
        '（无 dispatch_blocked_reason ⇒ 下发侧疑似失联，绝非已解释的等待）';
      let delivered = false;
      try {
        await this.deps.alertStore?.record({ severity: 'P1', type: 'publish_pending_dispatch', title, detail });
        delivered = delivered || this.deps.alertStore !== undefined;
      } catch (err) {
        this.logger.warn(`[pending-dispatch-watchdog] alerts 落库失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await this.deps.notify?.({ requestId: row.requestId, accountId, waitingMs });
        delivered = delivered || this.deps.notify !== undefined;
      } catch (err) {
        this.logger.warn(`[pending-dispatch-watchdog] 飞书告警发送失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!delivered) {
        this.logger.error(`[pending-dispatch-watchdog] 告警无接收端（未落库、未发飞书）: ${detail}`);
      } else {
        sent += 1;
        this.logger.warn(`[pending-dispatch-watchdog] ${title}: ${detail}`);
      }
    }
    return sent;
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep().catch(() => {}), Math.max(10_000, intervalMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
