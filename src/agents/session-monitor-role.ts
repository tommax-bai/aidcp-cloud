/**
 * SessionMonitorRole — 事件驱动版会话守护角色。
 *
 * 职责：监听 action.completed 事件，跟踪会话进度，检测终止条件。
 * 当触发终止条件（时长超限 / 动作数超限 / 配额耗尽）时，
 * 通过 EventBus 发出 session.should_end 事件通知 RoleDispatcher 结束会话。
 *
 * 消费事件：action.completed
 * 产出事件：session.should_end
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { RoleName } from '../event-bus/types.js';
import { DEFAULT_SESSION_DURATION_MS } from '../risk/session-limits.js';

export interface SessionMonitorRoleOptions extends RoleOptions {
  maxDurationMs?: number;
  /**
   * 统一时长上限解析口（change session-limits-to-quota-layer）：由调度器注入 `() => this.maxDurationMs()`，
   * 使监测体与浏览闭环共用同一「按账号读单场上限提供者」路径（热加载）。缺省 → 回落写死默认 10min。
   */
  getMaxDurationMs?: () => number;
  maxActions?: number;
  maxLikes?: number;
  maxCollects?: number;
  maxFollows?: number;
  maxSearches?: number;
  onSessionEnd?: (reason: string) => void;
  getRemainingBudget: () => { likes: number; collects: number; follows: number; searches: number };
  clock?: () => number;
  // idle 看门狗（wall-clock）：超 idleNudgeMs 无活动→发恢复 nudge；超 idleEndMs→结束会话。
  // 默认 N=130s/M=240s：N 须 > 详情页停留上限（pacing capMs=90s）避免正常长停留中途误触。
  idleNudgeMs?: number;
  idleEndMs?: number;
  idleTickMs?: number;
  // 可注入定时器（测试用桩 + 手动调 checkIdle）；生产用真 setInterval。
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export class SessionMonitorRole extends BaseRole {
  readonly roleName: RoleName = 'session_monitor';
  private readonly onSessionEnd?: (reason: string) => void;
  private readonly getRemainingBudget: () => { likes: number; collects: number; follows: number; searches: number };
  /** 显式时长上限覆盖（测试 / 显式注入用）；缺省则经 getMaxDurationMs 解析（调度器按账号读单场上限提供者）。 */
  private readonly maxDurationMsOverride?: number;
  /** 统一时长上限解析口（调度器注入）；缺省回落写死默认。 */
  private readonly getMaxDurationMs?: () => number;
  private readonly maxActions: number;
  private readonly clock: () => number;
  private readonly idleNudgeMs: number;
  private readonly idleEndMs: number;
  private readonly idleTickMs: number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private unsubscribers: (() => void)[] = [];
  private startedAt = 0;
  private actionCount = 0;
  private lastActivityAt = 0;
  private lastNudgeAt = 0;
  private intervalHandle: unknown;

  constructor(options: SessionMonitorRoleOptions) {
    super(options);
    this.onSessionEnd = options.onSessionEnd;
    this.getRemainingBudget = options.getRemainingBudget;
    this.maxDurationMsOverride = options.maxDurationMs;
    this.getMaxDurationMs = options.getMaxDurationMs;
    this.maxActions = options.maxActions ?? 60;
    this.clock = options.clock ?? Date.now;
    this.idleNudgeMs = options.idleNudgeMs ?? 130_000;
    this.idleEndMs = options.idleEndMs ?? 240_000;
    this.idleTickMs = options.idleTickMs ?? 5_000;
    this.setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn =
      options.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  subscribe(): void {
    this.startedAt = this.clock();
    this.actionCount = 0;
    this.lastActivityAt = this.clock();
    this.lastNudgeAt = 0;
    this.unsubscribers.push(
      this.eventBus.on('action.completed', () => this.handleActionCompleted()),
    );
    // idle 看门狗：任何 edge 上报都刷新"最后活动时间"（action.completed 在 handleActionCompleted 内刷新）。
    const refresh = (): void => {
      this.lastActivityAt = this.clock();
    };
    this.unsubscribers.push(
      this.eventBus.on('page.cards.arrived', refresh),
      this.eventBus.on('note.detail.arrived', refresh),
      this.eventBus.on('profile.detail.arrived', refresh),
      // 通知巡视期边缘上报也算"活动"：每步回执续会话命，使健康巡视不被 idle 看门狗误判停滞
      // （巡视期 browse 帧被暂停出口扣住，否则看门狗会因没有 browse 上报而累积 idle）。
      this.eventBus.on('notification.detected.arrived', refresh),
      this.eventBus.on('notification.home.arrived', refresh),
      this.eventBus.on('notification.items.arrived', refresh),
    );
    // 启动 wall-clock 定时检查；unref 避免在 Node 下挂住进程 / 测试 runner。
    this.intervalHandle = this.setIntervalFn(() => this.checkIdle(), this.idleTickMs);
    (this.intervalHandle as { unref?: () => void } | undefined)?.unref?.();
  }

  unsubscribe(): void {
    // 先清看门狗定时器，杜绝泄漏与对已结束会话的误触。
    if (this.intervalHandle !== undefined) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  /** 获取当前会话统计（供测试/调试用） */
  getStats(): { actionCount: number; elapsedMs: number } {
    return {
      actionCount: this.actionCount,
      elapsedMs: this.clock() - this.startedAt,
    };
  }

  /** 会话时长上限（毫秒）：显式覆盖优先；否则经调度器注入的统一解析口（按账号读单场上限提供者，热加载）；缺省回落写死默认。 */
  private effectiveMaxDurationMs(): number {
    return this.maxDurationMsOverride ?? this.getMaxDurationMs?.() ?? DEFAULT_SESSION_DURATION_MS;
  }

  private handleActionCompleted(): void {
    this.lastActivityAt = this.clock();
    this.actionCount++;
    this.checkSession();
  }

  /**
   * wall-clock idle 看门狗（定时调用）：距上次 edge 活动过久则自愈/终止，不再死等外部 SIGTERM。
   * - idle ≥ idleEndMs：判定真停滞 → triggerEnd（emit session.should_end → dispatcher 下发 session.end）。
   * - idle ≥ idleNudgeMs（按 idleNudgeMs 节流）：emit session.idle_nudge → dispatcher 翻译为一次 scroll 恢复。
   * intervalHandle 守卫：会话结束后定时器已清，残留 tick 直接 return，防误触已结束会话。
   */
  private checkIdle(): void {
    if (this.intervalHandle === undefined) return;
    const now = this.clock();
    const idle = now - this.lastActivityAt;
    if (idle >= this.idleEndMs) {
      this.triggerEnd(`idle ${(idle / 1000) | 0}s 无活动，看门狗终止会话`);
      return;
    }
    if (idle >= this.idleNudgeMs && now - this.lastNudgeAt >= this.idleNudgeMs) {
      this.lastNudgeAt = now;
      this.emit('session.idle_nudge', { reason: 'idle_recover_nudge', ts: now });
    }
  }

  private checkSession(): void {
    // 动作数超限
    if (this.actionCount >= this.maxActions) {
      this.triggerEnd(`动作数 ${this.actionCount} 已达上限 ${this.maxActions}`);
      return;
    }

    // 时长超限
    const elapsed = this.clock() - this.startedAt;
    if (elapsed >= this.effectiveMaxDurationMs()) {
      this.triggerEnd(`会话时长 ${(elapsed / 60_000).toFixed(1)}min 已超限`);
      return;
    }

    // 配额耗尽
    const budget = this.getRemainingBudget();
    if (budget.likes <= 0 && budget.collects <= 0 && budget.searches <= 0) {
      this.triggerEnd('所有互动配额已耗尽');
      return;
    }
  }

  private triggerEnd(reason: string): void {
    // 通过事件总线通知 RoleDispatcher
    this.emit('session.should_end', { reason, ts: this.clock() });

    // 兼容回调方式
    if (this.onSessionEnd) {
      this.onSessionEnd(reason);
    }
  }
}
