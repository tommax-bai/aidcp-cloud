/**
 * automation → api 面板事件投递契约。
 *
 * 这里只定义跨进程信封与单向投递端口；不持有 cursor、订阅表、HTTP 或数据库状态。
 * automation 的 outbox relay 负责至少一次投递，api 的本地 fanout 负责进程内广播。
 */

export const PANEL_EVENT_DELIVERY_CONTRACT_VERSION = 1 as const;

export type PanelEventDeliveryContractVersion = typeof PANEL_EVENT_DELIVERY_CONTRACT_VERSION;
export type PanelEventExecutionTarget = 'dev' | 'ol';

export interface PanelEventDelivery {
  contractVersion: PanelEventDeliveryContractVersion;
  executionTarget: PanelEventExecutionTarget;
  /** 稳定诊断标识；至少一次重投时保持不变，不代表 exactly-once。 */
  deliveryId: string;
  event: string;
  data: unknown;
  /** 事件在 automation 产生时的 epoch ms；缺失时 panel-ws 诚实回落到接收时刻。 */
  originTs?: number;
}

/** api ingress 的最小写端口；成功只表示本地 fanout 已接受，不表示任一浏览器已收到。 */
export interface PanelEventDeliveryPort {
  deliver(delivery: PanelEventDelivery): Promise<void>;
}

export function isPanelEventExecutionTarget(value: unknown): value is PanelEventExecutionTarget {
  return value === 'dev' || value === 'ol';
}

export function makePanelEventDeliveryId(target: PanelEventExecutionTarget, outboxId: number): string {
  if (!Number.isSafeInteger(outboxId) || outboxId <= 0) {
    throw new Error(`panel event outbox id 必须为正安全整数，收到 ${String(outboxId)}`);
  }
  return `event_outbox:${target}:${outboxId}`;
}

export function panelEventDeliveryIdMatches(
  deliveryId: unknown,
  target: PanelEventExecutionTarget,
): deliveryId is string {
  if (typeof deliveryId !== 'string') return false;
  const match = /^event_outbox:(dev|ol):([1-9]\d*)$/.exec(deliveryId);
  if (!match || match[1] !== target) return false;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) && id > 0;
}
