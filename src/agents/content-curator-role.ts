/**
 * ContentCuratorRole — 详情页内容质量粗筛角色（LLM，事件驱动版）。
 *
 * 职责：评估笔记内容质量，判断是否值得深度阅读。
 * 消费事件：note.entered
 * 产出事件：quality.pass（质量好）或 quality.reject（质量差）
 *
 * 与旧版 ContentCurator 的区别：
 * - 输入从黑板模式改为事件驱动
 * - 输出从 AgentDecision 改为 emit 角色事件
 * - 通过 getNoteData 函数获取笔记数据
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { SessionContext } from './session-context.js';
import type { RoleName, NoteEnteredPayload } from '../event-bus/types.js';

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
  getNoteData: (noteId: string) => NoteData | null;
}

export class ContentCuratorRole extends BaseRole {
  readonly roleName: RoleName = 'content_curator';
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private unsubscribers: (() => void)[] = [];

  constructor(options: ContentCuratorRoleOptions) {
    super(options);
    if (!options.llm) throw new Error('ContentCuratorRole 需要 LlmClient');
    this.getNoteData = options.getNoteData;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('note.entered', (p) => this.onNoteEntered(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private async onNoteEntered(payload: NoteEnteredPayload): Promise<void> {
    const noteData = this.getNoteData(payload.noteId);
    if (!noteData) {
      // 无法获取笔记数据，直接 reject
      this.emit('quality.reject', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        reason: 'note_data_unavailable',
        ts: Date.now(),
      });
      return;
    }

    const prompt = this.buildPrompt(noteData);
    let raw: string;
    try {
      raw = await this.llm!.complete(prompt);
    } catch {
      this.emit('quality.reject', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        reason: 'llm_error',
        ts: Date.now(),
      });
      return;
    }

    const result = this.parseOutput(raw);
    if (!result) {
      this.emit('quality.reject', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        reason: 'parse_failed',
        ts: Date.now(),
      });
      return;
    }

    if (result.action === 'pass') {
      this.emit('quality.pass', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        reason: result.reason,
        ts: Date.now(),
      });
    } else {
      this.emit('quality.reject', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
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
你正在评估一篇小红书笔记的内容质量。

笔记信息：
标题：${note.title}
内容：${note.content}
作者：${note.author ?? '未知'}
点赞：${note.likeCount}，收藏：${note.collectCount}

评估维度：
- 内容是否有具体细节、真实案例、数据支撑
- 作者是否原创（有真实经验、非广告）
- 是否空洞、标题党、广告

如果质量差，输出 close_note；质量好，输出 pass（让后续角色决定互动）。
只输出JSON：{"action":"close_note","reason":"简短原因","confidence":0.8}
或：{"action":"pass","reason":"简短原因","confidence":0.8}`;
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
