/**
 * 任务规划层类型。
 *
 * 规划层职责：把人给的高层目标（"给这条笔记点赞并关注作者"）拆成有序的
 * 原子步骤（PlanStep[]），每步带稳定 actionId / op / 自然语言 goal，
 * 交给边缘端的 LocatingEngine 逐步定位执行。
 */

import type { PlanStep } from '../comm/protocol.js';

export type { PlanStep } from '../comm/protocol.js';

/** 规划输入 */
export interface PlanRequest {
  /** 高层自然语言目标 */
  goal: string;
  /** 可选上下文（站点、当前 url 等） */
  context?: Record<string, string>;
}

/** 规划输出 */
export interface Plan {
  steps: PlanStep[];
  /** 规划说明（调试/可观测） */
  reason: string;
}

/** 任务规划器接口（可插拔：规则版 / LLM 版） */
export interface TaskPlanner {
  plan(req: PlanRequest): Promise<Plan>;
}
