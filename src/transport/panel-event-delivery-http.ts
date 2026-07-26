/**
 * automation → api 面板事件内部 HTTP 传输。
 *
 * automation 侧 client 逐条投递 outbox 事件；api 侧 route 校验版本、target 与稳定 deliveryId 后，
 * 只调用注入的本地 fanout。HTTP 成功仅表示进程级 fanout 已接受，不表示浏览器在线或已收帧。
 */

import {
  PANEL_EVENT_DELIVERY_CONTRACT_VERSION,
  isPanelEventExecutionTarget,
  panelEventDeliveryIdMatches,
  type PanelEventDelivery,
  type PanelEventDeliveryPort,
  type PanelEventExecutionTarget,
} from '../kernel/panel-event-delivery-port.js';
import { InternalHttpError, type InternalHttpClient, type InternalHttpServer } from './internal-http.js';

export const PANEL_EVENT_DELIVERY_ROUTES = {
  deliver: 'panel-event/deliver',
} as const;

interface PanelEventDeliveryAck {
  accepted: true;
  deliveryId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseDelivery(args: unknown, expectedTarget: PanelEventExecutionTarget): PanelEventDelivery {
  if (!isRecord(args)) {
    throw new InternalHttpError('panel_event_bad_request', 'panel event delivery must be an object');
  }
  if (args.contractVersion !== PANEL_EVENT_DELIVERY_CONTRACT_VERSION) {
    throw new InternalHttpError(
      'panel_event_version_unsupported',
      `unsupported panel event contractVersion=${String(args.contractVersion)}`,
    );
  }
  if (!isPanelEventExecutionTarget(args.executionTarget) || args.executionTarget !== expectedTarget) {
    throw new InternalHttpError(
      'panel_event_target_mismatch',
      `panel event target=${String(args.executionTarget)} does not match receiver target=${expectedTarget}`,
    );
  }
  if (!panelEventDeliveryIdMatches(args.deliveryId, expectedTarget)) {
    throw new InternalHttpError(
      'panel_event_delivery_id_invalid',
      `deliveryId does not match target=${expectedTarget}`,
    );
  }
  if (typeof args.event !== 'string' || args.event.length === 0 || !('data' in args)) {
    throw new InternalHttpError('panel_event_bad_request', 'panel event delivery requires non-empty event and data');
  }
  if (args.originTs !== undefined && (typeof args.originTs !== 'number' || !Number.isFinite(args.originTs))) {
    throw new InternalHttpError('panel_event_bad_request', 'panel event originTs must be a finite epoch number');
  }
  return {
    contractVersion: PANEL_EVENT_DELIVERY_CONTRACT_VERSION,
    executionTarget: expectedTarget,
    deliveryId: args.deliveryId,
    event: args.event,
    data: args.data,
    ...(args.originTs === undefined ? {} : { originTs: args.originTs }),
  };
}

function assertAck(value: unknown, deliveryId: string): asserts value is PanelEventDeliveryAck {
  if (!isRecord(value) || value.accepted !== true || value.deliveryId !== deliveryId) {
    throw new InternalHttpError(
      'bad_response',
      `panel event delivery returned malformed acknowledgement for ${deliveryId}`,
    );
  }
}

export function registerPanelEventDeliveryRoutes(
  server: InternalHttpServer,
  local: PanelEventDeliveryPort,
  executionTarget: PanelEventExecutionTarget,
): void {
  server.register(PANEL_EVENT_DELIVERY_ROUTES.deliver, async (args) => {
    const delivery = parseDelivery(args, executionTarget);
    await local.deliver(delivery);
    return { accepted: true, deliveryId: delivery.deliveryId } satisfies PanelEventDeliveryAck;
  });
}

export class PanelEventDeliveryHttpClient implements PanelEventDeliveryPort {
  constructor(private readonly http: InternalHttpClient) {}

  async deliver(delivery: PanelEventDelivery): Promise<void> {
    const ack = await this.http.call<PanelEventDeliveryAck>(PANEL_EVENT_DELIVERY_ROUTES.deliver, delivery);
    assertAck(ack, delivery.deliveryId);
  }
}
