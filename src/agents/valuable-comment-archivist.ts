/**
 * ValuableCommentArchivist — 优质评论归档角色（薄，无 LLM）。change comment-like-on-detail（B 子系统）。
 *
 * 只干一件事：监听【真点赞成功】的 comment_like.confirmed，把那条评论连同来源笔记主题键归档进语料库。
 * 严格只在 confirmed（= ok:true 回执）上归档——没真点成的（弃权 / no_target / state_unchanged）绝不入库。
 * 关联完整性：confirmed 事件直接携带 {noteId, anchor, text, author, reason}（由 appraiser 单航班态发出），
 * 故按 anchor 做 dedup_key、按来源笔记标题派生主题键，不依赖回执（回执本身不带文本）。
 *
 * 消费事件：comment_like.confirmed
 * 副作用：archive() 落库（PII：存了别人评论原文 + 作者昵称，仅限已点赞的公开评论，带保留上限）。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { NoteData } from './content-curator-role.js';
import type { RoleName } from '../event-bus/types.js';
import { topicKeysFromTitle, type ValuableCommentInput } from '../cache/valuable-comment-store.js';

export interface ValuableCommentArchivistOptions extends RoleOptions {
  getNoteData: (noteId: string) => NoteData | null;
  archive: (input: ValuableCommentInput) => Promise<void>;
}

export class ValuableCommentArchivist extends BaseRole {
  readonly roleName: RoleName = 'valuable_comment_archivist';
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private readonly archive: (input: ValuableCommentInput) => Promise<void>;
  private unsubscribers: (() => void)[] = [];

  constructor(options: ValuableCommentArchivistOptions) {
    super(options);
    this.getNoteData = options.getNoteData;
    this.archive = options.archive;
  }

  subscribe(): void {
    this.unsubscribers.push(this.eventBus.on('comment_like.confirmed', (p) => this.onConfirmed(p)));
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private onConfirmed(payload: {
    noteId: string;
    commentAnchorId: string;
    author?: string;
    text: string;
    reason: string;
  }): void {
    const note = this.getNoteData(payload.noteId);
    const title = note?.title;
    const input: ValuableCommentInput = {
      dedupKey: payload.commentAnchorId,
      text: payload.text,
      author: payload.author,
      sourceNoteId: payload.noteId,
      sourceNoteTitle: title,
      topics: topicKeysFromTitle(title),
      reason: payload.reason,
    };
    // fire-and-forget：归档失败不影响浏览主路径（如实 log，不抛）。
    this.archive(input).catch((err) => this.log(`归档失败（不影响主流程）：${(err as Error).message}`));
  }
}
