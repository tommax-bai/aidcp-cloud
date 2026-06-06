/**
 * Agent 公共类型 — 定义 BaseAgent 抽象类与通用选项接口。
 *
 * 所有拆分后的独立 Agent 均继承 BaseAgent，实现 shouldActivate / decide 方法。
 * Agent 仅依赖 BlackboardState 接口读取上下文，不直接操作 EventBus 或 Blackboard 实例。
 */

import type { AgentRole, AgentDecision } from '../event-bus/types.js';
import type { BlackboardState } from '../blackboard/types.js';
import type { LlmClient } from '../llm/qwen.js';
import type { Soul } from '../soul/types.js';

export interface BaseAgentOptions {
  soul: Soul;
  llm?: LlmClient;
}

export abstract class BaseAgent {
  abstract readonly role: AgentRole;
  protected readonly soul: Soul;
  protected readonly llm?: LlmClient;

  constructor(options: BaseAgentOptions) {
    this.soul = options.soul;
    this.llm = options.llm;
  }

  /** 判断当前轮次是否需要激活此 Agent */
  abstract shouldActivate(board: BlackboardState): boolean;

  /** 从黑板读取上下文，独立产出决策 */
  abstract decide(board: BlackboardState): Promise<AgentDecision>;

  /** 构造 pass 决策的便捷方法 */
  protected pass(reason: string): AgentDecision {
    return { agent: this.role, action: 'pass', reason, confidence: 0, ts: Date.now() };
  }
}
