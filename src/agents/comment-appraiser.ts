/**
 * CommentAppraiser — 评论评估角色（LLM）。
 *
 * 职责：决定「要不要在这篇笔记发评论」（只判定、不产文本）。精品逻辑——只在高热度/高价值笔记上评。
 * 消费事件：interaction.completed（即仅在真 like/collect 过的笔记上触发）
 * 产出事件：comment.appraised（要评）或 comment.skipped（不评/无配额/无数据）
 *
 * 数量闸（最便宜阶段就拦）：会话评论预算 + 可选的每账号每日上限（min 取小，配置层下一阶段接入）。
 * 风控 canDo('comment') 在下发前由 RoleDispatcher 再把一道闸；本角色不重复。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { NoteData } from './content-curator-role.js';
import type { RoleName, InteractionCompletedPayload } from '../event-bus/types.js';

export interface CommentAppraiserOptions extends RoleOptions {
  getNoteData: (noteId: string) => NoteData | null;
  /** 剩余会话评论预算（每会话稀缺名额）。 */
  getRemainingComments: () => number;
  /** 可选：该账号当日剩余评论上限（后台配置；缺省视为不额外限制，仅会话预算 + 风控生效）。 */
  getDailyRemaining?: () => number;
}

export class CommentAppraiser extends BaseRole {
  readonly roleName: RoleName = 'comment_appraiser';
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private readonly getRemainingComments: () => number;
  private readonly getDailyRemaining?: () => number;
  private unsubscribers: (() => void)[] = [];

  constructor(options: CommentAppraiserOptions) {
    super(options);
    if (!options.llm) throw new Error('CommentAppraiser 需要 LlmClient');
    this.getNoteData = options.getNoteData;
    this.getRemainingComments = options.getRemainingComments;
    this.getDailyRemaining = options.getDailyRemaining;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('interaction.completed', (p) => this.onInteractionCompleted(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private skip(payload: InteractionCompletedPayload, reason: string): void {
    this.emit('comment.skipped', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: payload.actions,
      reason,
      ts: Date.now(),
    });
  }

  private async onInteractionCompleted(payload: InteractionCompletedPayload): Promise<void> {
    // 数量闸（最便宜阶段）：会话预算 + 每日上限取小，任一耗尽即不评。
    if (this.getRemainingComments() <= 0) {
      this.skip(payload, 'no_comment_budget');
      return;
    }
    if (this.getDailyRemaining && this.getDailyRemaining() <= 0) {
      this.skip(payload, 'daily_cap_reached');
      return;
    }

    const note = this.getNoteData(payload.noteId);
    if (!note) {
      this.skip(payload, 'note_data_unavailable');
      return;
    }

    let raw: string;
    try {
      raw = await this.decide(this.buildPrompt(note));
    } catch {
      this.skip(payload, 'llm_error');
      return;
    }

    const verdict = this.parseOutput(raw);
    if (!verdict) {
      this.skip(payload, 'parse_failed');
      return;
    }
    if (!verdict.comment) {
      this.skip(payload, verdict.reason || 'not_worth_commenting');
      return;
    }

    this.emit('comment.appraised', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: payload.actions,
      ts: Date.now(),
    });
  }

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
你刚对这篇笔记做了互动，现在决定「要不要在它下面留一条评论」。

评论是最稀缺、最慎重的互动——只在**高热度 + 高价值的精品笔记**上评，每天只发极少量。
判定门槛（从严，宁缺毋滥）：
- 高热度：点赞/收藏量明显偏高，是被广泛认可的优质内容；
- 高价值：内容对你这个人格真正有共鸣、有可说的真东西，能自然地接一句，而不是套话；
- 不评的情形：普通/低热度笔记、你没有真实可说的、只能说客套话的，一律不评。

当前笔记：
标题：${note.title}
内容：${note.content}
点赞数：${note.likeCount}，收藏数：${note.collectCount}

只输出JSON：
要评：{"comment":true,"reason":"为何这条精品值得评"}
不评：{"comment":false,"reason":"简短原因"}`;
  }

  private parseOutput(raw: string): { comment: boolean; reason: string } | null {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let obj: unknown;
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    if (typeof o.comment !== 'boolean') return null;
    const reason = typeof o.reason === 'string' ? o.reason : '';
    return { comment: o.comment, reason };
  }
}
