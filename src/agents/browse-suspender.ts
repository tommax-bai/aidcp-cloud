/**
 * browse_suspender — 暂停浏览。
 *
 * 收 excursion.requested → 打开"暂停浏览"开关（dispatcher 的发命令统一出口据此扣住 browse 类命令，
 * 放行巡视命令）→ browse.suspended。开关存 ctx，断连/结束由 reset 一并清，绝不残留冻结浏览。
 *
 * 消费事件：excursion.requested
 * 产出事件：browse.suspended
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';

export class BrowseSuspender extends BaseRole {
  readonly roleName: RoleName = 'browse_suspender';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('excursion.requested', (p) => {
        this.ctx.setBrowseSuspended(true);
        this.ctx.setExcursionPhase('suspended');
        this.log(`浏览已暂停 epoch=${p.epoch}`);
        this.emit('browse.suspended', { epoch: p.epoch, ts: Date.now() });
      }),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }
}
