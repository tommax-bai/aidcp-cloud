/**
 * api 进程内的面板事件 fanout。
 *
 * 对内部 ingress 实现写侧 `PanelEventDeliveryPort`，对 panel-ws 只暴露只读
 * `EventFanoutPort.onAny`。它不持久化、不做浏览器 replay，也不复制 automation EventBus。
 */

import type { EventFanoutPort, PanelEventHandler } from '../kernel/event-fanout-port.js';
import type { PanelEventDelivery, PanelEventDeliveryPort } from '../kernel/panel-event-delivery-port.js';

export class PanelEventFanout implements EventFanoutPort, PanelEventDeliveryPort {
  private readonly subscribers = new Set<PanelEventHandler>();

  constructor(private readonly logger: Pick<Console, 'warn'> = console) {}

  onAny(handler: PanelEventHandler): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  async deliver(delivery: PanelEventDelivery): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const subscriber of this.subscribers) {
      try {
        const result = subscriber(delivery.event, delivery.data, delivery.originTs) as unknown;
        if (result && typeof (result as PromiseLike<void>).then === 'function') {
          pending.push(
            Promise.resolve(result).then(
              () => undefined,
              (err: unknown) => this.warnSubscriber(delivery, err),
            ),
          );
        }
      } catch (err: unknown) {
        this.warnSubscriber(delivery, err);
      }
    }
    await Promise.all(pending);
  }

  private warnSubscriber(delivery: PanelEventDelivery, err: unknown): void {
    this.logger.warn(
      `[panel-event-fanout] subscriber failed delivery=${delivery.deliveryId} event=${delivery.event}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
