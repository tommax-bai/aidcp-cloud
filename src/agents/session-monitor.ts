/**
 * SessionMonitor — 会话健康度监控 Agent（纯规则引擎，无 LLM）。
 *
 * 职责：
 * - 每轮必激活，检查会话时长与互动配额
 * - 超限 → veto end_session；冷启动 → gate 阻断互动Agent
 */

import type { AgentRole, AgentDecision } from '../event-bus/types.js';
import type { BlackboardState } from '../blackboard/types.js';
import { BaseAgent } from './types.js';
import type { BaseAgentOptions } from './types.js';

export class SessionMonitor extends BaseAgent {
  readonly role: AgentRole = 'session_monitor';

  constructor(options: BaseAgentOptions) {
    super(options);
  }

  /** 每轮必激活 */
  shouldActivate(_board: BlackboardState): boolean {
    return true;
  }

  async decide(board: BlackboardState): Promise<AgentDecision> {
    const { sessionStats, riskStatus } = board;
    const limits = this.soul.session_limits;

    const maxDurationMs = (limits?.max_duration_min ?? 10) * 60_000;
    const maxLikes = limits?.max_likes ?? 8;
    const maxCollects = limits?.max_collects ?? 5;
    const maxSearches = limits?.max_searches ?? 3;

    // 时长超限
    if (sessionStats.durationMs >= maxDurationMs) {
      return {
        agent: this.role,
        action: 'end_session',
        reason: `会话时长 ${(sessionStats.durationMs / 60_000).toFixed(1)}min 已超限`,
        confidence: 1,
        veto: true,
        ts: Date.now(),
      };
    }

    // 互动配额检查
    const likesRemaining = riskStatus.remainingActionsToday.like ?? maxLikes;
    const collectsRemaining = riskStatus.remainingActionsToday.collect ?? maxCollects;
    const searchesRemaining = riskStatus.remainingActionsToday.search ?? maxSearches;

    if (likesRemaining <= 0 && collectsRemaining <= 0 && searchesRemaining <= 0) {
      return {
        agent: this.role,
        action: 'end_session',
        reason: '所有互动配额已耗尽',
        confidence: 1,
        veto: true,
        ts: Date.now(),
      };
    }

    // 冷启动检测：views < 5 时阻断互动
    if (sessionStats.views < 5) {
      return {
        agent: this.role,
        action: 'pass',
        reason: '冷启动阶段禁止互动',
        confidence: 0.5,
        gate: { blocks: ['interaction_appraiser'] },
        ts: Date.now(),
      };
    }

    return this.pass('会话状态正常');
  }
}
