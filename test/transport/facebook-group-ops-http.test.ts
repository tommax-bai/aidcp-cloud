import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FacebookGroupOpsPort } from '../../src/kernel/facebook-group-ops-types.js';
import type {
  FacebookGroupAccountProgress,
  FacebookGroupJoinRecentScheduledResult,
  FacebookGroupMembershipRow,
  FacebookRegionCommentTemplateRow,
  FacebookGroupScopedTargetCount,
  FacebookGroupTargetFacets,
  FacebookGroupTargetListResult,
  FacebookGroupTargetRow,
} from '../../src/kernel/facebook-group-types.js';
import {
  FACEBOOK_GROUP_OPS_ROUTES,
  FacebookGroupOpsHttpClient,
  registerFacebookGroupOpsRoutes,
} from '../../src/transport/facebook-group-ops-http.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';

const ALL_METHODS = [
  'listTargets',
  'listFacets',
  'listRegionCommentTemplates',
  'setRegionCommentTemplates',
  'setEnabled',
  'accountProgress',
  'listAssignments',
  'reclaimStaleAssignments',
  'scopedTargetCountForAccount',
  'scopedTargetCountsForAccounts',
  'latestScheduledResult',
  'latestScheduledResults',
] as const satisfies readonly (keyof FacebookGroupOpsPort)[];

const TARGET: FacebookGroupTargetRow = {
  groupUrl: 'https://www.facebook.com/groups/group-1',
  groupName: 'Group 1',
  region: 'north',
  park: 'park-1',
  direction: 'export',
  joinGating: 'instant',
  priority: 2,
  enabled: true,
  accountScopeMode: 'restricted',
  importBatch: 'batch-1',
  createdAt: '2026-07-26T01:00:00.000Z',
  updatedAt: '2026-07-26T02:00:00.000Z',
};

const TARGETS: FacebookGroupTargetListResult = {
  items: [{
    ...TARGET,
    accountGroupLabels: ['sales'],
    accountId: 'acc-1',
    membershipStatus: 'joined',
    joinedAt: '2026-07-26T02:00:00.000Z',
    lastAttemptAt: '2026-07-26T01:30:00.000Z',
    lastReason: null,
    lastCommentedAt: null,
    commentsTotal: 3,
  }],
  total: 1,
};

const FACETS: FacebookGroupTargetFacets = {
  regions: [{ region: 'north', parks: ['park-1'] }],
  directions: ['export'],
  accountGroupLabels: ['sales'],
  globalTargetCount: 0,
  unscopedTargetCount: 0,
};

const REGION_TEMPLATE: FacebookRegionCommentTemplateRow = {
  region: 'north',
  commentTemplates: ['欢迎加入'],
  updatedAt: '2026-07-26T02:00:00.000Z',
  updatedBy: 'operator',
};

const PROGRESS: FacebookGroupAccountProgress = {
  accountId: 'acc-1',
  assigned: 1,
  joining: 0,
  joined: 1,
  pending: 0,
  gated: 0,
  failed: 0,
  lastJoinedAt: '2026-07-26T02:00:00.000Z',
  lastCommentedAt: null,
};

const ASSIGNMENT: FacebookGroupMembershipRow = {
  accountId: 'acc-1',
  groupUrl: TARGET.groupUrl,
  status: 'joined',
  assignedAt: '2026-07-26T01:00:00.000Z',
  joinedAt: '2026-07-26T02:00:00.000Z',
  lastAttemptAt: '2026-07-26T01:30:00.000Z',
  attempts: 1,
  lastReason: null,
  lastCommentedAt: null,
  cooldownUntil: null,
  commentsTotal: 3,
  leftConfirmations: 0,
  updatedAt: '2026-07-26T02:00:00.000Z',
};

const COUNT: FacebookGroupScopedTargetCount = {
  accountGroupLabel: 'sales',
  count: 7,
};

const RECENT: FacebookGroupJoinRecentScheduledResult = {
  outcome: 'joined',
  reason: null,
  groupUrl: TARGET.groupUrl,
  createdAt: '2026-07-26T02:00:00.000Z',
};

