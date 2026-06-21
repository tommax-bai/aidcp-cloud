import { deriveWindowQuotas, scaleWindowQuotas, zeroInteractionQuotas } from './quotas.js';
import { createRiskState, RiskStateMachine } from './risk-state-machine.js';
import { SlidingWindowCounter, WINDOW_MS } from './sliding-window-counter.js';
import type { RiskAction, RiskQuotaLevel, RiskSignal, RiskState, RiskStore, WindowQuotas } from './types.js';

export interface RiskControllerOptions {
  accountId?: string;
  quotaLevel?: RiskQuotaLevel;
  clock?: () => number;
  store?: RiskStore;
  initialState?: RiskState;
  minViewsForLikeRatio?: number;
}

export interface CanDoResult {
  allowed: boolean;
  reason?: string;
}

export class RiskController {
  private readonly accountId: string;
  private readonly clock: () => number;
  private readonly counter: SlidingWindowCounter;
  private readonly stateMachine = new RiskStateMachine();
  private readonly store?: RiskStore;
  private readonly minViewsForLikeRatio: number;
  private state: RiskState;
  /** 每账号串行化：所有改 state + saveState 的写经此链，避免并发 read-modify-write 丢更新（D7）。 */
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(options: RiskControllerOptions = {}) {
    const now = options.clock?.() ?? Date.now();
    this.accountId = options.accountId ?? 'default';
    this.clock = options.clock ?? Date.now;
    this.store = options.store;
    this.state = options.initialState ?? createRiskState(this.accountId, now);
    this.state.quotaLevel = options.quotaLevel ?? this.state.quotaLevel;
    this.counter = new SlidingWindowCounter({ clock: this.clock });
    this.minViewsForLikeRatio = options.minViewsForLikeRatio ?? 10;
  }

  static async create(options: RiskControllerOptions = {}): Promise<RiskController> {
    const accountId = options.accountId ?? 'default';
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
      if (this.counter.count(action, window) >= quotas[window][action]) return { allowed: false, reason: `quota:${window}` };
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
    if (!this.canDo(action)) {
      await this.applySignal({ kind: 'quota_exceeded' });
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
    if (this.state.status === 'warned') return scaleWindowQuotas(deriveWindowQuotas('conservative'), 0.7);
    if (this.state.status === 'restricted') return zeroInteractionQuotas(deriveWindowQuotas('conservative'));
    if (this.state.status === 'frozen') return scaleWindowQuotas(deriveWindowQuotas('conservative'), 0);
    return deriveWindowQuotas(this.state.quotaLevel);
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