/**
 * AuthorEvaluator — 作者评估角色（LLM）。
 *
 * 职责：评估是否值得进入博主个人主页。
 * 消费事件：interaction.completed
 * 产出事件：profile.worth_visiting（值得去）或 profile.skipped（不值得）
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { SessionContext } from './session-context.js';
import type { NoteData } from './content-curator-role.js';
import type { RoleName, InteractionCompletedPayload } from '../event-bus/types.js';

export interface AuthorEvaluatorOptions extends RoleOptions {
  sessionContext: SessionContext;
  getNoteData: (noteId: string) => NoteData | null;
}

export class AuthorEvaluator extends BaseRole {
  readonly roleName: RoleName = 'author_evaluator';
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private unsubscribers: (() => void)[] = [];

  constructor(options: AuthorEvaluatorOptions) {
    super(options);
    if (!options.llm) throw new Error('AuthorEvaluator 需要 LlmClient');
    this.getNoteData = options.getNoteData;
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

  // ─── 事件处理 ─────────────────────────────────────────────

  private async onInteractionCompleted(payload: InteractionCompletedPayload): Promise<void> {
    const noteData = this.getNoteData(payload.noteId);
    if (!noteData) {
      this.emit('profile.skipped', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        reason: 'note_data_unavailable',
        ts: Date.now(),
      });
      return;
    }

    const authorId = noteData.author ?? 'unknown';
    if (authorId === 'unknown') {
      this.emit('profile.skipped', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        reason: 'author_unknown',
        ts: Date.now(),
      });
      return;
    }

    const prompt = this.buildPrompt(noteData, payload.actions);
    let raw: string;
    try {
      raw = await this.llm!.complete(prompt);
    } catch {
      this.emit('profile.skipped', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        reason: 'llm_error',
        ts: Date.now(),
      });
      return;
    }

    const result = this.parseOutput(raw);
    if (!result) {
      this.emit('profile.skipped', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        reason: 'parse_failed',
        ts: Date.now(),
      });
      return;
    }

    if (result.verdict === 'visit') {
      this.emit('profile.worth_visiting', {
        noteId: payload.noteId,
        authorId,
        sourcePageType: payload.sourcePageType,
        reason: result.reason,
        ts: Date.now(),
      });
    } else {
      this.emit('profile.skipped', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        reason: result.reason,
        ts: Date.now(),
      });
    }
  }

  // ─── Prompt 构建 ───────────────────────────────────────────

  private buildPrompt(note: NoteData, actions: ('like' | 'collect')[]): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');
    const actionsStr = actions.join('+');
    const hasCollect = actions.includes('collect');

    return `你是「${identity.name}」，${identity.role}。兴趣：${interestsStr}。
你刚完成了对一篇笔记的互动（${actionsStr}），现在要决定是否值得进入该博主的个人主页。

笔记信息：
标题：${note.title}
内容摘要：${note.content}
作者：${note.author ?? '未知'}
点赞：${note.likeCount}，收藏：${note.collectCount}

互动类型：${actionsStr}${hasCollect ? '（收藏说明内容价值较高）' : ''}

评估维度：
- 作者原创质量：该笔记是否展现了作者的专业深度和原创能力
- 主题匹配度：作者创作方向是否与你的兴趣高度吻合
- 长期关注价值：是否值得长期关注该博主的更新

只输出JSON（不要输出其他内容）：
值得访问：{"verdict":"visit","reason":"简短原因","confidence":0.8}
不值得：{"verdict":"skip","reason":"简短原因"}`;
  }

  // ─── 输出解析 ───────────────────────────────────────────────

  private parseOutput(raw: string): EvalResult | null {
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

    if (o.verdict === 'visit') {
      const reason = typeof o.reason === 'string' ? o.reason : 'worth_visiting';
      return { verdict: 'visit', reason };
    } else if (o.verdict === 'skip') {
      const reason = typeof o.reason === 'string' ? o.reason : 'not_worth';
      return { verdict: 'skip', reason };
    }

    return null;
  }
}

// ─── 内部类型 ─────────────────────────────────────────────────

interface EvalResultVisit {
  verdict: 'visit';
  reason: string;
}

interface EvalResultSkip {
  verdict: 'skip';
  reason: string;
}

type EvalResult = EvalResultVisit | EvalResultSkip;
