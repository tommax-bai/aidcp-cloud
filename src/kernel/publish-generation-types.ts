/**
 * 跨进程「发布生成触发」的 kernel 端口（纯类型 / 接口，零副作用）。
 *
 * 背景：调度器（automation 侧 PublishScheduler）经**一个窄接缝**调 content 侧 600s 生成管线。
 * 这里把该接缝升格为 kernel 端口 {@link PublishGenerationPort}：
 *   - local：直接就是 PublishOrchestrator 本体，同步 await 同一管线、副作用链一字不变（逐字节等价）；
 *   - remote：同步 kick 拿 correlationId → 分段有界 long-poll → resolve 同一个 {@link SchedulerTriggerResult}。
 *
 * {@link SchedulerTriggerResult} 从 publish-scheduler 搬入本 kernel 文件重新定义，避免
 * transport / kernel 反向 import automation 层的 publish-scheduler。
 *
 * kernel 门禁：本文件只含类型 / 接口，禁 SQL / fetch / LLM 供应商标识符 / 模块级 new Set·Map / setTimeout。
 */
import type { TriggerInput, PublishResult } from './publish-pipeline-types.js';

/** 审批卡投递结果（结构与 PublishResult.approvalCard 逐字一致，直接取自 kernel 契约防漂移）。 */
export type SchedulerApprovalCardResult = NonNullable<PublishResult['approvalCard']>;

/**
 * 面向调度器的生成终态投影：`status` = 编排收敛态（pending_approval / published / draft 正常，
 * failed / timeout / skipped 非正常）；`reason` = 非正常收敛的可读原因；`runId` / `recordId` /
 * `approvalCard` 供上层飞书回执与血缘对账。JSON 安全、有界，可原样过内部 HTTP 线格式。
 */
export type SchedulerTriggerResult = {
  status: string;
  reason?: string;
  runId?: string;
  recordId?: number | null;
  approvalCard?: SchedulerApprovalCardResult;
};

/**
 * 发布生成触发端口。跑一整轮（或远端派发一轮）生成管线，resolve 出面向调度器的终态。
 * 并发准入（claim 双帽）不进本端口——由调度器同步 claim 段负责；本端口只承载「已准入的生成」。
 */
export interface PublishGenerationPort {
  trigger(input: TriggerInput): Promise<SchedulerTriggerResult>;
}
