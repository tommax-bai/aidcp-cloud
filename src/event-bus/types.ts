/**
 * 事件总线类型定义 — 定义系统内所有事件的结构与相关领域类型。
 */

import type { Envelope } from '../comm/protocol.js';

// Agent 角色枚举
export type AgentRole = 'session_monitor' | 'feed_scanner' | 'content_curator' | 'interaction_appraiser' | 'comment_reviewer';

// 页面类型
export type PageType = 'feed' | 'note' | 'search' | 'profile' | 'unknown';
export type LoginState = 'logged_in' | 'logged_out' | 'unknown';

// 动作名
export type ManagerActionName =
  | 'browse_next'
  | 'scroll'
  | 'like'
  | 'collect'
  | 'search'
  | 'open_note'
  | 'close_note'
  | 'end_session';

// Agent 决策结构
export interface AgentDecision {
  agent: AgentRole;
  action: ManagerActionName | 'pass';  // 'pass' = 无意见
  params?: Record<string, unknown>;
  reason: string;
  confidence: number;         // 0-1
  veto?: boolean;             // true = 否决其他所有决策
  gate?: { blocks: AgentRole[] };  // 质量门控：阻断下游 Agent
  ts: number;
}

// 会话统计
export interface SessionStats {
  startedAt: number;
  durationMs: number;
  views: number;
  likes: number;
  collects: number;
  searches: number;
  follows: number;
}

// 风控状态
export interface RiskStatus {
  status: string;
  quotaLevel: string;
  remainingActionsToday: Record<string, number>;
  viewOnly: boolean;
}

// 收到的笔记
export interface IncomingNote {
  noteId: string;
  title: string;
  summary: string;
  likeCount: number;
  collectCount: number;
  author?: string;
}

// 概念池
export interface ConceptPool {
  known: string[];
  candidates: string[];
  source: Map<string, string>;
}

// Manager 决策（仲裁器产出）
export interface ManagerDecision {
  action: ManagerActionName;
  params?: Record<string, unknown>;
  reason: string;
}

// 事件映射表
export interface EventMap {
  'note.arrived': { note: IncomingNote; ts: number };
  'blackboard.updated': { field: string };
  'agent.decided': { agent: AgentRole; decision: AgentDecision };
  'round.complete': { decisions: Map<AgentRole, AgentDecision> };
  'command.ready': { command: ManagerDecision; envelope: Envelope };
  // 跨模块通知
  'session.started': { sessionId: string };
  'session.ended': { stats: SessionStats };
  'interaction.occurred': { action: 'like' | 'collect'; noteId: string };
  'concept.discovered': { concepts: string[]; source: string };
}
