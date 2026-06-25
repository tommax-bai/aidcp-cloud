/**
 * InteractionAppraiserRole — 互动评估与执行角色（LLM，事件驱动版）。
 *
 * 职责：评估并执行互动（点赞/收藏）。
 * 消费事件：reading.done
 * 产出事件：interaction.completed（执行了互动）或 interaction.skipped（不互动）
 *
 * 与旧版 InteractionAppraiser 的区别：
 * - 输入从黑板模式改为事件驱动
 * - 输出从 AgentDecision 改为 emit 角色事件
 * - actions 字段为数组，支持同时 like+collect
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { SessionContext } from './session-context.js';
import type { NoteData } from './content-curator-role.js';
import type { RoleName, ReadingDonePayload } from '../event-bus/types.js';

export interface InteractionAppraiserRoleOptions extends RoleOptions {
  sessionContext: SessionContext;
  getNoteData: (noteId: string) => NoteData | null;
  getRemainingBudget: () => { likes: number; collects: number };
}

export class InteractionAppraiserRole extends BaseRole {
  readonly roleName: RoleName = 'interaction_appraiser';
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private readonly getRemainingBudget: () => { likes: number; collects: number };
  private unsubscribers: (() => void)[] = [];

  constructor(options: InteractionAppraiserRoleOptions) {
    super(options);
    if (!options.llm) throw new Error('InteractionAppraiserRole 需要 LlmClient');
    this.getNoteData = options.getNoteData;
    this.getRemainingBudget = options.getRemainingBudget;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('reading.done', (p) => this.onReadingDone(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private async onReadingDone(payload: ReadingDonePayload): Promise<void> {
    const budget = this.getRemainingBudget();

    // 无预算可用，直接 skip
    if (budget.likes <= 0 && budget.collects <= 0) {
      this.emit('interaction.skipped', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        reason: 'no_budget',
        ts: Date.now(),
      });
      return;
    }

    const noteData = this.getNoteData(payload.noteId);
    if (!noteData) {
      this.emit('interaction.skipped', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        reason: 'note_data_unavailable',
        ts: Date.now(),
      });
      return;
    }

    const prompt = this.buildPrompt(noteData, budget);
    let raw: string;
    try {
      raw = await this.decide(prompt);
    } catch {
      this.emit('interaction.skipped', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        reason: 'llm_error',
        ts: Date.now(),
      });
      return;
    }

    const result = this.parseOutput(raw, budget);
    if (!result || result.actions.length === 0) {
      this.emit('interaction.skipped', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        reason: result?.reason ?? 'parse_failed',
        ts: Date.now(),
      });
      return;
    }

    this.emit('interaction.completed', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: result.actions,
      ts: Date.now(),
    });
  }

  // ─── Prompt 构建 ───────────────────────────────────────────

  /** 只读预览（change role-prompt-visibility）：用最小示例数据 + 真实人设渲染真实 prompt，仅供后台查看；不改 buildPrompt 逻辑。 */
  previewPrompt(): string {
    return this.buildPrompt({ noteId: '<示例noteId>', title: '<示例标题>', content: '<示例正文，运行时为真实笔记内容>', author: '<示例作者>', likeCount: 0, collectCount: 0 }, { likes: 1, collects: 1 });
  }

  /** 只读人设来源片段（change prompt-viewer-persona-source）：与 buildPrompt 同源拼接，仅供查看器定位标注；不改 buildPrompt。 */
  personaSegments(): string[] {
    const { identity, interests, behavior_guidelines: bg } = this.soul;
    const collectionPrinciple = bg?.collection_principle ?? '只有会反复参考、能直接落地复用的硬核内容才收藏，稀有谨慎';
    const likePrinciple = bg?.like_principle ?? '有共鸣 / 认同 / 觉得有用就点赞，轻量高频';
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');
    return [`你是「${identity.name}」，${identity.role}。${identity.background}\n语气：${identity.tone}\n\n你的兴趣：${interestsStr}\n收藏标准：${collectionPrinciple}\n点赞标准：${likePrinciple}`];
  }

  private buildPrompt(note: NoteData, budget: { likes: number; collects: number }): string {
    const { identity, interests, behavior_guidelines: bg } = this.soul;
    const collectionPrinciple = bg?.collection_principle ?? '只有会反复参考、能直接落地复用的硬核内容才收藏，稀有谨慎';
    const likePrinciple = bg?.like_principle ?? '有共鸣 / 认同 / 觉得有用就点赞，轻量高频';
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');

    return `你是「${identity.name}」，${identity.role}。${identity.background}
语气：${identity.tone}

你的兴趣：${interestsStr}
收藏标准：${collectionPrinciple}
点赞标准：${likePrinciple}

当前笔记：
标题：${note.title}
内容：${note.content}
点赞数：${note.likeCount}，收藏数：${note.collectCount}

剩余预算：like=${budget.likes}，collect=${budget.collects}

决策逻辑（点赞是选择性互动，收藏是更稀有的选择性互动）：
- like：仅在内容**真有共鸣 / 学到具体东西 / 观点让你眼前一亮**时才点；普通的、只是泛泛认同的、刷过即忘的笔记不点
- collect：仅当会反复查看、需落地复用（实操步骤 / 代码配置 / 架构图等硬核可复用知识）才收藏——更稀有、更谨慎
- both：值得收藏的内容几乎也值得点赞，收藏时优先选 both
- pass：不够格互动（多数普通笔记落这里）

只输出JSON：{"action":"like","reason":"简短原因","confidence":0.8}
或：{"action":"collect","reason":"简短原因","confidence":0.9}
或：{"action":"both","reason":"简短原因","confidence":0.9}
或：{"action":"pass","reason":"简短原因","confidence":0.5}`;
  }

  // ─── 输出解析 ───────────────────────────────────────────────

  private parseOutput(raw: string, budget: { likes: number; collects: number }): AppraiserResult | null {
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

    const validActions = new Set(['like', 'collect', 'both', 'pass']);
    if (typeof o.action !== 'string' || !validActions.has(o.action)) {
      return null;
    }

    const reason = typeof o.reason === 'string' ? o.reason : 'interaction_decided';
    const action = o.action as 'like' | 'collect' | 'both' | 'pass';

    // 根据预算过滤可执行的 actions
    const actions: ('like' | 'collect')[] = [];

    if (action === 'like' && budget.likes > 0) {
      actions.push('like');
    } else if (action === 'collect' || action === 'both') {
      // 收藏即点赞：真人收藏几乎都先点赞，且 LLM 实测从不主动选 both（0/40）。
      // 故 collect 与 both 一视同仁——在 like 配额允许下同时点赞，收藏受 collect 配额约束。
      if (budget.likes > 0) actions.push('like');
      if (budget.collects > 0) actions.push('collect');
    }
    // action === 'pass' → actions 为空

    return { actions, reason };
  }
}

// ─── 内部类型 ─────────────────────────────────────────────────

interface AppraiserResult {
  actions: ('like' | 'collect')[];
  reason: string;
}
