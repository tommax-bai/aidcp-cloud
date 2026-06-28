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
import { DEFAULT_IDLE_END_MS, DEFAULT_IDLE_NUDGE_MS } from '../risk/resume-limits.js';

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
  // 默认 N≈130s/M=1h：N 须 > 详情页停留上限（pacing capMs=90s）避免正常长停留中途误触。
  // 显式 idleNudgeMs/idleEndMs 为测试/显式覆盖；缺省经 getIdleNudgeMs/getIdleEndMs 按账号现读（热加载）。
  idleNudgeMs?: number;
  idleEndMs?: number;
  /** 统一看门狗阈值解析口（change session-auto-resume-with-excursions）：调度器注入按账号读 ResumeConfigProvider 的 thunk（热加载）。 */
  getIdleNudgeMs?: () => number;
  getIdleEndMs?: () => number;
  /**
   * 「可活跃时间」周历闸（change weekly-active-window）：调度器注入、每次 checkSession 现读（热加载）。
   * 返回 false（当前已跨入后台配置的非活跃时段）→ 结束会话。缺省（未注入）= 不设闸（零回归）。
   */
  getActiveWindowOpen?: () => boolean;
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
  /** 显式看门狗阈值覆盖（测试/显式注入）；缺省经 getIdle*Ms 解析（按账号读，热加载）；再缺回落写死默认。 */
  private readonly idleNudgeMsOverride?: number;
  private readonly idleEndMsOverride?: number;
  private readonly getIdleNudgeMs?: () => number;
  private readonly getIdleEndMs?: () => number;
  /** 「可活跃时间」周历闸（调度器注入）：checkSession 现读，返回 false → 结束会话；缺省 = 不设闸。 */
  private readonly getActiveWindowOpen?: () => boolean;
  private readonly idleTickMs: number;
  /**
   * 可暂停时钟（change session-auto-resume-with-excursions）：暂停期只延期**时限/动作数/配额**判定
   * （checkSession early-return），**不冻空闲看门狗**（巡视上报刷新 idle、卡死巡视由看门狗兜底）。
   * 多原因引用计数（非布尔）正确处理嵌套/并发；末次解除时前移 startedAt 排除暂停窗口。
   */
  private pauseReasons = new Set<string>();
  private pauseStartedAt = 0;
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
    this.idleNudgeMsOverride = options.idleNudgeMs;
    this.idleEndMsOverride = options.idleEndMs;
    this.getIdleNudgeMs = options.getIdleNudgeMs;
    this.getIdleEndMs = options.getIdleEndMs;
    this.getActiveWindowOpen = options.getActiveWindowOpen;
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
    // 暂停态绝不跨场残留（每场重订阅清空，杜绝时钟永冻）。
    this.pauseReasons.clear();
    this.pauseStartedAt = 0;
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
    // 拆订阅亦清暂停态（防对已结束会话误触/残留）。
    this.pauseReasons.clear();
    this.pauseStartedAt = 0;
  }

  /**
   * 暂停时钟（change session-auto-resume-with-excursions）：会话内 excursion（如通知巡视）期间调用，
   * 延期时限/动作数/配额判定（checkSession early-return），**不冻空闲看门狗**。多原因引用计数：
   * 0→1 转换记暂停窗口起点；同 reason 幂等。
   */
  pauseClock(reason: string): void {
    if (this.pauseReasons.size === 0) this.pauseStartedAt = this.clock();
    this.pauseReasons.add(reason);
  }

  /**
   * 恢复时钟：删该 reason；陌生 token no-op（多租户/重启错配安全）。末次（size→0）解除时前移 startedAt
   * 排除整个暂停窗口（= 排除 excursion 耗时），并补调一次 checkSession 把「延期的结束」补发出来。
   */
  resumeClock(reason: string): void {
    if (!this.pauseReasons.has(reason)) return;
    this.pauseReasons.delete(reason);
    if (this.pauseReasons.size > 0) return;
    this.startedAt += this.clock() - this.pauseStartedAt;
    this.pauseStartedAt = 0;
    this.checkSession();
  }

  /** 时限/动作数/配额判定是否处于暂停。 */
  private clockPaused(): boolean {
    return this.pauseReasons.size > 0;
  }

  /** 看门狗恢复轻推阈值（毫秒）：显式覆盖优先；否则按账号现读（热加载）；缺省回落写死默认。 */
  private effectiveIdleNudgeMs(): number {
    return this.idleNudgeMsOverride ?? this.getIdleNudgeMs?.() ?? DEFAULT_IDLE_NUDGE_MS;
  }

  /** 看门狗放弃结束阈值（毫秒）：显式覆盖优先；否则按账号现读（热加载）；缺省回落写死默认。 */
  private effectiveIdleEndMs(): number {
    return this.idleEndMsOverride ?? this.getIdleEndMs?.() ?? DEFAULT_IDLE_END_MS;
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
    // 空闲看门狗**不受 clockPaused 影响**（巡视期保持活着当兜底，见 spec browse-loop-resilience）。
    // 两段阈值每 tick 现读（热加载）：放弃结束默认 1h、恢复轻推 ~2min。
    const idleEndMs = this.effectiveIdleEndMs();
    const idleNudgeMs = this.effectiveIdleNudgeMs();
    if (idle >= idleEndMs) {
      this.triggerEnd(`idle ${(idle / 1000) | 0}s 无活动，看门狗终止会话`);
      return;
    }
    if (idle >= idleNudgeMs && now - this.lastNudgeAt >= idleNudgeMs) {
      this.lastNudgeAt = now;
      this.emit('session.idle_nudge', { reason: 'idle_recover_nudge', ts: now });
    }
  }

  private checkSession(): void {
    // 暂停期延期一切结束条件（时长/动作数/配额）——excursion（巡视）进行中不结束、不打断；
    // resumeClock 末次解除时会补调本方法，把延期的结束补发出来。
    if (this.clockPaused()) return;

    // 「可活跃时间」周历闸（change weekly-active-window）：会话进行中跨入后台配置的非活跃时段 → 结束会话
    // （与开场 / 续场同一周历；按服务器本地时间）。巡视暂停期不打断（上方 clockPaused 已 early-return）；
    // 缺注入 = 不设闸（零回归）。续场侧会被 canAutoResume 同闸挡住，故窗口外不会立刻重开。
    if (this.getActiveWindowOpen && !this.getActiveWindowOpen()) {
      this.triggerEnd('已进入非活跃时段（可活跃时间闸）');
      return;
    }

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
