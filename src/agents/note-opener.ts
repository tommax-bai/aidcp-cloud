/**
 * NoteOpener — 笔记"已访问"记录角色。
 *
 * 分两步，关键在于"标已访问"必须等"真的打开了"，而不是"决定要开"：
 *  - 找到值得看的卡（content.valuable）：仅记录来源页类型（feed/search）；
 *  - 帖子真正打开、详情回传（note.detail.arrived）：才用回传的真实 noteId 标"已访问"
 *    并重置连续空滑计数。
 *
 * 为什么这样：若在"决定要开"时就标已访问，那些想开却被滑走 / 开失败的卡会被误标，
 * 以后永远不再被选中（漏看）。确定性执行角色，不使用 LLM。
 *
 * 消费事件：content.valuable（记来源页）、note.detail.arrived（标已访问 + 重置计数）
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';

export class NoteOpener extends BaseRole {
  readonly roleName: RoleName = 'note_opener';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
  }

  subscribe(): void {
    this.unsubscribers.push(
      // 决定要看某张卡：仅记录来源页类型，供后续评估与返回判断（此处不标已访问）。
      this.eventBus.on('content.valuable', (p) => this.ctx.setSourcePageType(p.sourcePageType)),
      // 帖子真正打开、详情回传后：用回传的真实 noteId 标"已访问" + 重置连续空滑计数。
      this.eventBus.on('note.detail.arrived', (p) => {
        const noteId = p.detail.noteId;
        if (!noteId) return;
        this.ctx.markVisited(noteId);
        this.ctx.resetScrolls();
      }),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }
}
