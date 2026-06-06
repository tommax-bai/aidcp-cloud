/**
 * AgentOrchestrator：事件驱动的多 Agent 编排器。
 *
 * 不硬编码执行顺序——循环触发所有已注册的 RoleAgent，
 * 每轮并发执行（Promise.all），直到一轮下来无新事件产出（事件流稳定）。
 * 最终从事件流中 harvest 出 ManagerDecision。
 */

import type { RoleAgent } from './agents/base-agent.js';
import type { Soul } from '../soul/types.js';
import {
  EventStream,
  EVENT_TYPES,
  type SessionVerdictPayload,
  type InteractionDecisionPayload,
  type FeedDecisionPayload,
} from './events.js';
import type { ManagerDecision } from './manager-agent.js';

export interface AgentOrchestratorOptions {
  agents: RoleAgent[];
  /** 最大循环轮次（防无限循环），默认 5 */
  maxRounds?: number;
}

/** 本地 fallback，避免从 manager-agent 运行时导入造成循环依赖 */
function localFallback(): ManagerDecision {
  return { action: 'browse_next', reason: 'manager_fallback' };
}

export class AgentOrchestrator {
  private readonly agents: RoleAgent[];
  private readonly maxRounds: number;

  constructor(options: AgentOrchestratorOptions) {
    this.agents = options.agents;
    this.maxRounds = options.maxRounds ?? 5;
  }

  /**
   * 执行一次完整决策：循环触发 Agent 直到稳定，然后 harvest。
   */
  async decide(stream: EventStream, soul: Soul): Promise<ManagerDecision> {
    for (let round = 0; round < this.maxRounds; round++) {
      const before = stream.size;
      // 所有 Agent 并发处理
      await Promise.all(this.agents.map(a => a.process(stream, soul)));
      // 无新事件 → 稳定
      if (stream.size === before) break;
    }
    return this.harvest(stream);
  }

  /**
   * 从事件流中收割最终决策。
   * 优先级：session deny > interaction.decision > feed.decision > fallback
   */
  private harvest(stream: EventStream): ManagerDecision {
    const verdict = stream.find<SessionVerdictPayload>(EVENT_TYPES.SESSION_VERDICT);
    if (verdict && !verdict.payload.allow) {
      return {
        action: 'end_session',
        reason: `[SessionMonitor] ${verdict.payload.warnings.join('; ')}`,
      };
    }

    const interaction = stream.find<InteractionDecisionPayload>(EVENT_TYPES.INTERACTION_DECISION);
    if (interaction) {
      return {
        action: interaction.payload.action === 'close_note' ? 'close_note' : interaction.payload.action,
        reason: interaction.payload.reason,
      };
    }

    const feed = stream.find<FeedDecisionPayload>(EVENT_TYPES.FEED_DECISION);
    if (feed) {
      return {
        action: feed.payload.action === 'open_note' ? 'open_note' : feed.payload.action === 'scroll' ? 'scroll' : 'browse_next',
        params: feed.payload.params,
        reason: feed.payload.reason,
      };
    }

    return localFallback();
  }
}
