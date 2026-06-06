/**
 * InteractionAppraiser — 互动决策 Agent（LLM）。
 *
 * 职责：
 * - 综合笔记内容与剩余预算，决定 like / collect / pass
 * - 吸收原 EngagementDecider 的职能
 * - 激活条件：pageType 为 note 且 currentNote 存在
 */

import type { AgentRole, AgentDecision } from '../event-bus/types.js';
import type { BlackboardState } from '../blackboard/types.js';
import { BaseAgent } from './types.js';
import type { BaseAgentOptions } from './types.js';

export class InteractionAppraiser extends BaseAgent {
  readonly role: AgentRole = 'interaction_appraiser';

  constructor(options: BaseAgentOptions) {
    super(options);
    if (!options.llm) throw new Error('InteractionAppraiser 需要 LlmClient');
  }

  shouldActivate(board: BlackboardState): boolean {
    return board.pageType === 'note' && board.currentNote !== null;
  }

  async decide(board: BlackboardState): Promise<AgentDecision> {
    // availableActions 过滤：如果 board 中不含 like/collect，直接 pass 不调 LLM
    const hasLike = board.availableActions.includes('like');
    const hasCollect = board.availableActions.includes('collect');
    if (!hasLike && !hasCollect) {
      return this.pass('无可用互动动作');
    }

    const note = board.currentNote!;
    const prompt = this.buildPrompt(board, note);

    try {
      const raw = await this.llm!.complete(prompt);
      return this.parseOutput(raw, hasLike, hasCollect);
    } catch {
      return this.pass('llm_error');
    }
  }

  private buildPrompt(
    board: BlackboardState,
    note: { title: string; summary: string; author?: string; likeCount: number; collectCount: number },
  ): string {
    const { identity, interests, behavior_guidelines: bg } = this.soul;
    const collectionPrinciple = bg?.collection_principle ?? '值得反复参考、可直接落地执行';
    const likePrinciple = bg?.like_principle ?? '学到了新东西或观点受启发';
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');

    const remainingLike = board.riskStatus.remainingActionsToday.like ?? 0;
    const remainingCollect = board.riskStatus.remainingActionsToday.collect ?? 0;

    return `你是「${identity.name}」，${identity.role}。${identity.background}
语气：${identity.tone}

你的兴趣：${interestsStr}
收藏标准：${collectionPrinciple}
点赞标准：${likePrinciple}

当前笔记：
标题：${note.title}
内容：${note.summary}
点赞数：${note.likeCount}，收藏数：${note.collectCount}

剩余预算：like=${remainingLike}，collect=${remainingCollect}

决策逻辑：
- collect：内容值得反复查看、有实操步骤、代码/配置、架构图等可复用知识（更稀有更谨慎）
- like：内容有启发但不需反复参考
- pass：不够格互动

只输出JSON：{"action":"like","reason":"简短原因","confidence":0.8}
或：{"action":"collect","reason":"简短原因","confidence":0.9}
或：{"action":"pass","reason":"简短原因","confidence":0.5}`;
  }

  private parseOutput(raw: string, hasLike: boolean, hasCollect: boolean): AgentDecision {
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

    const validActions = new Set(['like', 'collect', 'pass']);
    if (typeof o.action !== 'string' || !validActions.has(o.action)) {
      return this.pass('invalid_action');
    }

    let action = o.action as 'like' | 'collect' | 'pass';

    // 二次校验：如果模型选了不可用的动作，降级
    if (action === 'like' && !hasLike) action = 'pass';
    if (action === 'collect' && !hasCollect) action = 'pass';

    const reason = typeof o.reason === 'string' ? o.reason : 'interaction_decided';
    const confidence = typeof o.confidence === 'number' ? o.confidence : 0.7;

    return {
      agent: this.role,
      action,
      reason,
      confidence,
      ts: Date.now(),
    };
  }
}
