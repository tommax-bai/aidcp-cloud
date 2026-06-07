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

export interface SessionMonitorRoleOptions extends RoleOptions {
  maxDurationMs?: number;
  maxActions?: number;
  maxLikes?: number;
  maxCollects?: number;
  maxFollows?: number;
  maxSearches?: number;
  onSessionEnd?: (reason: string) => void;
  getRemainingBudget: () => { likes: number; collects: number; follows: number; searches: number };
  clock?: () => number;
}

export class SessionMonitorRole extends BaseRole {
  readonly roleName: RoleName = 'session_monitor';
  private readonly onSessionEnd?: (reason: string) => void;
  private readonly getRemainingBudget: () => { likes: number; collects: number; follows: number; searches: number };
  private readonly maxDurationMs: number;
  private readonly maxActions: number;
  private readonly clock: () => number;
  private unsubscribers: (() => void)[] = [];
  private startedAt = 0;
  private actionCount = 0;

  constructor(options: SessionMonitorRoleOptions) {
    super(options);
    this.onSessionEnd = options.onSessionEnd;
    this.getRemainingBudget = options.getRemainingBudget;
    this.maxDurationMs = options.maxDurationMs ?? 10 * 60_000;
    this.maxActions = options.maxActions ?? 60;
    this.clock = options.clock ?? Date.now;
  }

  subscribe(): void {
    this.startedAt = this.clock();
    this.actionCount = 0;
    this.unsubscribers.push(
      this.eventBus.on('action.completed', () => this.handleActionCompleted()),
    );
  }

  unsubscribe(): void {
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

  private handleActionCompleted(): void {
    this.actionCount++;
    this.checkSession();
  }

  private checkSession(): void {
    // 动作数超限
    if (this.actionCount >= this.maxActions) {
      this.triggerEnd(`动作数 ${this.actionCount} 已达上限 ${this.maxActions}`);
      return;
    }

    // 时长超限
    const elapsed = this.clock() - this.startedAt;
    if (elapsed >= this.maxDurationMs) {
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
