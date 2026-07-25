/**
 * 事件扇出端口 —— 只读订阅「本进程内已发生的事件流」的最小形状。
 *
 * 面板 BFF（api）只需要「通配订阅 + 退订」这一件事：把每条事件归一化成面板帧广播给浏览器。
 * 它 MUST NOT 拿到 emit / emitRaw / on / off / removeAllListeners —— 那些是编排侧（automation）
 * 的写能力。端口收窄到 onAny 一条，读侧就再没有「顺手 emit 一下」的通道。
 *
 * 本文件是纯契约：零 import、零实现、零进程内状态。automation 侧的进程内总线结构上已满足本端口，
 * 组合根按原样注入即可，MUST NOT 为它另写适配器。
 */

/**
 * 通配订阅者。
 *
 * 第三个参数 originTs（epoch ms）**只在跨进程回放时**由转发方给出：事件原本发生在另一个进程的
 * 那一刻。进程内正常分发恒为 undefined（= 就是此刻）。可选参数 ⇒ 既有的两参 handler 原样兼容。
 */
export type PanelEventHandler = (event: string, data: unknown, originTs?: number) => void;

/** 事件扇出端口：只暴露通配订阅，返回退订函数。 */
export interface EventFanoutPort {
  onAny(handler: PanelEventHandler): () => void;
}
