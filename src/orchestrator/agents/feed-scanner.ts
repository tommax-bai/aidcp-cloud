/**
 * FeedScanner — 信息流筛选 Agent（LLM）。
 *
 * 职责：
 * - 从可见卡片列表中，基于 Soul 兴趣筛选值得打开的笔记
 * - 产出 feed.decision 事件
 *
 * 消费事件：feed.cards + session.verdict
 * 产出事件：feed.decision
 */

import type { LlmClient } from '../../llm/qwen.js';
import type {
  EventStream,
  FeedCardsPayload,
  FeedDecisionPayload,
  SessionVerdictPayload,
} from '../events.js';
import { EVENT_TYPES } from '../events.js';
import type { Soul } from '../../soul/types.js';
import type { RoleAgent } from './base-agent.js';

const VALID_ACTIONS = new Set(['open_note', 'scroll', 'browse_next']);

export class FeedScanner implements RoleAgent {
  readonly name = 'FeedScanner';

  constructor(private readonly llm: LlmClient) {}

  async process(stream: EventStream, soul: Soul): Promise<void> {
    // 幂等
    if (stream.has(EVENT_TYPES.FEED_DECISION)) return;

    // 若无 feed.cards 事件则 return（不是列表页）
    const cardsEvent = stream.find<FeedCardsPayload>(EVENT_TYPES.FEED_CARDS);
    if (!cardsEvent) return;

    // 检查 session.verdict
    const verdictEvent = stream.find<SessionVerdictPayload>(EVENT_TYPES.SESSION_VERDICT);
    if (!verdictEvent) return; // 等下一轮
    if (!verdictEvent.payload.allow) return; // 自主跳过

    const cards = cardsEvent.payload.cards;
    const prompt = this.buildPrompt(soul, cards);

    try {
      const raw = await this.llm.complete(prompt);
      const decision = this.parseOutput(raw);

      stream.emit({
        type: EVENT_TYPES.FEED_DECISION,
        source: this.name,
        timestamp: Date.now(),
        payload: decision,
      });
    } catch {
      // LLM 失败不阻塞
    }
  }

  private buildPrompt(soul: Soul, cards: FeedCardsPayload['cards']): string {
    const { identity, interests } = soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');
    const cardList = cards
      .map((c, i) => `[${i}] title="${c.title ?? '无标题'}" author="${c.author ?? '未知'}" likes=${c.likeCount ?? 0}`)
      .join('\n');

    return `你是「${identity.name}」，${identity.role}。${identity.background}
你的兴趣：${interestsStr}

当前信息流中可见的卡片：
${cardList}

请基于你的兴趣和人设，从中选择一个动作：
- open_note：打开某张卡片深入阅读（附 index）
- scroll：当前可见卡片都不感兴趣，下滑看更多
- browse_next：换一批卡片

选择标准：
- 优先选择与你兴趣（AI/LLM/技术）相关的标题
- 互动数据太差的（likes=0）可以跳过
- 若所有卡片都不感兴趣则 scroll

只输出一个 JSON 对象，不要任何解释或 markdown 代码块：
{"action": "open_note|scroll|browse_next", "params": {"index": 0}, "reason": "简短理由"}
注意：open_note 时 params.index 是卡片的 0-based 序号。`;
  }

  private parseOutput(raw: string): FeedDecisionPayload {
    const fallback: FeedDecisionPayload = { action: 'browse_next', reason: 'parse_fallback' };
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

    const action = o.action as FeedDecisionPayload['action'];
    const params = o.params && typeof o.params === 'object' && !Array.isArray(o.params)
      ? o.params as Record<string, unknown>
      : undefined;
    const reason = typeof o.reason === 'string' ? o.reason : 'feed_selected';

    return { action, params, reason };
  }
}
