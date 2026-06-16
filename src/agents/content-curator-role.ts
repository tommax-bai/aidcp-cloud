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

export interface NoteData {
  noteId: string;
  title: string;
  content: string;
  author?: string;
  likeCount: number;
  collectCount: number;
}

export interface ContentCuratorRoleOptions extends RoleOptions {
  sessionContext: SessionContext;
}

export class ContentCuratorRole extends BaseRole {
  readonly roleName: RoleName = 'content_curator';
  private readonly sessionContext: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: ContentCuratorRoleOptions) {
    super(options);
    if (!options.llm) throw new Error('ContentCuratorRole 需要 LlmClient');
    this.sessionContext = options.sessionContext;
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

  private buildPrompt(note: NoteData): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');

    return `你是「${identity.name}」，${identity.role}。
你的兴趣：${interestsStr}
你在快速判断：这篇小红书笔记**要不要继续看**（不是评内容好坏，只是粗筛）。

笔记信息：
标题：${note.title}
内容：${note.content}
作者：${note.author ?? '未知'}
点赞：${note.likeCount}，收藏：${note.collectCount}

判断口径（宽松，默认继续看）：
- **大多数正常笔记都 pass**——只要话题沾边你的兴趣、或是正常的经验/资讯/观点分享。
- 只有**明显**是这几类才 close_note：纯广告/带货导流、通篇空话毫无信息、与兴趣完全无关的标题党。
- **正文为空或很短不等于质量差**：可能是图文/视频笔记，正文本就少；不要因此 close。
- **拿不准时一律 pass**，把互动与否交给后续角色判断。

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
