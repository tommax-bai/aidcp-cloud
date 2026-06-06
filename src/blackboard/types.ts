/**
 * 黑板类型定义 — 共享状态结构，供 Agent 读取上下文、写入决策。
 */

import type {
  AgentRole,
  AgentDecision,
  IncomingNote,
  PageType,
  SessionStats,
  RiskStatus,
  LoginState,
  ConceptPool,
  ManagerActionName,
  ManagerDecision,
} from '../event-bus/types.js';

export interface BlackboardState {
  // 输入区（Orchestrator 写入）
  currentNote: IncomingNote | null;
  pageType: PageType;
  sessionStats: SessionStats;
  riskStatus: RiskStatus;
  loginState: LoginState;
  conceptPool: ConceptPool;
  availableActions: ManagerActionName[];

  // Agent 决策区
  decisions: Map<AgentRole, AgentDecision>;

  // 输出区（仲裁器写入）
  finalCommand: ManagerDecision | null;
}

export interface BlackboardOptions {
  eventBus?: import('../event-bus/index.js').EventBus;
}
