/**
 * api 侧「需要 automation 行为」的窄注入端口（consumer-owned ports / DIP）。
 *
 * 背景：interaction-customer-api（api）过去直接 `import type` automation 的具体编排类
 * （send-orchestrator / reply-workflow）来标注构造参数，形成 api→automation 跨边界依赖。
 * 这里把 api 真正用到的方法收窄成端口接口，api 只依赖本文件（api→api）与 kernel 契约（api→kernel）；
 * automation 的具体实例由组合根 src/server.ts 按结构兼容注入（automation 类**不 import 本端口、不 implements**，
 * 保持零反向依赖）。任何签名漂移在 server.ts 的实例赋值处被 typecheck 当场逮住。
 *
 * 端口只覆盖 customer-api 实际调用的方法；返回/入参类型全部取自 kernel 契约，本文件零 automation 依赖。
 * 参照已落地的 ReplyAiPort（kernel）/ InteractionApiPurgePort（automation 消费者自持端口）同一手法。
 */
import type {
  ScopedJobContext,
  InteractionSyncRequestPayload,
  InteractionAuthReopenPayload,
  InteractionBrowserControlPayload,
  ReplyConfigSnapshot,
  MinimalInbound,
  ReplyPreviewResult,
} from '../kernel/interaction-types.js';

/**
 * 回复预览生成的**只读窄面**：internal-api / scope-internal-api 只驱动 buildPreview 一个方法，
 * 用来把配置快照 + 入站消息投影成一份预览结果（不落库、不改任务状态）。automation 的
 * ReplyWorkflow 结构兼容本端口，由组合根 src/server.ts 注入其实例；automation 类不 import 本端口。
 */
export interface ReplyPreviewBuilderPort {
  buildPreview(
    snapshot: ReplyConfigSnapshot,
    inbound: MinimalInbound,
    sourceExternalId: string | null,
  ): Promise<ReplyPreviewResult>;
}

/** 回复工作流的「写侧」窄面：customer-api 只驱动人工审批/生成/编辑这三个跃迁。 */
export interface ReplyWorkflowWritePort {
  generate(input: {
    accountId: string; envKey: string; jobId: string; expectedVersion: number; actor: string;
  }): Promise<ScopedJobContext['job']>;
  approve(input: {
    accountId: string; envKey: string; jobId: string; expectedVersion: number; actor: string;
  }): Promise<ScopedJobContext['job']>;
  edit(input: {
    accountId: string; envKey: string; jobId: string; expectedVersion: number; actor: string; text: string;
  }): Promise<ScopedJobContext['job']>;
}

/** 发送编排的窄面：customer-api 用到的入队/下发/请求同步/请求重开授权/请求浏览器控制。 */
export interface InteractionSendPort {
  queueApproved(input: {
    accountId: string; envKey: string; jobId: string; expectedVersion: number; actor: string;
  }): Promise<ScopedJobContext['job']>;
  dispatchQueued(input: {
    accountId: string; envKey: string; jobId: string; expectedVersion: number;
  }): Promise<{ job: ScopedJobContext['job']; attemptId: string }>;
  requestSync(
    input: Omit<InteractionSyncRequestPayload, 'requestId' | 'requestedAt' | 'platform'>,
    options?: { beforeDispatch?: () => Promise<void> },
  ): Promise<string>;
  requestAuthReopen(input: Omit<InteractionAuthReopenPayload, 'requestId' | 'requestedAt' | 'platform'>): string;
  requestBrowserControl(input: Omit<InteractionBrowserControlPayload, 'requestId' | 'requestedAt' | 'platform'>): string;
}
