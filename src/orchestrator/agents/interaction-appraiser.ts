/**
 * InteractionAppraiser — 互动决策 Agent（LLM）。
 *
 * 职责：
 * - 综合内容质量、评论调整、会话配额，最终决定对笔记的互动行为
 * - 产出 interaction.decision 事件
 *
 * 消费事件：content.verdict + comment.adjustment(可选) + session.verdict + note.content
 * 产出事件：interaction.decision
 */

import type { LlmClient } from '../../llm/qwen.js';
import type {
  EventStream,
  ContentVerdictPayload,
  CommentAdjustmentPayload,
  SessionVerdictPayload,
  NoteContentPayload,
  InteractionDecisionPayload,
} from '../events.js';
import { EVENT_TYPES } from '../events.js';
import type { Soul } from '../../soul/types.js';
import type { RoleAgent } from './base-agent.js';

const VALID_ACTIONS = new Set(['like', 'collect', 'close_note']);

export class InteractionAppraiser implements RoleAgent {
  readonly name = 'InteractionAppraiser';

  constructor(private readonly llm: LlmClient) {}

  async process(stream: EventStream, soul: Soul): Promise<void> {
    // 幂等
    if (stream.has(EVENT_TYPES.INTERACTION_DECISION)) return;

    // 若无 content.verdict 事件则 return（等 ContentCurator 完成）
    const contentVerdictEvent = stream.find<ContentVerdictPayload>(EVENT_TYPES.CONTENT_VERDICT);
    if (!contentVerdictEvent) return;

    // 检查 session.verdict
    const verdictEvent = stream.find<SessionVerdictPayload>(EVENT_TYPES.SESSION_VERDICT);
    if (verdictEvent && !verdictEvent.payload.allow) return;

    const contentVerdict = contentVerdictEvent.payload;

    // 若质量低 → 直接 close_note，不调 LLM
    if (contentVerdict.quality === 'low') {
      stream.emit({
        type: EVENT_TYPES.INTERACTION_DECISION,
        source: this.name,
        timestamp: Date.now(),
        payload: { action: 'close_note', reason: `low_quality: ${contentVerdict.reason}` },
      });
      return;
    }

    // 读取 session.verdict 中的 warnings
    const warnings = verdictEvent?.payload.warnings ?? [];
    const isColdStart = warnings.some(w => w.includes('cold_start'));

    // 冷启动阶段只能 close_note
    if (isColdStart) {
      stream.emit({
        type: EVENT_TYPES.INTERACTION_DECISION,
        source: this.name,
        timestamp: Date.now(),
        payload: { action: 'close_note', reason: 'cold_start: interaction disabled' },
      });
      return;
    }

    // 读取 comment.adjustment（可选）
    const commentEvent = stream.find<CommentAdjustmentPayload>(EVENT_TYPES.COMMENT_ADJUSTMENT);
    const commentAdjustment = commentEvent?.payload;

    // 读取 note.content 获取笔记详情
    const noteEvent = stream.find<NoteContentPayload>(EVENT_TYPES.NOTE_CONTENT);
    const note = noteEvent?.payload.note;

    const prompt = this.buildPrompt(soul, contentVerdict, commentAdjustment, warnings, note);

    try {
      const raw = await this.llm.complete(prompt);
      const decision = this.parseOutput(raw);

      stream.emit({
        type: EVENT_TYPES.INTERACTION_DECISION,
        source: this.name,
        timestamp: Date.now(),
        payload: decision,
      });
    } catch {
      // LLM 失败不阻塞
    }
  }

  private buildPrompt(
    soul: Soul,
    contentVerdict: ContentVerdictPayload,
    commentAdjustment: CommentAdjustmentPayload | undefined,
    warnings: string[],
    note: NoteContentPayload['note'] | undefined,
  ): string {
    const { identity, interests, behavior_guidelines: bg } = soul;
    const collectionPrinciple = bg?.collection_principle ?? '值得反复参考、可直接落地执行';
    const likePrinciple = bg?.like_principle ?? '学到了新东西或观点受启发';

    const noteInfo = note
      ? `标题：${note.title}\n作者：${note.author}\n内容摘要：${note.content.slice(0, 400)}`
      : '（笔记详情不可用）';

    const commentInfo = commentAdjustment
      ? `评论区评估：boost=${commentAdjustment.boost}, downgrade=${commentAdjustment.downgrade}, 原因：${commentAdjustment.reason}`
      : '评论区：无评论数据';

    const warningStr = warnings.length > 0 ? `当前警告：${warnings.join('; ')}` : '无特殊警告';

    return `你是「${identity.name}」，${identity.role}。${identity.background}
你的兴趣：${[...interests.primary, ...interests.secondary].join('、')}

互动标准：
- collect（收藏）：${collectionPrinciple}。内容值得反复查看、有实操步骤、代码/配置、架构图等可复用知识。collect 比 like 更稀有更谨慎。
- like（点赞）：${likePrinciple}。内容有启发但不需反复参考。
- close_note（跳过）：内容对你无用或已互动过。

当前笔记：
${noteInfo}

内容质量评估：quality=${contentVerdict.quality}, 理由：${contentVerdict.reason}
${commentInfo}
${warningStr}

请基于以上信息，决定对这篇笔记的互动行为。
只输出一个 JSON 对象，不要任何解释或 markdown 代码块：
{"action": "like|collect|close_note", "reason": "简短理由"}`;
  }

  private parseOutput(raw: string): InteractionDecisionPayload {
    const fallback: InteractionDecisionPayload = { action: 'close_note', reason: 'parse_fallback' };
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return fallback;

    let obj: unknown;
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return fallback;
    }

    if (!obj || typeof obj !== 'object') return fallback;
    const o = obj as Record<string, unknown>;
    if (typeof o.action !== 'string' || !VALID_ACTIONS.has(o.action)) return fallback;

    return {
      action: o.action as InteractionDecisionPayload['action'],
      reason: typeof o.reason === 'string' ? o.reason : 'interaction_decided',
    };
  }
}
