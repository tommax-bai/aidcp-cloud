import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PANEL_EVENT_DELIVERY_CONTRACT_VERSION,
  type PanelEventDelivery,
} from '@kernel/kernel/panel-event-delivery-port.js';
import { PanelEventFanout } from '@api/panel/panel-event-fanout.js';

const DELIVERY: PanelEventDelivery = {
  contractVersion: PANEL_EVENT_DELIVERY_CONTRACT_VERSION,
  executionTarget: 'dev',
  deliveryId: 'event_outbox:dev:8',
  event: 'note.detail.arrived',
  data: { noteId: 'note-8' },
  originTs: 8_000,
};

test('PanelEventFanout：无订阅者也完成进程级投递，不建立浏览器 backlog', async () => {
  const fanout = new PanelEventFanout({ warn() {} });
  await assert.doesNotReject(fanout.deliver(DELIVERY));

  const later: string[] = [];
  fanout.onAny((event) => later.push(event));
  assert.deepEqual(later, []);
});

test('PanelEventFanout：单订阅者同步异常被隔离，后续订阅者仍收到原始时间', async () => {
  const warnings: string[] = [];
  const fanout = new PanelEventFanout({ warn: (line) => warnings.push(String(line)) });
  const received: unknown[] = [];
  fanout.onAny(() => {
    throw new Error('broken_subscriber');
  });
  fanout.onAny((event, data, originTs) => {
    received.push({ event, data, originTs });
  });

  await fanout.deliver(DELIVERY);

  assert.deepEqual(received, [
    { event: DELIVERY.event, data: DELIVERY.data, originTs: DELIVERY.originTs },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /broken_subscriber/);
  assert.match(warnings[0], /event_outbox:dev:8/);
});

test('PanelEventFanout：异步 rejection 被隔离且 unsubscribe 后不再广播', async () => {
  const warnings: string[] = [];
  const fanout = new PanelEventFanout({ warn: (line) => warnings.push(String(line)) });
  const received: string[] = [];
  fanout.onAny(async () => {
    throw new Error('async_broken_subscriber');
  });
  const unsub = fanout.onAny((event) => {
    received.push(event);
  });

  await fanout.deliver(DELIVERY);
  unsub();
  await fanout.deliver({ ...DELIVERY, deliveryId: 'event_outbox:dev:9', event: 'second' });

  assert.deepEqual(received, [DELIVERY.event]);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((line) => line.includes('async_broken_subscriber')));
});

test('PanelEventFanout：相同 deliveryId 重投保持 at-least-once，可向浏览器重复广播', async () => {
  const fanout = new PanelEventFanout({ warn() {} });
  const deliveryIds: string[] = [];
  fanout.onAny(() => deliveryIds.push(DELIVERY.deliveryId));

  await fanout.deliver(DELIVERY);
  await fanout.deliver(DELIVERY);

  assert.deepEqual(deliveryIds, [DELIVERY.deliveryId, DELIVERY.deliveryId]);
});
