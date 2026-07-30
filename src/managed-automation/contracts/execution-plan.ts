/**
 * 契约层：ExecutionPlan —— 由 TaskDefinition 与某个 TaskRevision 编译出的**不可变**执行图
 * （design §2/§4.5）。冻结启用节点、Capability 版本、分支、边界和完成条件。
 *
 * 期1 范围：Plan Compiler 只编译**线性**步骤序列——编译产物的边只允许
 * `kind: 'linear'`。图结构本身以判别联合建模，为后期 DAG/条件/循环预留扩展位
 * （届时向 ExecutionPlanEdge 联合追加成员即可，既有线性 plan 不受影响）。
 * ExecutionPlan 不原地修改：ReviseTask 产生新 TaskRevision + 新 ExecutionPlan（design §4.5）。
 */

import type { EpochMillis, ExecutionTarget } from './common.js';
import type { CapabilityId } from './capability.js';

/**
 * 编译后的计划节点：能力版本已冻结、入参绑定已解析。
 * `enabled` 记录可选节点的启用裁决结果（编译期与 CapabilityScope/授权求交后定值，
 * 运行期不再变）。
 */
export interface ExecutionPlanNode {
  nodeId: string;
  capabilityId: CapabilityId;
  capabilityVersion: number;
  /** 冻结的入参绑定引用。 */
  inputBindingRef: string | null;
  /** 可选节点是否被本次编译启用（design §4.2「可选节点」）。 */
  enabled: boolean;
}

/**
 * 线性边：唯一的期1 边类型。
 * 扩展位：后期在 ExecutionPlanEdge 联合追加 conditional / bounded_loop 成员
 * （与 capability.ts 的 TypedConditionalEdge 家族对应的**编译产物**形态）。
 */
export interface LinearExecutionEdge {
  kind: 'linear';
  from: string;
  to: string;
}

/** 期1 = 仅线性；DAG/条件/循环为预留扩展（见文件头）。 */
export type ExecutionPlanEdge = LinearExecutionEdge;

/**
 * 编译期冻结的运行边界（TaskDefinition.bounds 与 TaskRevision 预算求交后的定值，
 * design §4.5：所有分支可终止、所有循环有界）。
 */
export interface ExecutionPlanBounds {
  maxNodes: number;
  maxLoopIterations: number;
  maxDerivationDepth: number;
  maxExecutionAttempts: number;
  maxWallClockMs: number;
}

/** 不可变 ExecutionPlan（design §4.5 编译输入 → 输出的落点）。 */
export interface ExecutionPlan {
  executionPlanId: string;
  taskId: string;
  taskRevisionId: string;
  executionTarget: ExecutionTarget;
  /** —— 编译输入版本冻结块 —— */
  taskDefinitionId: string;
  taskDefinitionVersion: number;
  /** 编译时逐能力冻结的版本已内联在各节点（capabilityVersion）。 */
  planId: string | null;
  planVersion: number | null;
  /** API 授权修订（外部写节点必须具有对应授权，design §4.5；期1 全 read_only）。 */
  authorizationRef: string;
  /** —— 图结构（期1 线性） —— */
  nodes: ExecutionPlanNode[];
  edges: ExecutionPlanEdge[];
  /** 入口节点（线性序列头）。 */
  entryNodeId: string;
  bounds: ExecutionPlanBounds;
  /** 完成条件引用（含部分完成语义，design §4.5）。 */
  completionConditionRef: string;
  compiledAt: EpochMillis;
}
