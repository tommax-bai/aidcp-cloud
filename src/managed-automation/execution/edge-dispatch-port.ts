/**
 * 执行层（期1-6）：EdgeDispatchPort —— 研究步执行器对「任务态边端命令通道」的窄端口。
 *
 * 端口 + 适配器：ResearchStepExecutor 只依赖本接口；真实适配器
 * （comm-edge-dispatch-adapter.ts，期1 收缩为接线说明）用现有 comm 层实现，
 * 测试用假端口。端口刻意窄：**只发只读命令**（commandKind 判别字段冻结为
 * 'research.read'），写命令没有入口——类型面就到不了平台写入。
 *
 * 实现契约（假/真适配器都必须满足，执行器据此做诚实映射）：
 *   - 必须在 options.timeoutMs 内落定；到期未拿到回执 → 'timeout'（不是猜成功）；
 *   - 目标环境无任务态在线连接 / 投递失败 → 'undeliverable'（诚实 0 投递，不广播）；
 *   - options.signal abort（worker 租约易主/停机）→ 尽快以 'aborted' 落定；
 *   - 边端如实回报空结果（如搜索 0 命中）→ 'empty' + 具名原因码，不伪装成完成；
 *   - 'completed' 只在拿到边端回执后返回，产出以引用透出（resultRef/checkpointRef），
 *     不在端口层复制原文。
 */

import type { PlatformId } from '../../kernel/platform-types.js';
import type { ExecutionTarget, StructuredConstraints } from '../contracts/common.js';
import type { CapabilityId } from '../contracts/capability.js';
import type { ReasonCode, TerminalReasonCode } from '../contracts/reason-codes.js';

/** 只读研究命令（发往指定任务态环境的边端）。 */
export interface ReadOnlyEdgeCommand {
  /** 判别字段冻结：本端口只承载只读研究命令。 */
  commandKind: 'research.read';
  capabilityId: CapabilityId;
  capabilityVersion: number;
  executionTarget: ExecutionTarget;
  /** 目标环境（任务态会话所在 envKey，run 冻结块注入）。 */
  envKey: string;
  accountId: string;
  platform: PlatformId;
  runId: string;
  stepRunId: string;
  nodeId: string;
  /** 编译期冻结的入参绑定引用。 */
  inputBindingRef: string | null;
  /** 断点续跑检查点（首跑 null）；边端从已确认进度继续，不从 0 开始。 */
  checkpointRef: string | null;
  /** 结构化参数（如关键词、篇数上限；schema 由能力 inputSchemaRef 约束）。 */
  params: StructuredConstraints;
}

export interface EdgeDispatchOptions {
  /** 回执等待上限（取能力 bounds.maxWallClockMs）。 */
  timeoutMs: number;
  /** worker 中断信号（租约易主/停机）。 */
  signal: AbortSignal;
}

/**
 * 派发结果判别联合（端口层真相，执行器一对一映射为 StepExecutionResult，
 * 绝不把 timeout/undeliverable/未知伪装成 completed）。
 */
export type EdgeDispatchOutcome =
  | {
      kind: 'completed';
      /** 步产出引用（如浏览摘要引用），写入 StepRun.resultRef。 */
      resultRef: string | null;
      /** 边端确认进度的检查点引用，写入 StepRun.checkpointRef。 */
      checkpointRef: string | null;
      /** 本步新确认的唯一工作单元数（design §16 口径）。 */
      confirmedDelta: number;
    }
  | { kind: 'empty'; reasonCode: TerminalReasonCode; detail?: string }
  | { kind: 'failed'; reasonCode: ReasonCode; detail?: string }
  | { kind: 'timeout'; detail?: string }
  | { kind: 'undeliverable'; detail?: string }
  | { kind: 'aborted' };

export interface EdgeDispatchPort {
  dispatchReadOnly(command: ReadOnlyEdgeCommand, options: EdgeDispatchOptions): Promise<EdgeDispatchOutcome>;
}
