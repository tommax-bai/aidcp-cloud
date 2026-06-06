/**
 * CommentReviewer — 评论区质量审查 Agent（LLM）。
 *
 * 职责：
 * - 分析笔记评论区 top 评论，判断评论质量
 * - 负面/spam 评论 → downgrade（降低笔记评分）
 * - 有价值补充 → boost（提升笔记评分）
 * - 产出 comment.adjustment 事件辅助 InteractionAppraiser 决策
 *
 * 消费事件：note.comments + session.verdict
 * 产出事件：comment.adjustment
 */

import type { LlmClient } from '../../llm/qwen.js';
import type {
  EventStream,
  NoteCommentsPayload,
  CommentAdjustmentPayload,
  SessionVerdictPayload,
} from '../events.js';
import { EVENT_TYPES } from '../events.js';
import type { Soul } from '../../soul/types.js';
import type { RoleAgent } from './base-agent.js';

export class CommentReviewer implements RoleAgent {
  readonly name = 'CommentReviewer';

  constructor(private readonly llm: LlmClient) {}

  async process(stream: EventStream, soul: Soul): Promise<void> {
    // 幂等
    if (stream.has(EVENT_TYPES.COMMENT_ADJUSTMENT)) return;

    // 若无 note.comments 事件则 return（无评论数据）
    const commentsEvent = stream.find<NoteCommentsPayload>(EVENT_TYPES.NOTE_COMMENTS);
    if (!commentsEvent) return;

    // 检查 session.verdict
    const verdictEvent = stream.find<SessionVerdictPayload>(EVENT_TYPES.SESSION_VERDICT);
    if (!verdictEvent) return; // 等下一轮
    if (!verdictEvent.payload.allow) return; // 自主跳过

    const { comments } = commentsEvent.payload;
    if (comments.length === 0) return;

    const prompt = this.buildPrompt(soul, comments);

    try {
      const raw = await this.llm.complete(prompt);
      const adjustment = this.parseOutput(raw);

      stream.emit({
        type: EVENT_TYPES.COMMENT_ADJUSTMENT,
        source: this.name,
        timestamp: Date.now(),
        payload: adjustment,
      });
    } catch {
      // LLM 失败不阻塞
    }
  }

  private buildPrompt(soul: Soul, comments: string[]): string {
    const { identity } = soul;
    const topComments = comments.slice(0, 5);
    const commentList = topComments.map((c, i) => `[${i + 1}] ${c}`).join('\n');

    return `你是「${identity.name}」，${identity.role}。
你正在浏览一篇笔记的评论区，请判断评论整体质量对笔记价值的影响。

Top 评论：
${commentList}

判断标准：
- boost=true：评论中有有价值的补充信息（如真实使用反馈、额外资源链接、纠错等）
- downgrade=true：评论大多负面（吐槽内容虚假、指出错误）或充满 spam/广告
- 两者都为 false：评论区正常，不影响判断
- 两者不会同时为 true

只输出一个 JSON 对象，不要任何解释或 markdown 代码块：
{"boost": true/false, "downgrade": true/false, "reason": "简短理由"}`;
  }

  private parseOutput(raw: string): CommentAdjustmentPayload {
    const fallback: CommentAdjustmentPayload = { boost: false, downgrade: false, reason: 'parse_fallback' };
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

    return {
      boost: typeof o.boost === 'boolean' ? o.boost : false,
      downgrade: typeof o.downgrade === 'boolean' ? o.downgrade : false,
      reason: typeof o.reason === 'string' ? o.reason : 'comments_reviewed',
    };
  }
}
