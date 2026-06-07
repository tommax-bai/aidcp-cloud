/**
 * ProfileOpener — 进入博主主页角色（薄角色）。
 *
 * 职责：执行进入博主个人主页的导航动作。
 * 消费事件：profile.worth_visiting
 * 产出事件：profile.entered
 *
 * 不使用 LLM，纯确定性执行。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { RoleName, ProfileWorthVisitingPayload } from '../event-bus/types.js';

export class ProfileOpener extends BaseRole {
  readonly roleName: RoleName = 'profile_opener';
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions) {
    super(options);
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('profile.worth_visiting', (p) => this.handleWorthVisiting(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private handleWorthVisiting(payload: ProfileWorthVisitingPayload): void {
    this.emit('profile.entered', {
      authorId: payload.authorId,
      sourcePageType: payload.sourcePageType,
      ts: Date.now(),
    });
  }
}
