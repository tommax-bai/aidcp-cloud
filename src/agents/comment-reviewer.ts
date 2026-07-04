/**
 * CommentReviewer — 评论浏览判定与编排角色（LLM）。
 *
 * 职责：多图阶段完成后，用 LLM 判定本篇笔记的评论区是否值得浏览；
 * 决定看则下发 scroll_comments 指令、等回执后推进，决定不看则直接推进。
 * 两种情形最终都 emit reading.done —— 进入互动阶段的唯一出口（下游 InteractionAppraiser 不变）。
 *
 * 本角色只做"浏览评论"，不发表评论。
 *
 * 消费事件：reading.images_done、action.completed（scroll_comments 回执）
 * 产出事件：reading.scroll_comments（意图）、reading.done
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { SessionContext } from './session-context.js';
import type { NoteData } from './content-curator-role.js';
import type { RoleName, ReadingImagesDonePayload } from '../event-bus/types.js';

export interface CommentReviewerOptions extends RoleOptions {
  sessionContext: SessionContext;
  getNoteData: (noteId: string) => NoteData | null;
}

export class CommentReviewer extends BaseRole {
  readonly roleName: RoleName = 'comment_reviewer';
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private unsubscribers: (() => void)[] = [];
  /** 等待 scroll_comments 回执的在途上下文（单飞：一次只深读一篇）。 */
  private pending: { noteId: string; sourcePageType: 'feed' | 'search'; imagesBrowsed: number; count: number } | null = null;

  constructor(options: CommentReviewerOptions) {
    super(options);
    if (!options.llm) throw new Error('CommentReviewer 需要 LlmClient');
    this.getNoteData = options.getNoteData;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('reading.images_done', (p) => this.onImagesDone(p)),
      this.eventBus.on('action.completed', (p) => this.onActionCompleted(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.pending = null;
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private async onImagesDone(payload: ReadingImagesDonePayload): Promise<void> {
    const note = this.getNoteData(payload.noteId);
    let read = false;
    if (note) {
      try {
        const raw = await this.decide(this.buildPrompt(note));
        read = this.parseRead(raw);
      } catch {
        read = false; // LLM 失败 → 不看评论，直接推进，不阻塞互动
      }
    }

    if (read && note) {
      const count = this.planScrollCount(note, payload.imagesBrowsed);
      this.pending = {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        imagesBrowsed: payload.imagesBrowsed,
        count,
      };
      this.emit('reading.scroll_comments', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        count,
        ts: Date.now(),
      });
    } else {
      this.emitReadingDone(payload.noteId, payload.sourcePageType, payload.imagesBrowsed, 0);
    }
  }

  private onActionCompleted(payload: { action: string; ok: boolean; reason?: string }): void {
    if (payload.action !== 'scroll_comments' || !this.pending) return;
    const ctx = this.pending;
    this.pending = null;
    this.emitReadingDone(ctx.noteId, ctx.sourcePageType, ctx.imagesBrowsed, payload.ok ? this.parseScrolledCount(payload.reason, 1) : 0);
  }

  private emitReadingDone(
    noteId: string,
    sourcePageType: 'feed' | 'search',
    imagesBrowsed: number,
    commentsRead: number,
  ): void {
    this.emit('reading.done', {
      noteId,
      sourcePageType,
      imagesBrowsed,
      commentsRead,
      keyPoints: [],
      readDurationMs: 0,
      ts: Date.now(),
    });
  }

  // ─── Prompt 构建 / 解析 ────────────────────────────────────

  /** 只读预览（change role-prompt-visibility）：用最小示例数据 + 真实人设渲染真实 prompt，仅供后台查看；不改 buildPrompt 逻辑。 */
  previewPrompt(): string {
    return this.buildPrompt({ noteId: '<示例noteId>', title: '<示例标题>', content: '<示例正文，运行时为真实笔记内容>', author: '<示例作者>', likeCount: 0, collectCount: 0 });
  }

  /** 只读人设来源片段（change prompt-viewer-persona-source）：与 buildPrompt 同源拼接，仅供查看器定位标注；不改 buildPrompt。 */
  personaSegments(): string[] {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');
    return [`你是「${identity.name}」，${identity.role}。兴趣：${interestsStr}。`];
  }

  private buildPrompt(note: NoteData): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');

    return `你是「${identity.name}」，${identity.role}。兴趣：${interestsStr}。
你刚看完一篇小红书笔记的正文，正在决定**要不要顺手翻一翻评论区**（像真人一样：有时看、有时跳过）。

笔记信息：
标题：${note.title}
内容：${note.content}
点赞：${note.likeCount}，收藏：${note.collectCount}

判断口径：
- 话题与你的兴趣相关、或互动量较高（评论区可能有有价值的讨论）→ 倾向看；
- 与兴趣无关、或明显是水帖 → 倾向跳过。
- 这是浏览行为，不是发评论。

只输出JSON（不要输出其他内容）：
看评论：{"action":"read","reason":"简短原因","confidence":0.7}
不看：{"action":"skip","reason":"简短原因"}`;
  }

  private parseRead(raw: string): boolean {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return false;
    let obj: unknown;
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return false;
    }
    if (!obj || typeof obj !== 'object') return false;
    return (obj as Record<string, unknown>).action === 'read';
  }

  private planScrollCount(note: NoteData, imagesBrowsed: number): number {
    const textLen = note.content.length;
    const engagement = note.likeCount + note.collectCount * 1.5;
    let count = textLen > 900 ? 8 : textLen > 520 ? 7 : textLen > 260 ? 6 : 4;
    if (engagement >= 600) count += 2;
    else if (engagement >= 180) count += 1;
    if (imagesBrowsed >= 6) count += 1;
    return Math.max(3, Math.min(10, count));
  }

  private parseScrolledCount(reason: unknown, fallback: number): number {
    if (typeof reason !== 'string') return fallback;
    const m = reason.match(/scrolled=(\d+)(?:\/\d+)?/);
    if (!m) return fallback;
    const n = Number(m[1]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }
}
