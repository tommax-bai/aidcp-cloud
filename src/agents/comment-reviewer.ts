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
import { tieredInterests } from '../kernel/persona-format.js';
import type { MandatoryInteractionContext, RoleName, ReadingImagesDonePayload } from '../event-bus/types.js';
import { XHS_COMMENT_PROFILE, type CommentPlatformProfile } from '../platform/index.js';

export interface CommentReviewerOptions extends RoleOptions {
  sessionContext: SessionContext;
  getNoteData: (noteId: string) => NoteData | null;
  /**
   * 平台是否支持「滚动评论区」（change platform-registry-shape，注入闭包，**fail-open**：查表失败返 true）。
   * 角色只经此闭包感知平台能力，绝不 import registry / 出现 platform==='x'。缺省视为支持（老行为）。
   */
  canScrollComments?: () => boolean;
  /** 平台词表（站点名 / 内容名 / 互动指标）：缺省小红书，由 dispatcher 经 commonOptions 注入。 */
  platformProfile?: CommentPlatformProfile;
}

export class CommentReviewer extends BaseRole {
  readonly roleName: RoleName = 'comment_reviewer';
  private readonly sessionContext: SessionContext;
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private readonly canScrollComments: () => boolean;
  private readonly platformProfile: CommentPlatformProfile;
  private unsubscribers: (() => void)[] = [];
  /** 等待 scroll_comments 回执的在途上下文（单飞：一次只深读一篇）。 */
  private pending: { noteId: string; sourcePageType: 'feed' | 'search'; imagesBrowsed: number; count: number; mandatoryInteraction?: MandatoryInteractionContext } | null = null;

  constructor(options: CommentReviewerOptions) {
    super(options);
    if (!options.llm) throw new Error('CommentReviewer 需要 LlmClient');
    this.sessionContext = options.sessionContext;
    this.getNoteData = options.getNoteData;
    this.canScrollComments = options.canScrollComments ?? (() => true);
    this.platformProfile = options.platformProfile ?? XHS_COMMENT_PROFILE;
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
    // 平台能力短路（fail-open）：不支持「滚动评论区」的平台如实直接推进——不调用 LLM 判定、不下发
    // scroll_comments，诚实 commentsRead:0，绝不伪造已读评论。
    if (!this.canScrollComments()) {
      this.emitReadingDone(payload.noteId, payload.sourcePageType, payload.imagesBrowsed, 0, payload.mandatoryInteraction);
      return;
    }
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
        ...(payload.mandatoryInteraction ? { mandatoryInteraction: payload.mandatoryInteraction } : {}),
      };
      this.emit('reading.scroll_comments', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        count,
        ts: Date.now(),
      });
    } else {
      this.emitReadingDone(payload.noteId, payload.sourcePageType, payload.imagesBrowsed, 0, payload.mandatoryInteraction);
    }
  }

  private onActionCompleted(payload: { action: string; ok: boolean; reason?: string }): void {
    if (payload.action !== 'scroll_comments' || !this.pending) return;
    const ctx = this.pending;
    this.pending = null;
    this.emitReadingDone(ctx.noteId, ctx.sourcePageType, ctx.imagesBrowsed, payload.ok ? this.parseScrolledCount(payload.reason, 1) : 0, ctx.mandatoryInteraction);
  }

  private emitReadingDone(
    noteId: string,
    sourcePageType: 'feed' | 'search',
    imagesBrowsed: number,
    commentsRead: number,
    mandatoryInteraction?: MandatoryInteractionContext,
  ): void {
    this.emit('reading.done', {
      noteId,
      sourcePageType,
      imagesBrowsed,
      commentsRead,
      keyPoints: [],
      readDurationMs: 0,
      ...(mandatoryInteraction ? { mandatoryInteraction } : {}),
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
    return [this.personaHeader()];
  }

  /** 人设头（change humanize-interaction-prompts）：注入背景 / 语气 / 兴趣 / 浏览风格，
   *  让「翻不翻评论区」这种性格行为随账号不同而不同。 */
  private personaHeader(): string {
    const { identity, interests, behavior_guidelines: bg } = this.soul;
    const lines = [`你是「${identity.name}」，${identity.role}。${identity.background}`, `语气：${identity.tone}`, `兴趣：${tieredInterests(interests)}`];
    if (bg?.style) lines.push(`你平时逛${this.platformProfile.siteName}的风格：${bg.style}`);
    return lines.join('\n');
  }

  private buildPrompt(note: NoteData): string {
    const visited = this.sessionContext.visitedCount;
    const stateLine = visited > 0 ? `\n（本场你已经看过 ${visited} 篇${this.platformProfile.contentName}了。）\n` : '';

    return `${this.personaHeader()}

你刚看完这篇${this.platformProfile.contentName}的正文，在想**要不要顺手翻一翻评论区**——像真人一样，有时想看看大家怎么说，有时刷过就算了。
${stateLine}
${this.platformProfile.contentName}信息：
标题：${note.title}
内容：${note.content}
${this.platformProfile.metrics.like}：${note.likeCount}${this.platformProfile.metrics.collect ? `，${this.platformProfile.metrics.collect}：${note.collectCount}` : ''}

你怎么定：
- 话题跟你兴趣对味、或者互动量挺高（评论区可能有意思）→ 想看看；
- 跟你没关系、或明显是水帖 → 就跳过。
- 这只是翻着看，不是去发评论。

只输出JSON（不要输出其他内容）：
看评论：{"action":"read","reason":"简短原因"}
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
