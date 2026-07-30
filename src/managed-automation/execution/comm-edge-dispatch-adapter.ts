/**
 * 执行层（期1-6）：真实 comm 适配器接线说明（TODO 接口文件，收缩交付）。
 *
 * 任务 8 允许的收缩路径：调研后确认「真实 comm 适配器最小接线」涉及面过大，
 * 期1 交付 = 端口定义（edge-dispatch-port.ts）+ 假端口测试全绿 + 本文件如实
 * 记录剩余接线量。**不做一半的脆弱接线**：与其塞一个只能在特定分支跑通的
 * 半成品，不如把缺口列清楚，期2 一次接完。
 *
 * ## 为什么收缩（调研结论，2026-07-30）
 *
 * 1. **协议缺消息**：src/comm/protocol.ts 的 Envelope type 全集里没有
 *    「research.read 命令 / 回执」消息对；新增消息要同时动 protocol.ts、
 *    ws-server.ts 的 operation 分类器（pushToEdges 对 operation_unclassified
 *    直接拒发，见 ws-server.ts:290）与边端处理器——跨 3+ 存量文件。
 * 2. **任务态连接没有运行时查找口**：ConnectionRuntimeRegistry.runtimeForAccount
 *    刻意排除任务态连接（期1-3 调度排除的既定语义）；按 envKey 找「任务态
 *    在线连接的 edgeId」需要给 ws-server 新增一个只读查找方法（isTaskModeEdge
 *    只能校验已知 edgeId，不能反查）。
 * 3. **边端未实现**：research.search/browse/assess/summarize 的边端执行器
 *    （DOM 只读采集）在 edge 侧尚不存在，云侧接完也无回执可等。
 *
 * ## 真实适配器的接线蓝图（期2 落地清单）
 *
 * 依赖倒的窄接口（下方 CommEdgeDispatchWiring），全部有现成事实源：
 *   - pushToEdges：EdgeCloudServer（src/comm/ws-server.ts:289，EdgePusher 精神；
 *     窄接口先例：src/comm/edge-task-lease-client.ts:15 EdgeTaskLeasePusher）；
 *   - isTaskModeEdge：src/comm/ws-server.ts:483（OPEN + 非 stale 口径）；
 *   - 回执订阅：EventBus（src/event-bus/index.ts:22），先订阅后发送
 *     （sendAndAwait 先例：src/comment-agent/edge-steps.ts）。
 *
 * 剩余工作量（估）：
 *   a. protocol.ts 新增 research 命令/回执消息对 + makeEnvelope 类型收编；
 *   b. ws-server.ts operation 分类器登记新消息为只读操作 + 新增
 *      taskModeEdgeIdForEnv(envKey) 只读查找（约 30 行，含 stale 口径复用）；
 *   c. 本文件补 CommEdgeDispatchAdapter implements EdgeDispatchPort：
 *      订阅回执 → pushToEdges 定向下发（返回 0 → 'undeliverable'，不广播）→
 *      按 stepRunId 匹配回执 → timeoutMs 到期 'timeout' / signal abort 'aborted'；
 *   d. 边端四步只读执行器（另一条任务线，不在云侧范围）。
 *   云侧 a+b+c 合计约 200-300 行改动，其中 a、b 动存量文件需独立评审。
 */

import type { Envelope } from '../../comm/protocol.js';

/**
 * 真实适配器对 comm 层的窄依赖（期2 由组合根以 EdgeCloudServer + EventBus 满足）。
 * 语义契约与事实源同步：pushToEdges 缺 edgeId 绝不广播、命中 0 如实返回 0；
 * isTaskModeEdge 只认 OPEN + 非 stale。
 */
export interface CommEdgeDispatchWiring {
  pushToEdges(envelope: Envelope, edgeId?: string): number;
  isTaskModeEdge(edgeId: string): boolean;
  /**
   * TODO(期2)：ws-server 新增「按 envKey 反查任务态在线连接 edgeId」的只读方法后
   * 收编进来；期1 不存在该事实源（runtimeForAccount 刻意排除任务态）。
   */
  taskModeEdgeIdForEnv?(envKey: string): string | null;
}
