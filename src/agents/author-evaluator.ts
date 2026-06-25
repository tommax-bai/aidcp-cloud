/**
 * AuthorEvaluator — 作者评估角色（LLM）。
 *
 * 职责：评估是否值得进入博主个人主页。
 * 消费事件：comment.done / comment.skipped（发评论支线结算后，即「先互动才评估主页」）
 * 产出事件：profile.worth_visiting（值得去）或 profile.skipped（不值得 / 已关注 / 数据缺失）
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { SessionContext } from './session-context.js';
import type { NoteData } from './content-curator-role.js';
import type { RoleName, CommentDonePayload, CommentSkippedPayload } from '../event-bus/types.js';

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
      // 接在发评论支线之后：评论成功(comment.done)或跳过(comment.skipped)后，才评估是否进个人主页。
      // 评论支线只在真 like/collect 过的笔记上触发，故仍是「先互动才评估主页」。
      this.eventBus.on('comment.done', (p) => this.onCommentResolved(p)),
      this.eventBus.on('comment.skipped', (p) => this.onCommentResolved(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private async onCommentResolved(payload: CommentDonePayload | CommentSkippedPayload): Promise<void> {
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

    // 已关注作者：跳过整条主页子链（change skip-profile-visit-if-followed）。
    // 在调 LLM 之前最早短路——不评估、不下发 profile.open、不浏览主页、不发起关注。
    // 信号来自 note.detail 的 authorFollowed（边缘探测的平台当下真实态）；缺省/读取失败时落 false，
    // 走原评估流程，并由末端 interaction.follow 的 already_followed 良性 no-op 作兜底。
    if (noteData.authorFollowed === true) {
      this.emit('profile.skipped', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        reason: 'already_followed',
        ts: Date.now(),
      });
      return;
    }

    const prompt = this.buildPrompt(noteData, payload.actions);
    let raw: string;
    try {
      raw = await this.decide(prompt);
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

  /** 只读预览（change role-prompt-visibility）：用最小示例数据 + 真实人设渲染真实 prompt，仅供后台查看；不改 buildPrompt 逻辑。 */
  previewPrompt(): string {
    return this.buildPrompt({ noteId: '<示例noteId>', title: '<示例标题>', content: '<示例正文，运行时为真实笔记内容>', author: '<示例作者>', likeCount: 0, collectCount: 0 }, ['like', 'collect']);
  }

  /** 只读人设来源片段（change prompt-viewer-persona-source）：与 buildPrompt 同源拼接，仅供查看器定位标注；不改 buildPrompt。 */
  personaSegments(): string[] {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');
    return [`你是「${identity.name}」，${identity.role}。兴趣：${interestsStr}。`];
  }

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

评估维度（从严，只在明显值得时才进；普通作者倾向 skip）：
- 作者原创质量：该笔记是否**明显**展现了作者的专业深度和原创能力（泛泛内容不算）
- 主题匹配度：作者创作方向是否与你的兴趣**高度**吻合（仅沾边不算）
- 长期关注价值：你是否**真的会想长期跟进**该博主的更新

仅当三者都明显成立时才 visit；只要其一勉强或拿不准，一律 skip。

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
