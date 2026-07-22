/**
 * 风控记账漏斗 + outbox worker（change risk-state-cross-process-integrity，design D5）。
 *
 * **全系统只此一条计数递增路径**：任何「真实平台动作已经发生」的事实，都先同步落进 outbox，
 * 再由 apply 在单事务里写 risk_counters 并**只在此时**递增内存计数。杜绝「emit 时加一次、
 * apply 时又加一次」的双计，也杜绝「加了内存没落库」的静默丢账。
 *
 * 三条不可让步的性质：
 * 1. **入队在推进之前**：回执处理先 await 入队成功，再 emit / 继续浏览闭环。
 * 2. **入队失败 = 记账失败**：告警 + 该账号 fail-closed（停止下发新的自动互动命令），
 *    MUST NOT 当作无事发生继续制造真实平台动作——那等于明知记不上账还继续超发。
 * 3. **判定值取自写入前**：节奏饱和告警依据的 explain 在入队前取，outbox 只承载事实、不承载判定。
 */
import type { AlertStore } from '../alerts/alert-store.js';
import type { RiskController } from './risk-controller.js';
import type { CanDoResult } from './risk-controller.js';
import type { RiskCounterOutbox, RiskCounterOutboxClaim } from './risk-counter-outbox-store.js';
import type { RiskAction } from './types.js';

export interface RiskAccountingOptions {
  outbox: RiskCounterOutbox;
  /** 解析该账号的**可写** controller（取写入前判定 + apply 后递增内存计数）。 */
  resolveController: (accountId: string) => Promise<RiskController>;
  alertStore?: Pick<AlertStore, 'raise'>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  clock?: () => number;
  /** 单条 outbox 行的重试上限，超限进死信。默认 5。 */
  maxAttempts?: number;
  /** 崩溃恢复兜底轮询间隔。默认 5s——常规路径是入队后同进程立即 apply，轮询只兜底。 */
  pollIntervalMs?: number;
  /** 认领租约。默认 30s。 */
  leaseMs?: number;
  /** 单批认领上限。默认 50。 */
  batchLimit?: number;
  workerId: string;
}

export interface RiskAccountingRecordInput {
  accountId: string;
  action: RiskAction;
  occurredAt?: number;
  /**
   * 去重键。边缘回执路径 MUST 用 `${envelopeId}:${action}`（重发同一信封天然去重）；
   * 云端自证路径（发布 / 私信回复 / 手动评论）用调用点自带的唯一标识。
   */
  dedupeKey: string;
}

export class RiskAccounting {
  private readonly opts: Required<Omit<RiskAccountingOptions, 'alertStore' | 'logger'>> &
    Pick<RiskAccountingOptions, 'alertStore' | 'logger'>;
  /** 记账失败而被 fail-closed 的账号：其互动准入判定一律拒绝，直到下一次成功入队或人工解除。 */
  private readonly blocked = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private applying: Promise<number> | null = null;
  /** 飞行中又来了请求时排队的下一轮 apply（最多一轮，见 applyNow）。 */
  private queued: Promise<number> | null = null;
  private stopped = false;

  constructor(options: RiskAccountingOptions) {
    this.opts = {
      outbox: options.outbox,
      resolveController: options.resolveController,
      clock: options.clock ?? Date.now,
      maxAttempts: Math.max(1, options.maxAttempts ?? 5),
      pollIntervalMs: Math.max(200, options.pollIntervalMs ?? 5_000),
      leaseMs: Math.max(1_000, options.leaseMs ?? 30_000),
      batchLimit: Math.max(1, options.batchLimit ?? 50),
      workerId: options.workerId,
      alertStore: options.alertStore,
      logger: options.logger,
    };
  }

  /** 该账号是否因记账失败被 fail-closed。RiskController.explain 据此拒绝一切互动动作。 */
  isBlocked(accountId: string): boolean {
    return this.blocked.has(accountId);
  }

  blockedAccounts(): string[] {
    return [...this.blocked];
  }