function stubPort(seen: { calls: unknown[] }): FacebookGroupOpsPort {
  return {
    listTargets: async (options) => {
      seen.calls.push({ m: 'listTargets', options });
      return TARGETS;
    },
    listFacets: async () => {
      seen.calls.push({ m: 'listFacets' });
      return FACETS;
    },
    listRegionCommentTemplates: async () => {
      seen.calls.push({ m: 'listRegionCommentTemplates' });
      return [REGION_TEMPLATE];
    },
    setRegionCommentTemplates: async (region, commentTemplates, updatedBy) => {
      seen.calls.push({
        m: 'setRegionCommentTemplates',
        region,
        commentTemplates,
        updatedBy,
      });
      return {
        ok: true,
        row: {
          ...REGION_TEMPLATE,
          region,
          commentTemplates,
          updatedBy,
        },
      };
    },
    setEnabled: async (groupUrl, enabled) => {
      seen.calls.push({ m: 'setEnabled', groupUrl, enabled });
      return { ...TARGET, groupUrl, enabled };
    },
    accountProgress: async () => {
      seen.calls.push({ m: 'accountProgress' });
      return [PROGRESS];
    },
    listAssignments: async (limit) => {
      seen.calls.push({ m: 'listAssignments', limit });
      return [ASSIGNMENT];
    },
    reclaimStaleAssignments: async (ttlMs) => {
      seen.calls.push({ m: 'reclaimStaleAssignments', ttlMs });
      return 4;
    },
    scopedTargetCountForAccount: async (accountId) => {
      seen.calls.push({ m: 'scopedTargetCountForAccount', accountId });
      return COUNT;
    },
    scopedTargetCountsForAccounts: async (accountIds) => {
      seen.calls.push({ m: 'scopedTargetCountsForAccounts', accountIds });
      return new Map(accountIds.map((accountId) => [accountId, { ...COUNT }]));
    },
    latestScheduledResult: async (accountId) => {
      seen.calls.push({ m: 'latestScheduledResult', accountId });
      return RECENT;
    },
    latestScheduledResults: async (accountIds) => {
      seen.calls.push({ m: 'latestScheduledResults', accountIds });
      return new Map(accountIds.map((accountId) => [accountId, { ...RECENT }]));
    },
  };
}

