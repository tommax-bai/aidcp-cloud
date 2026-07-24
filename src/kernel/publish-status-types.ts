/**
 * 发布队列状态的**纯数据模型类型 + 读端口**（kernel 段，Block② 数据网关拆进程读接缝）。
 *
 * 背景：面板层（api/automation 侧）只需「读」发布编排器的当前队列状态，用于后台展示。
 * 拆进程后，取数方可能与托管发布编排器的进程不在同一实例；本文件把「发布队列状态怎么读」
 * 抽成一个 kernel 纯类型闭包 + 一个只读端口，供两侧 type-only 共导——消费方拿到的是端口契约，
 * 而非发布编排器实现本体。
 *
 * 数据类型 {@link PublishQueueRun} / {@link PublishQueueStatus} 结构与 panel 窄类型
 * QueueRunLike / QueueStatusLike 逐字一致，载荷字段用 `unknown`（不把发布管线的具体快照结构漏进 kernel）。
 *
 * kernel 准入（硬约束）：本文件只放纯类型 / 接口——无 SQL、无 fetch/http、无 LLM/供应商标识符、
 * 无模块级 new Set/new Map、无 setTimeout。读端口方法为异步（`Promise`），以便可被内部 HTTP 化。
 */

/** 一次在跑/终态的发布轮摘要。载荷 `snapshot` 用 `unknown`，不把管线快照结构漏进 kernel。 */
export interface PublishQueueRun {
  runId: string;
  accountId: string;
  kind: 'rewrite' | 'autonomous';
  sourceId: string | null;
  startedAt: number;
  status: string;
  snapshot: unknown;
}

/** 发布队列的聚合状态：聚合态 + 最新快照（可空）+ 全部在跑轮摘要（可缺）。 */
export interface PublishQueueStatus {
  status: string;
  snapshot: unknown | null;
  runs?: PublishQueueRun[];
}

/**
 * 发布队列状态的**只读端口**（consumer-facing reader port）。面板层只驱动一个无参只读方法
 * `getStatus`。方法为异步以支持拆进程后经内部 HTTP 取数（本地模式下由组合根注入同步实现的适配）。
 */
export interface PublishStatusReader {
  getStatus(): Promise<PublishQueueStatus>;
}
