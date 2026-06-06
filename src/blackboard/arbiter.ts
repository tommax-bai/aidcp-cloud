/**
 * 仲裁器（Arbiter） — 纯逻辑（无 LLM），合并所有 Agent 决策为最终命令。
 *
 * 优先级规则：
 * 1. veto 否决 → 直接采纳
 * 2. gate 门控 → 忽略被阻断 Agent
 * 3. 导航 + 互动合并
 * 4. 全 pass → fallback browse_next
 */

import type { AgentRole, AgentDecision, ManagerDecision, ManagerActionName } from '../event-bus/types.js';
import type { BlackboardState } from './types.js';

/** Veto 优先级：索引越小优先级越高 */
const VETO_PRIORITY: AgentRole[] = [
  'session_monitor',
  'content_curator',
  'interaction_appraiser',
  'feed_scanner',
  'comment_reviewer',
];

/** 导航类动作集合 */
const NAVIGATION_ACTIONS: Set<ManagerActionName> = new Set([
  'browse_next',
  'scroll',
  'open_note',
  'close_note',
  'search',
  'end_session',
]);

/** 互动类动作集合 */
const INTERACTION_ACTIONS: Set<ManagerActionName> = new Set([
  'like',
  'collect',
]);

/** 关闭/结束动作 — 发生时忽略互动 */
const TERMINAL_ACTIONS: Set<ManagerActionName> = new Set([
  'close_note',
  'end_session',
]);

export class Arbiter {
  /**
   * 从黑板状态中读取所有 Agent 决策，合并为最终命令。
   */
  arbitrate(board: BlackboardState): ManagerDecision {
    const decisions = board.decisions;

    // ── 规则 1：Veto 否决（最高优先级） ──────────────────────────────
    const vetoDecision = this.resolveVeto(decisions);
    if (vetoDecision) return vetoDecision;

    // ── 规则 2：Gate 门控 — 收集被阻断的 Agent ─────────────────────
    const blocked = this.collectBlockedAgents(decisions);

    // ── 过滤有效决策（非 pass、未被 gate 阻断） ──────────────────────
    const effective: AgentDecision[] = [];
    for (const [role, d] of decisions) {
      if (blocked.has(role)) continue;       // 被 gate 阻断 → 忽略
      if (d.action === 'pass') continue;     // 无意见 → 忽略
      effective.push(d);
    }

    // ── 规则 4：全 Pass Fallback ─────────────────────────────────────
    if (effective.length === 0) {
      return { action: 'browse_next', reason: 'all_agents_pass' };
    }

    // ── 规则 3：分类合并 ─────────────────────────────────────────────
    return this.mergeDecisions(effective);
  }

  // ─── 内部方法 ──────────────────────────────────────────────────────

  /**
   * 规则 1：检查 veto 否决。
   * 如有多个 veto，按固定优先级选取。
   */
  private resolveVeto(decisions: Map<AgentRole, AgentDecision>): ManagerDecision | null {
    const vetoes: AgentDecision[] = [];
    for (const d of decisions.values()) {
      if (d.veto && d.action !== 'pass') {
        vetoes.push(d);
      }
    }
    if (vetoes.length === 0) return null;

    // 按 VETO_PRIORITY 排序（索引越小优先级越高）
    vetoes.sort((a, b) => {
      const ia = VETO_PRIORITY.indexOf(a.agent);
      const ib = VETO_PRIORITY.indexOf(b.agent);
      return ia - ib;
    });

    const winner = vetoes[0];
    return {
      action: winner.action as ManagerActionName,
      params: winner.params,
      reason: `[${winner.agent}] ${winner.reason}`,
    };
  }

  /**
   * 规则 2：收集所有被 gate 阻断的 Agent 角色。
   */
  private collectBlockedAgents(decisions: Map<AgentRole, AgentDecision>): Set<AgentRole> {
    const blocked = new Set<AgentRole>();
    for (const d of decisions.values()) {
      if (d.gate?.blocks) {
        for (const role of d.gate.blocks) {
          blocked.add(role);
        }
      }
    }
    return blocked;
  }

  /**
   * 规则 3：导航 + 互动分类合并。
   */
  private mergeDecisions(effective: AgentDecision[]): ManagerDecision {
    const navDecisions: AgentDecision[] = [];
    const interDecisions: AgentDecision[] = [];

    for (const d of effective) {
      const action = d.action as ManagerActionName;
      if (NAVIGATION_ACTIONS.has(action)) {
        navDecisions.push(d);
      } else if (INTERACTION_ACTIONS.has(action)) {
        interDecisions.push(d);
      }
    }

    // 导航动作：选取 confidence 最高的
    let primaryNav: AgentDecision | null = null;
    if (navDecisions.length > 0) {
      primaryNav = navDecisions.reduce((best, cur) =>
        cur.confidence > best.confidence ? cur : best
      );
    }

    // 互动动作：取第一个（like/collect）
    const interaction = interDecisions.length > 0
      ? (interDecisions[0].action as 'like' | 'collect')
      : undefined;

    // ── 合并逻辑 ──────────────────────────────────────────────────

    // 情况 A：有导航动作
    if (primaryNav) {
      const navAction = primaryNav.action as ManagerActionName;
      const result: ManagerDecision = {
        action: navAction,
        params: primaryNav.params,
        reason: `[${primaryNav.agent}] ${primaryNav.reason}`,
      };

      // 如果导航是 close_note / end_session → 不附加互动
      if (!TERMINAL_ACTIONS.has(navAction) && interaction) {
        result.interaction = interaction;
      }

      return result;
    }

    // 情况 B：只有互动没有导航 → 主命令为 browse_next，互动作为附加
    return {
      action: 'browse_next',
      reason: `[${interDecisions[0].agent}] ${interDecisions[0].reason}`,
      interaction,
    };
  }
}
