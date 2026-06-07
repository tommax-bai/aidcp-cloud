/**
 * NoteOpener — 笔记打开角色。
 *
 * 职责：消费 content.valuable 事件，执行 open_note 动作，更新会话上下文。
 * 确定性执行角色，不使用 LLM。
 *
 * 消费事件：content.valuable
 * 产出事件：note.entered
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName, ContentValuablePayload } from '../event-bus/types.js';

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
      this.eventBus.on('content.valuable', (p) => this.handleContentValuable(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private handleContentValuable(payload: ContentValuablePayload): void {
    // 使用真实 noteId（来自 Edge 上报），fallback 到 index 生成
    const noteId = payload.noteId || `note_${payload.index}`;

    // 更新会话上下文
    this.ctx.setCurrentNoteId(noteId);
    this.ctx.markVisited(noteId);
    this.ctx.setSourcePageType(payload.sourcePageType);
    this.ctx.resetScrolls();

    // 发出 note.entered 事件
    this.emit('note.entered', {
      noteId,
      sourcePageType: payload.sourcePageType,
      ts: Date.now(),
    });
  }
}
