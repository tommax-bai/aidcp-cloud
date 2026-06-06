/**
 * FeedScanner — 信息流筛选 Agent（LLM）。
 *
 * 职责：
 * - 列表页/搜索页场景下，基于 Soul 兴趣从可见卡片中选择值得打开的内容
 * - 激活条件：pageType 为 feed 或 search
 */

import type { AgentRole, AgentDecision } from '../event-bus/types.js';
import type { BlackboardState } from '../blackboard/types.js';
import { BaseAgent } from './types.js';
import type { BaseAgentOptions } from './types.js';

export class FeedScanner extends BaseAgent {
  readonly role: AgentRole = 'feed_scanner';

  constructor(options: BaseAgentOptions) {
    super(options);
    if (!options.llm) throw new Error('FeedScanner 需要 LlmClient');
  }

  shouldActivate(board: BlackboardState): boolean {
    return board.pageType === 'feed' || board.pageType === 'search';
  }

  async decide(board: BlackboardState): Promise<AgentDecision> {
    const prompt = this.buildPrompt(board);

    try {
      const raw = await this.llm!.complete(prompt);
      return this.parseOutput(raw);
    } catch {
      return this.pass('llm_error');
    }
  }

  private buildPrompt(board: BlackboardState): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');

    // 从 conceptPool 的 known 中获取可见卡片信息作为参照
    // 实际卡片数据在 currentNote 未被设定时从 board 上下文推断
    const pageType = board.pageType;

    return `你是「${identity.name}」，${identity.role}。兴趣：${interestsStr}。
当前在小红书列表页（${pageType}），你需要从可见卡片中选择值得打开的内容。

概念池关键词：${board.conceptPool.known.slice(0, 10).join('、')}

筛选策略：
- 优先选择与 AI/LLM/技术相关的标题
- 互动数据太差的（点赞=0 且无收藏）考虑跳过
- 你只能选择：open_note(传params.index) 或 scroll

只输出JSON：{"action":"open_note","params":{"index":0},"reason":"简短原因","confidence":0.8}
或：{"action":"scroll","reason":"简短原因","confidence":0.5}`;
  }

  private parseOutput(raw: string): AgentDecision {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return this.pass('parse_failed');

    let obj: unknown;
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return this.pass('json_parse_error');
    }

    if (!obj || typeof obj !== 'object') return this.pass('invalid_output');
    const o = obj as Record<string, unknown>;

    const validActions = new Set(['open_note', 'scroll']);
    if (typeof o.action !== 'string' || !validActions.has(o.action)) {
      return this.pass('invalid_action');
    }

    const action = o.action as 'open_note' | 'scroll';
    const params = o.params && typeof o.params === 'object' && !Array.isArray(o.params)
      ? o.params as Record<string, unknown>
      : undefined;
    const reason = typeof o.reason === 'string' ? o.reason : 'feed_selected';
    const confidence = typeof o.confidence === 'number' ? o.confidence : 0.7;

    return {
      agent: this.role,
      action,
      params,
      reason,
      confidence,
      ts: Date.now(),
    };
  }
}
