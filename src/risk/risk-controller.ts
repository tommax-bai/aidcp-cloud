import { deriveWindowQuotas, scaleWindowQuotas, zeroInteractionQuotas } from './quotas.js';
import { createRiskState, RiskStateMachine } from './risk-state-machine.js';
import { SlidingWindowCounter, WINDOW_MS } from './sliding-window-counter.js';
import type { QuotaProvider, RiskAction, RiskQuotaLevel, RiskSignal, RiskState, RiskStore, WindowQuotas } from './types.js';

export interface RiskControllerOptions {
  accountId?: string;
  quotaLevel?: RiskQuotaLevel;
  clock?: () => number;
  store?: RiskStore;
  initialState?: RiskState;
  minViewsForLikeRatio?: number;
  /**
   * 配额数字提供者（change safety-quota-config）：effectiveQuotas 的基准三档数字来源。
   * 缺省（不注入）→ 回落 deriveWindowQuotas 写死默认（与历史行为逐位一致，零回归）。只读、永不抛。
   */
  quotaProvider?: QuotaProvider;
}

export interface CanDoResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

export class RiskController {
  private readonly accountId: string;
  private readonly clock: () => number;
  private readonly counter: SlidingWindowCounter;
  private readonly stateMachine = new RiskStateMachine();
  private readonly store?: RiskStore;
  private readonly minViewsForLikeRatio: number;
  private readonly quotaProvider?: QuotaProvider;
  private state: RiskState;
  /** 每账号串行化：所有改 state + saveState 的写经此链，避免并发 read-modify-write 丢更新（D7）。 */
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(options: RiskControllerOptions = {}) {
    const now = options.clock?.() ?? Date.now();
    this.accountId = options.accountId ?? '__unbound__';
    this.clock = options.clock ?? Date.now;
    this.store = options.store;
    this.state = options.initialState ?? createRiskState(this.accountId, now);
    this.state.quotaLevel = options.quotaLevel ?? this.state.quotaLevel;
    this.counter = new SlidingWindowCounter({ clock: this.clock });
    this.minViewsForLikeRatio = options.minViewsForLikeRatio ?? 10;
    this.quotaProvider = options.quotaProvider;
  }

  static async create(options: RiskControllerOptions = {}): Promise<RiskController> {
    const accountId = options.accountId ?? '__unbound__';
    const now = options.clock?.() ?? Date.now();
    await options.store?.init?.();
    const state = (await options.store?.loadState(accountId)) ?? options.initialState ?? createRiskState(accountId, now);
    const events = (await options.store?.loadCounters(accountId, now - WINDOW_MS.day)) ?? [];
    const controller = new RiskController({ ...options, accountId, initialState: state });
    for (const event of events) controller.counter.record(event.action, event.occurredAt, event.count);
    return controller;
  }

  canDo(action: RiskAction): boolean {
    return this.explain(action).allowed;
  }

  explain(action: RiskAction): CanDoResult {
    if (this.state.status === 'frozen') return { allowed: false, reason: 'state:frozen' };
    if (this.state.status === 'restricted' && action !== 'view') return { allowed: false, reason: 'state:restricted' };
    if (this.state.status === 'warned' && action === 'publish') return { allowed: false, reason: 'state:warned_publish_paused' };

    const quotas = this.effectiveQuotas();
    for (const window of ['minute', 'hour', 'day'] as const) {
      const quota = quotas[window][action];
      if (this.counter.count(action, window) >= quota) {
        return {
          allowed: false,
          reason: `quota:${window}`,
          retryAfterMs: this.counter.retryAfterMs(action, window, quota),
        };
      }
    }
    if (action === 'like' && !this.likeRatioAllowsNextLike()) return { allowed: false, reason: 'ratio:like_view' };
    return { allowed: true };
  }

  /**
   * 某动作当日剩余配额（按账号、按当前档位与状态）。当前被拦（状态/任一窗口耗尽）→ 0。
   * 供评论评估在最便宜阶段预判每日上限（与 dispatch 前 canDo 同源，避免空跑撰写）。
   */
  dailyRemaining(action: RiskAction): number {
    if (!this.canDo(action)) return 0;
    const quotas = this.effectiveQuotas();
    return Math.max(0, quotas.day[action] - this.counter.count(action, 'day'));
  }

  async record(action: RiskAction): Promise<boolean> {
    // 撞自己的速率配额是「节奏背压」，不是风控信号：被拒只返 false（canDo 已拦住动作），
    // 绝不 applySignal 自升威胁态（change decouple-quota-hit-from-risk）。威胁态只由平台可观测
    // 信号（验证码/阻断浮层/运营手动）驱动。过载节奏的可见性改由接线层（server.ts 的
    // interaction.occurred）经 explain() 判 quota:hour/minute 发低优先级运维告警。
    if (!this.canDo(action)) {
      return false;
    }
    const now = this.clock();
    this.counter.record(action, now);
    await this.store?.appendCounter(this.accountId, action, now);
    return true;
  }

  getState(): RiskState {
    return { ...this.state };
  }

  /** 把一个 state 写排进每账号串行链（transition+saveState 或 setQuotaLevel+saveState 原子）。 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(fn, fn); // 前一个成败都继续
    this.mutationChain = run.then(
      () => undefined,
      () => undefined,
    ); // 链不因 error 断
    return run;
  }

  async applySignal(signal: RiskSignal): Promise<RiskState> {
    return this.enqueue(async () => {
      this.state = this.stateMachine.transition(this.state, signal, signal.at ?? this.clock());
      await this.store?.saveState(this.state);
      return this.getState();
    });
  }

  /**
   * 改账号配额档位（V1 task 8.3）：controller 单写 state.quotaLevel + 持久 + 经串行链。
   * 状态机从不碰 quotaLevel，故必须经此方法（绝不 raw UPDATE）。
   */
  async setQuotaLevel(level: RiskQuotaLevel): Promise<RiskState> {
    return this.enqueue(async () => {
      this.state = { ...this.state, quotaLevel: level, updatedAt: this.clock() };
      await this.store?.saveState(this.state);
      return this.getState();
    });
  }

  effectiveQuotas(): WindowQuotas {
    // 基准三档数字：provider（热加载库值）优先，缺则回落 deriveWindowQuotas 写死默认（零回归）。
    // 注意：warned/restricted/frozen 基准固定 'conservative'（与历史一致，非 state.quotaLevel）；
    // 缩放 / 清零语义不变，只是基准数字来源换成 provider。
    const base = (level: RiskQuotaLevel): WindowQuotas =>
      this.quotaProvider?.windowQuotasFor(level) ?? deriveWindowQuotas(level);
    if (this.state.status === 'warned') return scaleWindowQuotas(base('conservative'), 0.7);
    if (this.state.status === 'restricted') return zeroInteractionQuotas(base('conservative'));
    if (this.state.status === 'frozen') return scaleWindowQuotas(base('conservative'), 0);
    return base(this.state.quotaLevel);
  }

  counts() {
    return this.counter.snapshot();
  }

  private likeRatioAllowsNextLike(): boolean {
    const views = this.counter.count('view', 'day');
    if (views < this.minViewsForLikeRatio) return true;
    const projectedRatio = (this.counter.count('like', 'day') + 1) / views;
    return projectedRatio <= 0.35;
  }
}
