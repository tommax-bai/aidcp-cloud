/**
 * 黑板（Blackboard） — Agent 间的共享状态容器。
 * Orchestrator 写入输入区 → Agent 读取并写回决策 → 仲裁器产出最终命令。
 */

import type { EventBus } from '../event-bus/index.js';
import type {
  AgentRole,
  AgentDecision,
  ManagerDecision,
  IncomingNote,
  PageType,
  SessionStats,
  RiskStatus,
  LoginState,
  ConceptPool,
  ManagerActionName,
} from '../event-bus/types.js';
import type { BlackboardState, BlackboardOptions } from './types.js';

export type { BlackboardState, BlackboardOptions } from './types.js';
export type {
  AgentRole,
  AgentDecision,
  ManagerDecision,
  IncomingNote,
  PageType,
  SessionStats,
  RiskStatus,
  LoginState,
  ConceptPool,
  ManagerActionName,
} from '../event-bus/types.js';

function createDefaultState(): BlackboardState {
  return {
    currentNote: null,
    pageType: 'unknown',
    sessionStats: {
      startedAt: 0,
      durationMs: 0,
      views: 0,
      likes: 0,
      collects: 0,
      searches: 0,
      follows: 0,
    },
    riskStatus: {
      status: 'normal',
      quotaLevel: 'normal',
      remainingActionsToday: {},
      viewOnly: false,
    },
    loginState: 'unknown',
    conceptPool: {
      known: [],
      candidates: [],
      source: new Map(),
    },
    availableActions: [],
    decisions: new Map(),
    finalCommand: null,
  };
}

export class Blackboard {
  private state: BlackboardState;
  private expectedAgents: Set<AgentRole> = new Set();
  private eventBus?: EventBus;

  constructor(options?: BlackboardOptions) {
    this.state = createDefaultState();
    this.eventBus = options?.eventBus;
  }

  /** 读取当前状态快照（直接引用，调用方应避免外部修改）。 */
  getState(): Readonly<BlackboardState> {
    return this.state;
  }

  /** 写入输入区（Orchestrator 调用）。 */
  setInput(input: {
    currentNote?: IncomingNote | null;
    pageType?: PageType;
    sessionStats?: SessionStats;
    riskStatus?: RiskStatus;
    loginState?: LoginState;
    conceptPool?: ConceptPool;
    availableActions?: ManagerActionName[];
  }): void {
    if (input.currentNote !== undefined) this.state.currentNote = input.currentNote;
    if (input.pageType !== undefined) this.state.pageType = input.pageType;
    if (input.sessionStats !== undefined) this.state.sessionStats = input.sessionStats;
    if (input.riskStatus !== undefined) this.state.riskStatus = input.riskStatus;
    if (input.loginState !== undefined) this.state.loginState = input.loginState;
    if (input.conceptPool !== undefined) this.state.conceptPool = input.conceptPool;
    if (input.availableActions !== undefined) this.state.availableActions = input.availableActions;

    this.eventBus?.emit('blackboard.updated', { field: 'input' });
  }

  /** 设置本轮预期的 Agent 列表。 */
  setExpectedAgents(agents: AgentRole[]): void {
    this.expectedAgents = new Set(agents);
  }

  /** Agent 写入决策。 */
  writeDecision(decision: AgentDecision): void {
    this.state.decisions.set(decision.agent, decision);
    this.eventBus?.emit('agent.decided', { agent: decision.agent, decision });

    if (this.isRoundComplete()) {
      this.eventBus?.emit('round.complete', { decisions: this.state.decisions });
    }
  }

  /** 检查本轮是否所有预期 Agent 都已决策。 */
  isRoundComplete(): boolean {
    if (this.expectedAgents.size === 0) return false;
    for (const agent of this.expectedAgents) {
      if (!this.state.decisions.has(agent)) return false;
    }
    return true;
  }

  /** 仲裁器写入最终命令。 */
  setFinalCommand(command: ManagerDecision): void {
    this.state.finalCommand = command;
    this.eventBus?.emit('blackboard.updated', { field: 'finalCommand' });
  }

  /** 每轮开始时重置决策区。 */
  reset(): void {
    this.state.decisions = new Map();
    this.state.finalCommand = null;
  }
}
