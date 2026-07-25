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

// ── change cloud-coupling-phase0：发布触发的结果契约收口到本文件 ──────────────────────
// 此前这四段住在 automation 属主的 publish-scheduler 实现文件里，于是 automation 的委托任务执行器
// 与 content 的首作协调器为了几个纯类型双双直连那个实现文件。它们的公共依赖
// SchedulerApprovalCardResult 本来就在这儿，落这里是复用不是新建。

/** 洗稿参照笔记（change curated-note-actions）：管理后台精选页人工指定，注入创作输入独立参照块。 */
export type ReferenceNote = NonNullable<TriggerInput['generateInput']['referenceNote']>;

/** 同步触发被拒的原因。started=false 时供 HTTP 回执直译，取值即对外文案键。 */
export type ClaimRejectReason = 'duplicate_source' | 'already_running' | 'publish_capacity' | 'publish_busy';

/**
 * 一轮触发的终态。
 * reason = 触发原因（manual_feishu / concept_threshold(...) / risk_window(...)）；
 * status = 编排终态（pending_approval/published/draft 正常，failed/timeout/skipped 非正常）；
 * failureReason = 编排非正常收敛时的可读原因（来自编排器，供飞书回执 surface「为什么」）。
 */
export type TriggerOutcome =
  | { result: 'triggered'; reason: string; status: string; recordId?: number | null; failureReason?: string; approvalCard?: SchedulerApprovalCardResult }
  | { result: 'skipped'; reason: string }
  | { result: 'blocked'; reason: string };

/** console 洗稿同步触发结果：started=false 时 reason 供 HTTP 回执直译；started=true 时 outcome 在本轮收敛时 settle。 */
export type BeginRewriteResult =
  | { started: true; outcome: Promise<TriggerOutcome> }
  | { started: false; reason: ClaimRejectReason };