  /** 人工解除 fail-closed（面板 / 运维）。返回是否真的解除了（绝不假成功）。 */
  clearBlock(accountId: string): boolean {
    return this.blocked.delete(accountId);
  }

  /**
   * 启动：先回收本 target 下租约过期的在途行并把条数写进启动日志（对齐既有启动自检形态），
   * 再起兜底轮询。返回回收条数供装配处打印。
   */
  async start(): Promise<{ recovered: number }> {
    this.stopped = false;
    let recovered = 0;
    try {
      recovered = await this.opts.outbox.recoverExpiredClaims(this.opts.clock());
    } catch (err) {
      this.opts.logger?.warn?.(
        `[risk-accounting] 启动回收失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.timer = setInterval(() => {
      void this.applyNow().catch(() => undefined);
    }, this.opts.pollIntervalMs);
    this.timer.unref?.();
    return { recovered };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 记一次既成事实：**先取写入前判定**，再入队，再立即 apply。返回的判定值与改动前
   * `RiskController.record()` 的返回语义逐字一致（答「这个动作在不在策略内」，不答「有没有发生」）。
   *
   * ⚠️ **求值顺序不可换**：判定读的就是内存计数，而 apply 会写它。先写后判会把刚写的这一笔算进
   * 自己，撞顶那一次的判定会从「超策略」翻成「在策略内」。这条不变量随记账路径从 controller
   * 迁到这里，逐字保留。
   */
  async record(input: RiskAccountingRecordInput): Promise<CanDoResult> {
    const controller = await this.opts.resolveController(input.accountId);
    const verdict = controller.explain(input.action);
    await this.enqueue(input);
    await this.applyNow();
    return verdict;
  }

  /**
   * 只入队，不 apply。给「回执处理先落库、再 emit 推进闭环」这条路径用：
   * apply 由随后的 interaction.occurred / search.occurred 订阅者触发（那里也是取判定的地方）。
   *
   * 入队失败 MUST 抛给调用方：调用方据此不推进闭环。同时本方法已完成告警 + fail-closed 登记。
   */
  async enqueue(input: RiskAccountingRecordInput): Promise<void> {
    const occurredAt = input.occurredAt ?? this.opts.clock();
    try {
      await this.opts.outbox.enqueue({
        accountId: input.accountId,
        action: input.action,
        occurredAt,
        dedupeKey: input.dedupeKey,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.blocked.add(input.accountId);
      await this.raise({
        severity: 'P1',
        type: 'risk_accounting_enqueue_failed',
        accountId: input.accountId,
        title: `风控记账入队失败，账号 ${input.accountId} 已停止下发自动互动命令`,
        detail:
          `动作 ${input.action} 已被边缘确认为真实发生，但 outbox 入队失败：${detail}。` +
          `继续驱动该账号等于明知记不上账还在制造真实平台动作，故已 fail-closed。` +
          `恢复办法：修复数据库写入后由面板解除，或等待下一次成功入队自动解除。`,
      });
      throw err;
    }
    // 成功入队 ⇒ 记账链路已恢复 ⇒ 解除该账号的 fail-closed。
    if (this.blocked.delete(input.accountId)) {
      this.opts.logger?.log?.(`[risk-accounting] 账号 ${input.accountId} 记账恢复，解除 fail-closed`);
    }
  }

  /**
   * 认领并应用一批 outbox 行。**内存计数只在这里递增**，且只对真正落账的行递增。
   *
   * 并发调用不会同时跑两轮，但也 **MUST NOT 直接复用飞行中的那一次**：飞行中的那一次可能早在
   * 本次入队之前就完成了 `claimBatch`，复用它等于「本次入队的行这一轮根本不会被认领」，内存计数
   * 要等下一次兜底轮询（默认 5s）才递增，这段时间准入判定读到的是偏低的计数、放行偏松。
   * design D5 明确「入队后同进程立即触发一次 apply，轮询只作崩溃恢复的兜底、不作常规路径」——
   * 直接复用会让多账号并发下的常规路径整个退化成轮询。
   *
   * 故：飞行中则**排队一轮后续 apply**，调用方等到的是一次一定发生在本次入队之后的认领。
   * 排队最多一轮（第 N 个并发请求共享同一个后续轮次），既不退化成轮询，也不会无界堆叠。
   */
  applyNow(): Promise<number> {
    if (this.applying) {
      if (!this.queued) {
        // applying 的 finally 挂在更内层的 promise 上、先于本 then 执行，
        // 故这里再调 applyNow 时 this.applying 已复位，会真正开新一轮。
        this.queued = this.applying.catch(() => 0).then(() => {
          this.queued = null;
          return this.applyNow();
        });
      }
      return this.queued;
    }
    const run = this.applyOnce().finally(() => {
      this.applying = null;
    });
    this.applying = run;
    return run;
  }

  private async applyOnce(): Promise<number> {
    if (this.stopped) return 0;
    let claimed: RiskCounterOutboxClaim[];
    try {
      claimed = await this.opts.outbox.claimBatch({
        workerId: this.opts.workerId,
        leaseMs: this.opts.leaseMs,
        limit: this.opts.batchLimit,
        now: this.opts.clock(),
      });
    } catch (err) {
      this.opts.logger?.warn?.(
        `[risk-accounting] 认领 outbox 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
    let applied = 0;
    for (const row of claimed) {
      let committed = false;
      try {
        const done = await this.opts.outbox.applyClaimed([row]);
        if (done.length === 0) continue; // 认领已失效，交由真正的持有者应用
        committed = true;
        // 落库成功后才递增内存计数——**全系统唯一的递增路径**。
        const controller = await this.opts.resolveController(row.accountId);
        controller.recordFact(row.action, row.occurredAt);
        applied += 1;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (committed) {
          // 落账事务已 COMMIT，失败发生在**之后**（解析 controller / 递增内存计数）。
          // MUST NOT 回写 outbox 状态、MUST NOT 报死信：那一行已经在账本里，说它「没进账本」是假陈述。
          // 真实的偏差是「库里有、内存没有」，那正是对账器（design D6）负责检出并以库为准重建的形状。
          this.opts.logger?.warn?.(
            `[risk-accounting] 落账已提交但内存计数未递增 id=${row.id} account=${row.accountId}: ${detail}` +
              `（不回写 outbox；等对账以库为准重建）`,
          );
          continue;
        }
        try {
          const { dead } = await this.opts.outbox.failClaimed(row, detail, this.opts.maxAttempts);
          if (dead) {
            await this.raise({
              severity: 'P1',
              type: 'risk_accounting_dead_letter',
              accountId: row.accountId,
              title: `风控记账进入死信：账号 ${row.accountId} 的 ${row.action} 未能计入配额`,
              detail:
                `outbox id=${row.id} dedupeKey=${row.dedupeKey} 连续失败 ${this.opts.maxAttempts} 次：${detail}。` +
                `该动作真实发生过但没进账本，后续配额判定会据此以为尚有余量。MUST 人工补记或修复后重放。`,
            });
          }
        } catch (failErr) {
          this.opts.logger?.error?.(
            `[risk-accounting] 记录 outbox 失败状态时又失败 id=${row.id}: ${
              failErr instanceof Error ? failErr.message : String(failErr)
            }`,
          );
        }
      }
    }
    return applied;
  }

  /** 积压与死信量（面板可读；这是「已经知道自己丢了什么」与「不知道」的分界）。 */
  async backlog(): Promise<{ pending: number; dead: number; staleClaims: number; blockedAccounts: number }> {
    const counts = await this.opts.outbox.backlogCounts(this.opts.clock());
    return { ...counts, blockedAccounts: this.blocked.size };
  }

  private async raise(input: {
    severity: 'P0' | 'P1' | 'P2' | 'P3';
    type: string;
    accountId?: string;
    title: string;
    detail: string;
  }): Promise<void> {
    this.opts.logger?.warn?.(`[risk-accounting] ${input.title} — ${input.detail}`);
    if (!this.opts.alertStore) return;
    try {
      await this.opts.alertStore.raise(input);
    } catch (err) {
      this.opts.logger?.error?.(
        `[risk-accounting] 告警写入失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
