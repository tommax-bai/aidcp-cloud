/**
 * ContentCuratorRole — 详情页内容质量粗筛角色（LLM，事件驱动版）。
 *
 * 职责：评估笔记内容质量，判断是否值得深度阅读。
 * 消费事件：note.detail.arrived（Edge 上报笔记详情后触发）
 * 产出事件：quality.pass（质量好）或 quality.reject（质量差）
 *
 * 相比旧版的改进：
 * - 监听 note.detail.arrived 而非 note.entered，确保有实际数据可评估
 * - 直接使用 payload 中的笔记数据，无需外部 getNoteData 回调
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';
import { XHS_COMMENT_PROFILE, type CommentPlatformProfile } from '../platform/registry.js';

export interface NoteData {
  noteId: string;
  title: string;
  content: string;
  author?: string;
  likeCount: number;
  collectCount: number;
  /** 详情页作者区关注按钮当下真实态（change skip-profile-visit-if-followed）：已关注/互关→true。
   *  由 note.detail 透传，AuthorEvaluator 据此在评估进主页前短路已关注作者。缺省→原流程。 */
  authorFollowed?: boolean;
}

export interface ContentCuratorRoleOptions extends RoleOptions {
  sessionContext: SessionContext;
  /** 平台词表（站名/内容名/指标）：dispatcher 经 commonOptions 注入，缺省回落小红书。 */
  platformProfile?: CommentPlatformProfile;
}

export class ContentCuratorRole extends BaseRole {
  readonly roleName: RoleName = 'content_curator';
  private readonly sessionContext: SessionContext;
  private readonly platformProfile: CommentPlatformProfile;
  private unsubscribers: (() => void)[] = [];

  constructor(options: ContentCuratorRoleOptions) {
    super(options);
    if (!options.llm) throw new Error('ContentCuratorRole 需要 LlmClient');
    this.sessionContext = options.sessionContext;
    this.platformProfile = options.platformProfile ?? XHS_COMMENT_PROFILE;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('note.detail.arrived', (p) => this.onNoteDetailArrived(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private async onNoteDetailArrived(payload: { detail: NoteData; ts: number }): Promise<void> {
    const noteData = payload.detail;
    const sourcePageType = this.sessionContext.sourcePageType;

    const prompt = this.buildPrompt(noteData);
    let raw: string;
    try {
      raw = await this.decide(prompt);
    } catch {
      this.emit('quality.reject', {
        noteId: noteData.noteId,
        sourcePageType,
        reason: 'llm_error',
        ts: Date.now(),
      });
      return;
    }

    const result = this.parseOutput(raw);
    if (!result) {
      this.emit('quality.reject', {
        noteId: noteData.noteId,
        sourcePageType,
        reason: 'parse_failed',
        ts: Date.now(),
      });
      return;
    }

    if (result.action === 'pass') {
      this.emit('quality.pass', {
        noteId: noteData.noteId,
        sourcePageType,
        reason: result.reason,
        ts: Date.now(),
      });
    } else {
      this.emit('quality.reject', {
        noteId: noteData.noteId,
        sourcePageType,
        reason: result.reason,
        ts: Date.now(),
      });
    }
  }

  // ─── Prompt 构建 ───────────────────────────────────────────

  /** 只读预览（change role-prompt-visibility）：用最小示例数据 + 真实人设渲染真实 prompt，仅供后台查看；不改 buildPrompt 逻辑。 */
  previewPrompt(): string {
    return this.buildPrompt({ noteId: '<示例noteId>', title: '<示例标题>', content: '<示例正文，运行时为真实笔记内容>', author: '<示例作者>', likeCount: 0, collectCount: 0 });
  }

  /** 只读人设来源片段（change prompt-viewer-persona-source）：与 buildPrompt 同源拼接，仅供查看器定位标注；不改 buildPrompt。 */
  personaSegments(): string[] {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');
    return [`你是「${identity.name}」，${identity.role}。\n你的兴趣：${interestsStr}`];
  }

  private buildPrompt(note: NoteData): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');

    return `你是「${identity.name}」，${identity.role}。
你的兴趣：${interestsStr}
你在快速判断：这篇${this.platformProfile.siteName}${this.platformProfile.contentName}**要不要继续看**（不是评内容好坏，只是粗筛）。

${this.platformProfile.contentName}信息：
标题：${note.title}
内容：${note.content}
作者：${note.author ?? '未知'}
${this.platformProfile.metrics.like}：${note.likeCount}${this.platformProfile.metrics.collect ? `，${this.platformProfile.metrics.collect}：${note.collectCount}` : ''}

判断口径（偏挑剔，只放真正相关且有内容的）：
- 只有**话题与你的兴趣明显相关、且${this.platformProfile.contentName}真有信息 / 观点 / 经验**时才 pass。
- 这几类一律 close_note：纯广告/带货导流、通篇空话毫无信息、只蹭热点的标题党、与你的兴趣只是擦边或完全无关、纯情绪宣泄无实质内容。
- **正文为空或很短不等于质量差**：可能是图文/视频${this.platformProfile.contentName}，正文本就少；不要仅因正文短而 close（仍按话题相关度与信息量判断）。
- **拿不准时倾向 close**，宁缺毋滥——把宝贵的互动额度留给真正相关有价值的${this.platformProfile.contentName}。

只输出JSON：{"action":"pass","reason":"简短原因","confidence":0.7}
或（仅明显垃圾）：{"action":"close_note","reason":"简短原因","confidence":0.7}`;
  }

  // ─── 输出解析 ───────────────────────────────────────────────

  private parseOutput(raw: string): CuratorResult | null {
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

    const validActions = new Set(['close_note', 'pass']);
    if (typeof o.action !== 'string' || !validActions.has(o.action)) {
      return null;
    }

    const action = o.action as 'close_note' | 'pass';
    const reason = typeof o.reason === 'string' ? o.reason : 'content_evaluated';

    return { action, reason };
  }
}

// ─── 内部类型 ─────────────────────────────────────────────────

interface CuratorResult {
  action: 'close_note' | 'pass';
  reason: string;
}
