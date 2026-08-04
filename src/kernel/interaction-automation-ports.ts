/**
 * 互动域「配置/查询面 → 编排面」的两个窄注入端口的**唯一声明**。
 *
 * ## 为什么在 kernel
 * 这两个端口原先声明在 `src/interactions/interaction-automation-ports.ts`（api 属主）。
 * 拆进程之后它们必须被**三方**同时看见：api（消费者，按端口标注构造参数）、
 * automation（属主，按结构兼容提供实例）、以及 `aidcp-transport` 里那对
 * registrar / client（把同一组方法搬过内部 HTTP）。传输包只许引 kernel，
 * 于是它要么拿到这一份，要么**自己再声明一份结构相同的**——后者正是本仓
 * 反复付过代价的形状：两份声明各自编译通过、各自测试通过，签名漂开时没有任何东西会说话，
 * 只有真把两个进程跑起来、且恰好走到那个参数时才现形。
 *
 * 本文件零运行时、零依赖（只引 kernel 内的互动契约类型），满足 kernel 准入。
 * 原属主文件保留为残壳并**具名再导出**这两个名字，既有 import 路径一律不变。
 *
 * ## 为什么最后两个方法返回 Promise
 * `requestAuthReopen` / `requestBrowserControl` 在单体里是同步返回 requestId 的。
 * 拆进程后它们必然要过一次网络 ⇒ 签名只能是异步的。这里**直接定成异步**、
 * 而不是写成 `string | Promise<string>`：后者让「本地实现」与「远端实现」在类型上仍然同形，
 * 调用方就有可能漏掉 `await` 而拿到一个 Promise 当 requestId 用——那不报错，
 * 只是回执里的 requestId 变成 `[object Promise]`，一路写进台账。
 */
import type {
  ScopedJobContext,
  InteractionSyncRequestPayload,
  InteractionAuthReopenPayload,
  InteractionBrowserControlPayload,
} from './interaction-types.js';

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

/**
 * 发送编排的窄面：customer-api 用到的入队/下发/请求同步/请求重开授权/请求浏览器控制。
 *
 * **后四个是提交点**（命令会离开本进程、可能已经上墙）：`dispatchQueued` / `requestSync` /
 * `requestAuthReopen` / `requestBrowserControl`。任何搬运层 MUST NOT 对它们做重试，
 * 结果不明时 MUST 如实报「已发出但核不到」，MUST NOT 折成一句可重试的失败。
 */
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
  requestAuthReopen(
    input: Omit<InteractionAuthReopenPayload, 'requestId' | 'requestedAt' | 'platform'>,
  ): Promise<string>;
  requestBrowserControl(
    input: Omit<InteractionBrowserControlPayload, 'requestId' | 'requestedAt' | 'platform'>,
  ): Promise<string>;
}

/**
 * 提交点名单——**运行时可读**，因为搬运层要按它决定「结果不明时怎么报」。
 *
 * 写成常量而不是散在各处的 if：这份名单是安全判据，散开之后新增一个提交点时
 * 没有任何东西会提醒你去更新它，而漏掉的后果是重投一条可能已经上墙的命令。
 */
export const INTERACTION_SUBMISSION_METHODS = [
  'dispatchQueued',
  'requestSync',
  'requestAuthReopen',
  'requestBrowserControl',
] as const satisfies ReadonlyArray<keyof InteractionSendPort>;

export type InteractionSubmissionMethod = (typeof INTERACTION_SUBMISSION_METHODS)[number];
