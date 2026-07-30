/**
 * 契约层：CapabilityDefinition 与 TaskDefinition（定义对象，与运行对象分开，design §2/§4）。
 *
 * CapabilityDefinition 回答「系统会做什么」：领域合同意义上的原子能力，可内部完成定位、
 * 前置复核、动作和后置验证，但不能决定下一个无关 Capability（design §4.1）。
 * TaskDefinition 回答「能力如何组成一种任务」：由代码和受审配置发布，内部用 executionGraph
 * 描述能力关系；不允许任意代码、动态导入、无上限循环、未登记事件订阅、直接 SQL/HTTP/Edge
 * 命令名（design §4.2）。不设一级 Workflow 对象。
 */

import type { EpochMillis } from './common.js';
import type { ActionDomain, ActionExecutionClass } from './action-classification.js';

/**
 * 能力 ID（如 'content.search'、'interaction.like'、'publish.submit'）。
 * design §4.1 的首批清单是示例而非闭集，能力发布走 allowlist 与代码评审，
 * 契约层不冻结具体 ID 枚举。
 */
export type CapabilityId = string;

/** 能力副作用等级：'external_write' 对应执行分类 platform_write（见 action-classification.ts）。 */
export type CapabilitySideEffect = 'none' | 'reversible' | 'external_write';

export const CAPABILITY_SIDE_EFFECTS = [
  'none',
  'reversible',
  'external_write',
] as const satisfies readonly CapabilitySideEffect[];

/** design §4.1 逐字冻结，另补 actionDomain / executionClass 关联（准入闸判据，裁量新增）。 */
export interface CapabilityDefinition {
  capabilityId: CapabilityId;
  version: number;
  inputSchemaRef: string;
  outputSchemaRef: string;
  sideEffect: CapabilitySideEffect;
  requiredEvidenceRef: string;
  bounds: {
    maxWallClockMs: number;
    maxExecutionAttempts: number;
  };
  /** 该能力落在哪个动作域（授权判定入口，design §9）。 */
  actionDomain: ActionDomain;
  /** 执行分类：期1 准入闸只放行 'read_only'。与 sideEffect 一致性由发布评审保证。 */
  executionClass: ActionExecutionClass;
}

/**
 * executionGraph 节点。design §4.2 中 nodes 类型名为 TypedCapabilityNode。
 * `optional: true` 表达可选节点（Task 允许点赞时才启用点赞节点，design §4.2）。
 */
export interface TypedCapabilityNode {
  nodeId: string;
  capabilityId: CapabilityId;
  capabilityVersion: number;
  /** 节点入参绑定引用（受 CapabilityDefinition.inputSchemaRef 约束）。 */
  inputBindingRef: string | null;
  optional: boolean;
}

/**
 * executionGraph 边。design §4.2 中 edges 类型名为 TypedConditionalEdge，
 * 可表达顺序 / 条件 / 有界循环 / 命名等待点 / 子任务引用。
 * 契约以判别联合建模并**为后期预留扩展位**；编译产物 ExecutionPlan（期1 只编译线性）
 * 见 execution-plan.ts。
 */
export type TypedConditionalEdge =
  | SequentialEdge
  | ConditionalEdge
  | BoundedLoopEdge;

/** 顺序边：from 完成后进入 to。 */
export interface SequentialEdge {
  kind: 'sequential';
  from: string;
  to: string;
}

/** 条件边：条件谓词引用受审配置，不允许任意代码（design §4.2）。**期1 不编译**。 */
export interface ConditionalEdge {
  kind: 'conditional';
  from: string;
  to: string;
  /** 类型化条件引用（如 'assessment.value == high'），schema 由发布评审冻结。 */
  conditionRef: string;
}

/** 有界循环边：完成条件与上限二选一必达（design §4.2「有界循环」）。**期1 不编译**。 */
export interface BoundedLoopEdge {
  kind: 'bounded_loop';
  from: string;
  to: string;
  /** 循环完成条件引用（如 unique_verified_content = 20）。 */
  completionConditionRef: string;
  maxIterations: number;
}

/** design §4.2 逐字冻结。 */
export interface TaskDefinition {
  taskDefinitionId: string;
  version: number;
  inputSchemaRef: string;
  allowedTriggerTypes: string[];
  executionGraph: {
    nodes: TypedCapabilityNode[];
    edges: TypedConditionalEdge[];
  };
  bounds: {
    maxNodes: number;
    maxLoopIterations: number;
    maxDerivationDepth: number;
    maxExecutionAttempts: number;
    maxWallClockMs: number;
  };
  /** 发布时间（能力发布走 allowlist 与代码评审，design §4.2）。 */
  publishedAt: EpochMillis;
}
