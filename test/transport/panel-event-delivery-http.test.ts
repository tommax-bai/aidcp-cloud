import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PANEL_EVENT_DELIVERY_CONTRACT_VERSION,
  type PanelEventDelivery,
  type PanelEventDeliveryPort,
} from '@kernel/kernel/panel-event-delivery-port.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '@automation/transport/internal-http.js';
import {
  PANEL_EVENT_DELIVERY_ROUTES,
  PanelEventDeliveryHttpClient,
  registerPanelEventDeliveryRoutes,
} from '@automation/transport/panel-event-delivery-http.js';

const SAMPLE: PanelEventDelivery = {
  contractVersion: PANEL_EVENT_DELIVERY_CONTRACT_VERSION,
  executionTarget: 'dev',
  deliveryId: 'event_outbox:dev:42',
  event: 'interaction.occurred',
  data: { accountId: 'acc-1', action: 'like' },
  originTs: 1_700_000_000_123,
};

async function withDeliveryServer(
  local: PanelEventDeliveryPort,
  run: (client: PanelEventDeliveryPort, raw: InternalHttpClient) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerPanelEventDeliveryRoutes(server, local, 'dev');
  const port = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${port}`);
  try {
    await run(new PanelEventDeliveryHttpClient(raw), raw);
  } finally {
    await server.close();
  }
}

test('panel event delivery HTTP：版本化信封逐字段送达并等待本地 ingress', async () => {
  const seen: PanelEventDelivery[] = [];
  await withDeliveryServer(
    {
      deliver: async (delivery) => {
        await Promise.resolve();
        seen.push(delivery);
      },
    },
    async (client) => {
      await client.deliver(SAMPLE);
    },
  );
  assert.deepEqual(seen, [SAMPLE]);
});

test('panel event delivery HTTP：未知版本、target 不匹配与伪造 deliveryId 均在 fanout 前拒绝', async () => {
  let calls = 0;
  await withDeliveryServer(
    {
      deliver: async () => {
        calls += 1;
      },
    },
    async (_client, raw) => {
      await assert.rejects(
        raw.call(PANEL_EVENT_DELIVERY_ROUTES.deliver, { ...SAMPLE, contractVersion: 2 }),
        (err: unknown) => err instanceof InternalHttpError && err.code === 'panel_event_version_unsupported',
      );
      await assert.rejects(
        raw.call(PANEL_EVENT_DELIVERY_ROUTES.deliver, {
          ...SAMPLE,
          executionTarget: 'ol',
          deliveryId: 'event_outbox:ol:42',
        }),
        (err: unknown) => err instanceof InternalHttpError && err.code === 'panel_event_target_mismatch',
      );
      await assert.rejects(
        raw.call(PANEL_EVENT_DELIVERY_ROUTES.deliver, { ...SAMPLE, deliveryId: 'event_outbox:dev:other' }),
        (err: unknown) => err instanceof InternalHttpError && err.code === 'panel_event_delivery_id_invalid',
      );
    },
  );
  assert.equal(calls, 0);
});

test('panel event delivery HTTP：本地 ingress 失败原样传给 automation client', async () => {
  await withDeliveryServer(
    {
      deliver: async () => {
        throw Object.assign(new Error('fanout_unavailable'), { code: 'panel_event_fanout_unavailable' });
      },
    },
    async (client) => {
      await assert.rejects(
        client.deliver(SAMPLE),
        (err: unknown) => err instanceof InternalHttpError && err.code === 'panel_event_fanout_unavailable',
      );
    },
  );
});

test('PanelEventDeliveryHttpClient：响应缺少匹配 ack 时不把坏响应当成功', async () => {
  const server = new InternalHttpServer();
  server.register(PANEL_EVENT_DELIVERY_ROUTES.deliver, async () => ({
    accepted: true,
    deliveryId: 'event_outbox:dev:999',
  }));
  const port = await server.listen(0);
  const client = new PanelEventDeliveryHttpClient(new InternalHttpClient(`http://127.0.0.1:${port}`));
  try {
    await assert.rejects(
      client.deliver(SAMPLE),
      (err: unknown) => err instanceof InternalHttpError && err.code === 'bad_response',
    );
  } finally {
    await server.close();
  }
});
