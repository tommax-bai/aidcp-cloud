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
 * 候选集 MUST 只含**有下发段的主体**（发帖）：评论授权由评论人审闸就地消费、没有下发侧，
 * 它们既不是失联证据，还会把候选窗口占满——查询侧按 `subject_kind='publish'` 收窄，由接线方给定。
 * 每条记录只告警一次（进程内已告警集合），阻塞原因出现或状态迁走即自然退出候选集。
 */

import type { DeploymentTarget } from '../deployment-target.js';
import type { ApprovalDecisionRow } from './publish-approval-store.js';

export interface PendingDispatchAlertSink {
  /** 与既有 `AlertStore.raise` 同形：可直接注入 PgAlertStore，不需要转接层（转接层正是上次漏接的原因）。 */
  raise(input: {
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
  /**
   * 发飞书告警（缺省则只落库）。两者都缺 → 只记日志，并在日志里说明告警未送达。
   * 实现 MUST 在「没有任何接收端」（如无可用群）时**抛错**，绝不静默 return——静默 return 会被记成已送达，
   * 而实际上这条 P1 一个人都收不到。
   */
  notify?: (input: { requestId: string; envKey: string | null; accountId: string | null; waitingMs: number })
    => Promise<void> | void;
  /** requestId → 账号：告警须指明是哪个号。解析失败降级为「未知账号」，绝不因此不告警。 */
  resolveAccountId?: (row: ApprovalDecisionRow) => Promise<string | null>;
  /** 查询侧候选窗口（LIMIT）。候选数达到它本身就是异常信号（窗口被打满 ⇒ 可能有行进不来），必须响。 */
  candidateLimit?: number;
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
    // 候选窗口被打满 = 有行根本进不来（查询按 decided_at ASC + LIMIT）。它本身就是异常，MUST NOT 静默。
    const candidateLimit = this.deps.candidateLimit;
    if (candidateLimit !== undefined && rows.length >= candidateLimit) {
      this.logger.error(
        `[pending-dispatch-watchdog] 待下发候选窗口已打满（${rows.length}/${candidateLimit}）：` +
        '更晚决定的稿件本轮根本进不了候选集，本探测器对它们等同失明——请立即排查积压。',
      );
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
      const envKey = row.envKey ?? null;
      let accountId: string | null = null;
      if (this.deps.resolveAccountId) {
        try {
          accountId = await this.deps.resolveAccountId(row);
        } catch (err) {
          this.logger.warn(
            `[pending-dispatch-watchdog] 账号解析失败（告警照发、只是标为未知账号）requestId=${row.requestId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      const title = '已批准稿件长时间待下发（无阻塞原因）';
      const detail =
        `requestId=${row.requestId} candidateRef=${row.candidateRef} target=${row.executionTarget} ` +
        `account=${accountId ?? '未知'} envKey=${envKey ?? '未知'} ` +
        `decidedBy=${row.decidedBy} decidedVia=${row.decidedVia} waitingMs=${waitingMs} ` +
        '（无 dispatch_blocked_reason ⇒ 下发侧疑似失联，绝非已解释的等待）';
      let delivered = false;
      try {
        await this.deps.alertStore?.raise({
          severity: 'P1',
          type: 'publish_pending_dispatch',
          ...(accountId ? { accountId } : {}),
          title,
          detail,
        });
        delivered = delivered || this.deps.alertStore !== undefined;
      } catch (err) {
        this.logger.warn(`[pending-dispatch-watchdog] alerts 落库失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await this.deps.notify?.({ requestId: row.requestId, envKey, accountId, waitingMs });
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
