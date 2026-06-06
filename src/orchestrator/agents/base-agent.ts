/**
 * RoleAgent 接口：事件驱动架构下的角色 Agent 基础定义。
 *
 * 每个 Agent 实现 process() 方法：
 * 1. 从 EventStream 中读取所需的前置事件
 * 2. 自主判断是否满足执行条件（包括检查 session.verdict）
 * 3. 满足则执行并将结果写回 EventStream；不满足则跳过
 */

import type { EventStream } from '../events.js';
import type { Soul } from '../../soul/types.js';

/** Agent 通用接口 */
export interface RoleAgent {
  /** Agent 标识名 */
  readonly name: string;

  /**
   * 处理一轮事件。
   * Agent 自主检查事件流中是否具备执行条件，具备则执行并 emit 产出事件。
   * 必须幂等——若已产出过自己的事件则直接 return。
   */
  process(stream: EventStream, soul: Soul): Promise<void>;
}

/** Agent 的 LLM 配置（每个角色可独立配置） */
export interface AgentLlmConfig {
  model?: string;
  temperature?: number;
  timeoutMs?: number;
}
