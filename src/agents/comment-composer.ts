/**
 * CommentComposer — 评论撰写角色（LLM）。
 *
 * 职责：为已判定值得评论的笔记，生成一条短、真诚、贴题、人格化的评论文本。
 * 消费事件：comment.appraised
 * 产出事件：comment.composed（draft）或 comment.skipped（撰写失败/空/超长）
 *
 * 这是浏览闭环里**首个产出自由文本**的角色（其余只产结构化判定）：自管空/超长/裸@/去引号。
 * data-tribute 提及：撰写须避开裸 `@`，否则边缘输入会触发提及弹窗。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { NoteData } from './content-curator-role.js';
import type { RoleName, CommentAppraisedPayload } from '../event-bus/types.js';

const MAX_COMMENT_LEN = 50;

export interface CommentComposerOptions extends RoleOptions {
  getNoteData: (noteId: string) => NoteData | null;
}

export class CommentComposer extends BaseRole {
  readonly roleName: RoleName = 'comment_composer';
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private unsubscribers: (() => void)[] = [];

  constructor(options: CommentComposerOptions) {
    super(options);
    if (!options.llm) throw new Error('CommentComposer 需要 LlmClient');
    this.getNoteData = options.getNoteData;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('comment.appraised', (p) => this.onAppraised(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private skip(payload: CommentAppraisedPayload, reason: string): void {
    this.emit('comment.skipped', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: payload.actions,
      reason,
      ts: Date.now(),
    });
  }

  private async onAppraised(payload: CommentAppraisedPayload): Promise<void> {
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

    const draft = this.sanitize(this.extractText(raw));
    if (!draft) {
      this.skip(payload, 'compose_empty');
      return;
    }
    if (draft.length > MAX_COMMENT_LEN) {
      this.skip(payload, 'compose_too_long');
      return;
    }

    this.emit('comment.composed', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: payload.actions,
      draft,
      ts: Date.now(),
    });
  }

  private buildPrompt(note: NoteData): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');
    return `你是「${identity.name}」，${identity.role}。语气：${identity.tone}。兴趣：${interestsStr}。
为下面这篇你认可的笔记写**一条**评论。要求：
- 短（${MAX_COMMENT_LEN} 字以内）、真诚、像真人随手留言，不是营销/客套；
- 贴这篇笔记的具体内容，接一句有共鸣或真问题，别泛泛而谈；
- 用你的人格语气；不要 emoji 堆砌、不要 AI 腔（如「值得一提」「总而言之」）；
- **不要出现 @ 提及**、不要话题标签、不要外链。

当前笔记：
标题：${note.title}
内容：${note.content}

只输出JSON：{"text":"你的评论"}`;
  }

  /** 优先取 JSON {text}，否则退化为首个非空行。 */
  private extractText(raw: string): string {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
        if (typeof o.text === 'string') return o.text;
      } catch {
        /* fall through */
      }
    }
    const line = raw.split('\n').map((l) => l.trim()).find(Boolean);
    return line ?? '';
  }

  /** 去首尾引号/空白；剥掉裸 @ 提及（data-tribute 防误触发）。 */
  private sanitize(text: string): string {
    let t = text.trim().replace(/^["'“”『「]+|["'“”』」]+$/g, '').trim();
    t = t.replace(/@\S+/g, '').replace(/\s{2,}/g, ' ').trim();
    return t;
  }
}
