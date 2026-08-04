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
 *
 * ## 两个端口已抬进 kernel，这里只再导出
 * `ReplyWorkflowWritePort` / `InteractionSendPort` 拆进程后还要被 `aidcp-transport` 里那对
 * registrar / client 看见，而传输包只许引 kernel。**唯一声明**因此挪到
 * `../kernel/interaction-automation-ports.ts`，本文件按引用再导出——既有 import 路径一律不变，
 * 也不会出现第二份结构相同的声明（那种漂移两侧都编译得过、只有真跑起来才现形）。
 */
import type {
  ReplyConfigSnapshot,
  MinimalInbound,
  ReplyPreviewResult,
} from '../kernel/interaction-types.js';

export type {
  ReplyWorkflowWritePort,
  InteractionSendPort,
} from '../kernel/interaction-automation-ports.js';

/**
 * 回复预览生成的**只读窄面**：internal-api / scope-internal-api 只驱动 buildPreview 一个方法，
 * 用来把配置快照 + 入站消息投影成一份预览结果（不落库、不改任务状态）。automation 的
 * ReplyWorkflow 结构兼容本端口，由组合根 src/server.ts 注入其实例；automation 类不 import 本端口。
 *
 * **刻意留在这里、不进 kernel**：它只被 api 内部两个 internal-api 用，跨进程那条路上没有它。
 */
export interface ReplyPreviewBuilderPort {
  buildPreview(
    snapshot: ReplyConfigSnapshot,
    inbound: MinimalInbound,
    sourceExternalId: string | null,
  ): Promise<ReplyPreviewResult>;
}
