/**
 * SessionMonitorRole — 事件驱动版会话守护角色。
 *
 * 职责：监听所有执行类事件，跟踪会话进度，检测终止条件。
 * 当触发终止条件（时长超限 / 配额耗尽）时，通过回调通知 RoleDispatcher 结束会话。
 *
 * 消费事件：feed.scrolled、search.scrolled、note.entered、interaction.completed、feed.entered
 * 产出：通过 onSessionEnd 回调通知外部终止会话
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { RoleName } from '../event-bus/types.js';

export interface SessionMonitorRoleOptions extends RoleOptions {
  maxDurationMs?: number;
  maxLikes?: number;
  maxCollects?: number;
  maxFollows?: number;
  maxSearches?: number;
  onSessionEnd: (reason: string) => void;
  getRemainingBudget: () => { likes: number; collects: number; follows: number; searches: number };
  clock?: () => number;
}

export class SessionMonitorRole extends BaseRole {
  readonly roleName: RoleName = 'session_monitor';
  private readonly onSessionEnd: (reason: string) => void;
  private readonly getRemainingBudget: () => { likes: number; collects: number; follows: number; searches: number };
  private readonly maxDurationMs: number;
  private readonly clock: () => number;
  private unsubscribers: (() => void)[] = [];
  private startedAt = 0;
  private eventCount = 0;

  constructor(options: SessionMonitorRoleOptions) {
    super(options);
    this.onSessionEnd = options.onSessionEnd;
    this.getRemainingBudget = options.getRemainingBudget;
    this.maxDurationMs = options.maxDurationMs ?? 10 * 60_000;
    this.clock = options.clock ?? Date.now;
  }

  subscribe(): void {
    this.startedAt = this.clock();
    this.unsubscribers.push(
      this.eventBus.on('feed.scrolled', () => this.checkSession()),
      this.eventBus.on('search.scrolled', () => this.checkSession()),
      this.eventBus.on('note.entered', () => this.checkSession()),
      this.eventBus.on('interaction.completed', () => this.checkSession()),
      this.eventBus.on('feed.entered', () => this.checkSession()),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private checkSession(): void {
    this.eventCount++;

    // 时长超限
    const elapsed = this.clock() - this.startedAt;
    if (elapsed >= this.maxDurationMs) {
      this.onSessionEnd(`会话时长 ${(elapsed / 60_000).toFixed(1)}min 已超限`);
      return;
    }

    // 配额耗尽
    const budget = this.getRemainingBudget();
    if (budget.likes <= 0 && budget.collects <= 0 && budget.searches <= 0) {
      this.onSessionEnd('所有互动配额已耗尽');
      return;
    }
  }
}