async function withPortServer(
  run: (
    port: FacebookGroupOpsPort,
    raw: InternalHttpClient,
    seen: { calls: unknown[] },
  ) => Promise<void>,
  localFactory: (seen: { calls: unknown[] }) => FacebookGroupOpsPort = stubPort,
): Promise<void> {
  const seen = { calls: [] as unknown[] };
  const server = new InternalHttpServer();
  registerFacebookGroupOpsRoutes(server, localFactory(seen));
  const listenPort = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${listenPort}`);
  const client: FacebookGroupOpsPort = new FacebookGroupOpsHttpClient(raw);
  try {
    await run(client, raw, seen);
  } finally {
    await server.close();
  }
}

test('client 只实现收窄后的十二个 operation，不可充当完整 facebookGroupTargets', async () => {
  await withPortServer(async (port) => {
    for (const method of ALL_METHODS) {
      assert.equal(typeof port[method], 'function', `missing method: ${method}`);
    }
    const surface = port as unknown as Record<string, unknown>;
    assert.equal(surface.importTargets, undefined);
    assert.equal(surface.replaceTargetScopes, undefined);
    assert.equal('importTargets' in FACEBOOK_GROUP_OPS_ROUTES, false);
    assert.equal('replaceTargetScopes' in FACEBOOK_GROUP_OPS_ROUTES, false);
  });
});

test('普通 operation 的参数和结果原样往返，省略可选参数仍保持 undefined', async () => {
  await withPortServer(async (port, _raw, seen) => {
    assert.deepEqual(await port.listTargets(), TARGETS);
    assert.deepEqual(await port.listFacets(), FACETS);
    assert.deepEqual(await port.listRegionCommentTemplates(), [REGION_TEMPLATE]);
    assert.deepEqual(
      await port.setRegionCommentTemplates('north', ['模板一', '模板二'], 'admin'),
      {
        ok: true,
        row: {
          ...REGION_TEMPLATE,
          commentTemplates: ['模板一', '模板二'],
          updatedBy: 'admin',
        },
      },
    );
    assert.deepEqual(await port.setEnabled(TARGET.groupUrl, false), {
      ...TARGET,
      enabled: false,
    });
    assert.deepEqual(await port.accountProgress(), [PROGRESS]);
    assert.deepEqual(await port.listAssignments(), [ASSIGNMENT]);
    assert.equal(await port.reclaimStaleAssignments(90_000), 4);
    assert.deepEqual(await port.scopedTargetCountForAccount('acc-1'), COUNT);
    assert.deepEqual(await port.latestScheduledResult('acc-1'), RECENT);

    assert.deepEqual(seen.calls, [
      { m: 'listTargets', options: undefined },
      { m: 'listFacets' },
      { m: 'listRegionCommentTemplates' },
      {
        m: 'setRegionCommentTemplates',
        region: 'north',
        commentTemplates: ['模板一', '模板二'],
        updatedBy: 'admin',
      },
      { m: 'setEnabled', groupUrl: TARGET.groupUrl, enabled: false },
      { m: 'accountProgress' },
      { m: 'listAssignments', limit: undefined },
      { m: 'reclaimStaleAssignments', ttlMs: 90_000 },
      { m: 'scopedTargetCountForAccount', accountId: 'acc-1' },
      { m: 'latestScheduledResult', accountId: 'acc-1' },
    ]);
  });
});

test('listTargets/listAssignments 的显式筛选参数不丢失', async () => {
  await withPortServer(async (port, _raw, seen) => {
    await port.listTargets({ limit: 20, offset: 5, enabled: true, status: 'joined' });
    await port.listAssignments(25);
    assert.deepEqual(seen.calls, [
      {
        m: 'listTargets',
        options: { limit: 20, offset: 5, enabled: true, status: 'joined' },
      },
      { m: 'listAssignments', limit: 25 },
    ]);
  });
});

test('批量 scope counts / recent results 在线上使用 entries，client 还原 Map', async () => {
  await withPortServer(async (port, raw, seen) => {
    const rawCounts = await raw.call<Array<[string, FacebookGroupScopedTargetCount]>>(
      FACEBOOK_GROUP_OPS_ROUTES.scopedTargetCountsForAccounts,
      { accountIds: ['acc-1', 'acc-2'] },
    );
    assert.deepEqual(rawCounts, [['acc-1', COUNT], ['acc-2', COUNT]]);

    const counts = await port.scopedTargetCountsForAccounts(['acc-3']);
    assert.equal(counts instanceof Map, true);
    assert.deepEqual([...counts.entries()], [['acc-3', COUNT]]);

    const rawRecent = await raw.call<Array<[string, FacebookGroupJoinRecentScheduledResult]>>(
      FACEBOOK_GROUP_OPS_ROUTES.latestScheduledResults,
      { accountIds: ['acc-1', 'acc-2'] },
    );
    assert.deepEqual(rawRecent, [['acc-1', RECENT], ['acc-2', RECENT]]);

    const recent = await port.latestScheduledResults(['acc-3']);
    assert.equal(recent instanceof Map, true);
    assert.deepEqual([...recent.entries()], [['acc-3', RECENT]]);

    assert.deepEqual(seen.calls, [
      { m: 'scopedTargetCountsForAccounts', accountIds: ['acc-1', 'acc-2'] },
      { m: 'scopedTargetCountsForAccounts', accountIds: ['acc-3'] },
      { m: 'latestScheduledResults', accountIds: ['acc-1', 'acc-2'] },
      { m: 'latestScheduledResults', accountIds: ['acc-3'] },
    ]);
  });
});

test('owner 错误跨线保留 code/message，不折叠为空结果', async () => {
  await withPortServer(
    async (port) => {
      await assert.rejects(
        port.reclaimStaleAssignments(1),
        (error: unknown) => {
          assert.equal(error instanceof InternalHttpError, true);
          assert.equal((error as InternalHttpError).code, 'owner_unavailable');
          assert.equal((error as Error).message, 'automation owner unavailable');
          return true;
        },
      );
    },
    () => ({
      ...stubPort({ calls: [] }),
      reclaimStaleAssignments: async () => {
        throw new InternalHttpError('owner_unavailable', 'automation owner unavailable');
      },
    }),
  );
});
