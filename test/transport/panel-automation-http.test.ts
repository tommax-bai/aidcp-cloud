import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PanelAutomationReader } from '@kernel/kernel/panel-automation-types.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '@automation/transport/internal-http.js';
import {
  PANEL_AUTOMATION_ROUTES,
  PanelAutomationHttpClient,
  registerPanelAutomationRoutes,
} from '@automation/transport/panel-automation-http.js';

const ALL_METHODS = [
  'todayActionTotals',
  'todayActionTotalsByAccount',
  'todayLikeViewTotal',
  'riskStateProjection',
  'listAlerts',
  'listInteractions',
] as const satisfies readonly (keyof PanelAutomationReader)[];

interface SeenCalls {
  riskAccountIds: Array<string[] | undefined>;
  alertOptions: Array<{ limit?: number; includeResolved?: boolean } | undefined>;
  interactionOptions: Array<{ limit?: number; accountId?: string } | undefined>;
}

function projectionReader(seen: SeenCalls): PanelAutomationReader {
  return {
    todayActionTotals: async () => [
      { action: 'like', total: 7 },
      { action: 'view', total: 19 },
    ],
    todayActionTotalsByAccount: async () => [
      { accountId: 'acc-1', action: 'like', total: 3 },
      { accountId: 'acc-2', action: 'view', total: 11 },
    ],
    todayLikeViewTotal: async () => ({ likes: 7, views: 19 }),
    riskStateProjection: async (accountIds) => {
      seen.riskAccountIds.push(accountIds);
      return [
        {
          accountId: 'acc-1',
          status: 'warned',
          quotaLevel: null,
          signalCount: 2,
        },
      ];
    },
    listAlerts: async (options) => {
      seen.alertOptions.push(options);
      return [
        {
          alertId: 42,
          severity: 'warning',
          type: 'quota',
          accountId: null,
          title: 'Daily quota',
          detail: null,
          createdAt: 1_700_000_000_123,
          resolvedAt: 1_700_000_009_999,
        },
      ];
    },
    listInteractions: async (options) => {
      seen.interactionOptions.push(options);
      return [
        {
          accountId: 'acc-2',
          targetId: 'post-9',
          action: 'comment',
          title: null,
          url: 'https://example.test/post-9',
          interactedAt: 1_700_000_020_456,
        },
      ];
    },
  };
}

async function withReaderServer(
  reader: PanelAutomationReader,
  run: (client: PanelAutomationReader, raw: InternalHttpClient) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerPanelAutomationRoutes(server, reader);
  const listenPort = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${listenPort}`);
  const client: PanelAutomationReader = new PanelAutomationHttpClient(raw);
  try {
    await run(client, raw);
  } finally {
    await server.close();
  }
}

test('PanelAutomationHttpClient exposes the complete six-method reader surface', async () => {
  const seen: SeenCalls = { riskAccountIds: [], alertOptions: [], interactionOptions: [] };
  await withReaderServer(projectionReader(seen), async (client) => {
    for (const method of ALL_METHODS) {
      assert.equal(typeof client[method], 'function', `missing method: ${method}`);
    }
  });
});

test('all six projections round-trip every field and preserve filters', async () => {
  const seen: SeenCalls = { riskAccountIds: [], alertOptions: [], interactionOptions: [] };
  await withReaderServer(projectionReader(seen), async (client) => {
    assert.deepEqual(await client.todayActionTotals(), [
      { action: 'like', total: 7 },
      { action: 'view', total: 19 },
    ]);
    assert.deepEqual(await client.todayActionTotalsByAccount(), [
      { accountId: 'acc-1', action: 'like', total: 3 },
      { accountId: 'acc-2', action: 'view', total: 11 },
    ]);
    assert.deepEqual(await client.todayLikeViewTotal(), { likes: 7, views: 19 });

    assert.deepEqual(await client.riskStateProjection(['acc-1', 'missing']), [
      {
        accountId: 'acc-1',
        status: 'warned',
        quotaLevel: null,
        signalCount: 2,
      },
    ]);
    assert.deepEqual(
      await client.listAlerts({ limit: 17, includeResolved: true }),
      [
        {
          alertId: 42,
          severity: 'warning',
          type: 'quota',
          accountId: null,
          title: 'Daily quota',
          detail: null,
          createdAt: 1_700_000_000_123,
          resolvedAt: 1_700_000_009_999,
        },
      ],
    );
    assert.deepEqual(
      await client.listInteractions({ limit: 23, accountId: 'acc-2' }),
      [
        {
          accountId: 'acc-2',
          targetId: 'post-9',
          action: 'comment',
          title: null,
          url: 'https://example.test/post-9',
          interactedAt: 1_700_000_020_456,
        },
      ],
    );
  });

  assert.deepEqual(seen.riskAccountIds, [['acc-1', 'missing']]);
  assert.deepEqual(seen.alertOptions, [{ limit: 17, includeResolved: true }]);
  assert.deepEqual(seen.interactionOptions, [{ limit: 23, accountId: 'acc-2' }]);
});

test('omitted filters remain omitted across HTTP', async () => {
  const seen: SeenCalls = { riskAccountIds: [], alertOptions: [], interactionOptions: [] };
  await withReaderServer(projectionReader(seen), async (client) => {
    await client.riskStateProjection();
    await client.listAlerts();
    await client.listInteractions();
  });
  assert.deepEqual(seen, {
    riskAccountIds: [undefined],
    alertOptions: [undefined],
    interactionOptions: [undefined],
  });
});

test('every owner read failure stays an error instead of becoming zero or empty success', async () => {
  const fail = async (): Promise<never> => {
    throw Object.assign(new Error('automation projection unavailable'), {
      code: 'owner_read_failed',
    });
  };
  const failing: PanelAutomationReader = {
    todayActionTotals: fail,
    todayActionTotalsByAccount: fail,
    todayLikeViewTotal: fail,
    riskStateProjection: fail,
    listAlerts: fail,
    listInteractions: fail,
  };

  await withReaderServer(failing, async (client) => {
    const reads: Array<() => Promise<unknown>> = [
      () => client.todayActionTotals(),
      () => client.todayActionTotalsByAccount(),
      () => client.todayLikeViewTotal(),
      () => client.riskStateProjection(['acc-1']),
      () => client.listAlerts({ limit: 10 }),
      () => client.listInteractions({ accountId: 'acc-1' }),
    ];
    for (const read of reads) {
      await assert.rejects(read, (error: unknown) => {
        assert.ok(error instanceof InternalHttpError);
        assert.equal(error.code, 'owner_read_failed');
        assert.match(error.message, /automation projection unavailable/);
        return true;
      });
    }
  });
});

test('route constants are registered on the server', async () => {
  const seen: SeenCalls = { riskAccountIds: [], alertOptions: [], interactionOptions: [] };
  await withReaderServer(projectionReader(seen), async (_client, raw) => {
    const result = await raw.call<{ likes: number; views: number }>(
      PANEL_AUTOMATION_ROUTES.todayLikeViewTotal,
      {},
    );
    assert.deepEqual(result, { likes: 7, views: 19 });
  });
});
