import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  API_DIRECT_CONTRACT_VERSION,
  type AutomationPublishLogPort,
  type EdgePublishCommandPort,
  type InteractionApiWritesPort,
  type InteractionAuthAuthorityPort,
  type ReplyConfigResolverPort,
} from '@kernel/kernel/api-direct-port.js';
import {
  AUTOMATION_PUBLISH_LOG_ROUTES,
  EDGE_PUBLISH_COMMAND_ROUTES,
  INTERACTION_API_WRITES_ROUTES,
  INTERACTION_AUTH_ROUTES,
  REPLY_CONFIG_RESOLVER_ROUTES,
  AutomationPublishLogHttpClient,
  EdgePublishCommandHttpClient,
  InteractionApiWritesHttpClient,
  InteractionAuthHttpClient,
  ReplyConfigResolverHttpClient,
  registerAutomationPublishLogRoutes,
  registerEdgePublishCommandRoutes,
  registerInteractionApiWritesRoutes,
  registerInteractionAuthRoutes,
  registerReplyConfigResolverRoutes,
} from '@automation/transport/api-publish-interaction-http.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '@automation/transport/internal-http.js';
import { ApiDirectHttpError } from '@automation/transport/api-direct-http-common.js';

const TOKEN = 'api-publish-interaction-token';

function makePublishPort(
  overrides: Partial<AutomationPublishLogPort> = {},
): AutomationPublishLogPort {
  return {
    async loadForDispatch() { return null; },
    async updateStatus() {},
    async updatePostId() {},
    async markScheduled() {},
    async markImagesAttached() {},
    async listDueScheduled() { return []; },
    async deferScheduledReconcile() { return null; },
    async confirmScheduledPublished() { return false; },
    async getMostRecentPublishTime() { return null; },
    async recentPublishedContents() { return []; },
    async editDraft() { return { ok: false, reason: 'not_found' }; },
    async rejectPendingApproval() { return false; },
    async pendingApprovalForAccount() { return null; },
    async pendingPublishPreviewForAccount() { return null; },
    async lastPublishedForAccount() { return null; },
    async countPendingForAccount() { return 0; },
    async countPendingAutonomousForAccount() { return 0; },
    async countPublishedTodayForAccount() { return 0; },
    async countPublishedSinceForAccount() { return 0; },
    ...overrides,
  };
}

test('publish/interaction route tables preserve independent 19/2/2/3/3 capability faces', () => {
  assert.equal(Object.keys(AUTOMATION_PUBLISH_LOG_ROUTES).length, 19);
  assert.equal(Object.keys(EDGE_PUBLISH_COMMAND_ROUTES).length, 2);
  assert.equal(Object.keys(INTERACTION_AUTH_ROUTES).length, 2);
  assert.equal(Object.keys(INTERACTION_API_WRITES_ROUTES).length, 3);
  assert.equal(Object.keys(REPLY_CONFIG_RESOLVER_ROUTES).length, 3);
});

test('publish/interaction clients preserve legitimate null, count, audit dedupe and exact purge count', async () => {
  const publish: AutomationPublishLogPort = {
    async loadForDispatch() { return null; },
    async updateStatus() {},
    async updatePostId() {},
    async markScheduled() {},
    async markImagesAttached() {},
    async listDueScheduled() {
      return [{
        recordId: 4,
        accountId: 'acct-1',
        title: 'scheduled',
        scheduledAt: 1_000,
        scheduledPlatformId: null,
        reconcileAttempts: 2,
      }];
    },
    async deferScheduledReconcile() {
      return { status: 'scheduled', attempts: 3 };
    },
    async confirmScheduledPublished() { return true; },
    async getMostRecentPublishTime() { return 900; },
    async recentPublishedContents() { return ['first', 'second']; },
    async editDraft() { return { ok: false, reason: 'version_conflict' }; },
    async rejectPendingApproval() { return false; },
    async pendingApprovalForAccount() { return null; },
    async pendingPublishPreviewForAccount() { return null; },
    async lastPublishedForAccount() { return null; },
    async countPendingForAccount() { return 3; },
    async countPendingAutonomousForAccount() { return 2; },
    async countPublishedTodayForAccount() { return 4; },
    async countPublishedSinceForAccount() { return 5; },
  };
  const edge: EdgePublishCommandPort = {
    async removeDraftImage(input) {
      return { requestId: input.payload.requestId, ok: false, reason: 'not_found' };
    },
    async decidePublishApproval(input) {
      return { requestId: input.payload.requestId, ok: true, state: 'approved' };
    },
  };
  const auth: InteractionAuthAuthorityPort = {
    async authorizeAuthStateWrite(input) {
      return {
        ok: true,
        receipt: {
          platform: input.platform,
          accountId: input.accountId,
          envKey: input.envKey,
          issuedAt: input.now,
          expiresAt: input.now + input.ttlMs,
          environmentSerialization: 'registered',
        },
      };
    },
    async checkAccountScope() { return { ok: true }; },
  };
  const writes: InteractionApiWritesPort = {
    async insertAuditEvent() { return { outcome: 'duplicate' }; },
    async purgeReplyConfigForAccount() { return { removedRows: 7 }; },
    async purgeExpiredAuditEvents() { return { removedRows: 11 }; },
  };
  const reply: ReplyConfigResolverPort = {
    async resolve(accountId) {
      return {
        accountId,
        mode: 'scoped',
        status: 'missing',
        reason: 'account_not_found',
        source: { type: 'default', groupLabel: null },
        head: null,
        snapshot: null,
      };
    },
    async getPublished() { return null; },
    async getSnapshotForJob() { return null; },
  };
  const server = new InternalHttpServer();
  registerAutomationPublishLogRoutes(server, publish, TOKEN, 'dev');
  registerEdgePublishCommandRoutes(server, edge, TOKEN, 'dev');
  registerInteractionAuthRoutes(server, auth, TOKEN, 'dev');
  registerInteractionApiWritesRoutes(server, writes, TOKEN, 'dev');
  registerReplyConfigResolverRoutes(server, reply, TOKEN, 'dev');
  const port = await server.listen(0);
  try {
    const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
    const publishClient = new AutomationPublishLogHttpClient(http, TOKEN, 'dev');
    assert.equal(await publishClient.loadForDispatch(1), null);
    await publishClient.updateStatus(4, 'submitted');
    await publishClient.updatePostId(4, 'post-4', null);
    await publishClient.markScheduled(4, 1_000, null);
    await publishClient.markImagesAttached(4, 2);
    assert.deepEqual(await publishClient.listDueScheduled(20, 1_000), [{
      recordId: 4,
      accountId: 'acct-1',
      title: 'scheduled',
      scheduledAt: 1_000,
      scheduledPlatformId: null,
      reconcileAttempts: 2,
    }]);
    assert.deepEqual(
      await publishClient.deferScheduledReconcile(4, 'pending', 2_000, 8),
      { status: 'scheduled', attempts: 3 },
    );
    assert.equal(
      await publishClient.confirmScheduledPublished(
        4,
        'post-4',
        'https://example.test/post-4',
      ),
      true,
    );
    assert.equal(await publishClient.getMostRecentPublishTime(), 900);
    assert.deepEqual(await publishClient.recentPublishedContents(2), [
      'first',
      'second',
    ]);
    assert.equal(await publishClient.countPendingForAccount('acct-1'), 3);
    const edgeClient = new EdgePublishCommandHttpClient(http, TOKEN, 'dev');
    assert.deepEqual(
      await edgeClient.removeDraftImage({
        payload: {
          requestId: 'publish-1',
          contentVersion: 1,
          imageUrl: 'https://img.test/1.png',
        },
        session: { accountId: 'acct-1' },
      }),
      { requestId: 'publish-1', ok: false, reason: 'not_found' },
    );
    const authClient = new InteractionAuthHttpClient(http, TOKEN, 'dev');
    assert.equal(
      (await authClient.authorizeAuthStateWrite({
        platform: 'wechat_channels',
        accountId: 'acct-1',
        envKey: 'env-1',
        now: 100,
        ttlMs: 1000,
      })).ok,
      true,
    );
    const writesClient = new InteractionApiWritesHttpClient(http, TOKEN, 'dev');
    assert.deepEqual(
      await writesClient.insertAuditEvent({
        eventId: 'event-1',
        platform: 'wechat_channels',
        accountId: 'acct-1',
        envKey: null,
        actor: 'system',
        action: 'sync',
        configVersion: null,
        entityType: 'config',
        entityId: null,
        summary: 'sync',
        labels: {},
        createdAt: 100,
      }),
      { outcome: 'duplicate' },
    );
    assert.deepEqual(await writesClient.purgeReplyConfigForAccount('acct-1'), {
      removedRows: 7,
    });
    const replyClient = new ReplyConfigResolverHttpClient(http, TOKEN, 'dev');
    assert.equal((await replyClient.resolve('acct-1')).status, 'missing');
    assert.equal(await replyClient.getPublished('acct-1'), null);
    assert.equal(await replyClient.getSnapshotForJob('acct-1', 'scope-1', 1), null);
  } finally {
    await server.close();
  }
});

test('method parsers reject malformed nested payloads before owner handlers', async () => {
  const calls = { publish: 0, edge: 0, auth: 0, audit: 0 };
  const server = new InternalHttpServer();
  registerAutomationPublishLogRoutes(
    server,
    {
      async loadForDispatch() { calls.publish += 1; return null; },
      async updateStatus() { calls.publish += 1; },
      async updatePostId() { calls.publish += 1; },
      async markScheduled() { calls.publish += 1; },
      async markImagesAttached() { calls.publish += 1; },
      async listDueScheduled() { calls.publish += 1; return []; },
      async deferScheduledReconcile() { calls.publish += 1; return null; },
      async confirmScheduledPublished() { calls.publish += 1; return false; },
      async getMostRecentPublishTime() { calls.publish += 1; return null; },
      async recentPublishedContents() { calls.publish += 1; return []; },
      async editDraft() { calls.publish += 1; return { ok: false, reason: 'not_found' }; },
      async rejectPendingApproval() { calls.publish += 1; return false; },
      async pendingApprovalForAccount() { calls.publish += 1; return null; },
      async pendingPublishPreviewForAccount() { calls.publish += 1; return null; },
      async lastPublishedForAccount() { calls.publish += 1; return null; },
      async countPendingForAccount() { calls.publish += 1; return 0; },
      async countPendingAutonomousForAccount() { calls.publish += 1; return 0; },
      async countPublishedTodayForAccount() { calls.publish += 1; return 0; },
      async countPublishedSinceForAccount() { calls.publish += 1; return 0; },
    },
    TOKEN,
    'dev',
  );
  registerEdgePublishCommandRoutes(
    server,
    {
      async removeDraftImage(input) {
        calls.edge += 1;
        return { requestId: input.payload.requestId, ok: true };
      },
      async decidePublishApproval(input) {
        calls.edge += 1;
        return { requestId: input.payload.requestId, ok: true };
      },
    },
    TOKEN,
    'dev',
  );
  registerInteractionAuthRoutes(
    server,
    {
      async authorizeAuthStateWrite() {
        calls.auth += 1;
        return { ok: false, reason: 'account_not_found' };
      },
      async checkAccountScope() {
        calls.auth += 1;
        return { ok: true };
      },
    },
    TOKEN,
    'dev',
  );
  registerInteractionApiWritesRoutes(
    server,
    {
      async insertAuditEvent() {
        calls.audit += 1;
        return { outcome: 'inserted' };
      },
      async purgeReplyConfigForAccount() { return { removedRows: 0 }; },
      async purgeExpiredAuditEvents() { return { removedRows: 0 }; },
    },
    TOKEN,
    'dev',
  );
  const port = await server.listen(0);
  try {
    const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
    const envelope = (input: unknown) => ({
      version: API_DIRECT_CONTRACT_VERSION,
      executionTarget: 'dev',
      input,
    });
    for (const [route, input] of [
      [
        AUTOMATION_PUBLISH_LOG_ROUTES.updateStatus,
        { id: 1, status: 'unknown' },
      ],
      [
        AUTOMATION_PUBLISH_LOG_ROUTES.updatePostId,
        { id: 1, postId: '' },
      ],
      [
        AUTOMATION_PUBLISH_LOG_ROUTES.markScheduled,
        { id: 1, scheduledAt: Number.POSITIVE_INFINITY },
      ],
      [
        AUTOMATION_PUBLISH_LOG_ROUTES.markImagesAttached,
        { id: 1, count: -1 },
      ],
      [
        AUTOMATION_PUBLISH_LOG_ROUTES.listDueScheduled,
        { limit: 0, now: 1_000 },
      ],
      [
        AUTOMATION_PUBLISH_LOG_ROUTES.deferScheduledReconcile,
        { id: 1, error: 7, nextAt: 2_000 },
      ],
      [
        AUTOMATION_PUBLISH_LOG_ROUTES.confirmScheduledPublished,
        { id: 1, postId: 'post-1', postUrl: '' },
      ],
      [
        AUTOMATION_PUBLISH_LOG_ROUTES.recentPublishedContents,
        { limit: 1.5 },
      ],
      [
        EDGE_PUBLISH_COMMAND_ROUTES.removeDraftImage,
        { payload: { requestId: 'publish-1', contentVersion: '1' }, session: {} },
      ],
      [
        INTERACTION_AUTH_ROUTES.authorizeAuthStateWrite,
        { platform: 'wechat_channels', accountId: 'acct-1', envKey: 'env-1', now: 1, ttlMs: 0 },
      ],
      [
        INTERACTION_API_WRITES_ROUTES.insertAuditEvent,
        {
          eventId: 'event-1',
          platform: 'wechat_channels',
          accountId: 'acct-1',
          envKey: null,
          actor: 'system',
          action: 'sync',
          configVersion: null,
          entityType: 'config',
          entityId: null,
          summary: 'sync',
          labels: [],
          createdAt: 1,
        },
      ],
    ] as const) {
      await assert.rejects(
        () => http.callBearer(route, envelope(input), TOKEN),
        (error: unknown) =>
          error instanceof InternalHttpError &&
          error.code === 'api_direct_invalid_request',
      );
    }
    assert.deepEqual(calls, { publish: 0, edge: 0, auth: 0, audit: 0 });
  } finally {
    await server.close();
  }
});

test('publish routes reject wrong bearer and target before owner writes', async () => {
  let writes = 0;
  const server = new InternalHttpServer();
  registerAutomationPublishLogRoutes(
    server,
    makePublishPort({
      async updateStatus() {
        writes += 1;
      },
    }),
    TOKEN,
    'dev',
  );
  const port = await server.listen(0);
  try {
    const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
    const envelope = {
      version: API_DIRECT_CONTRACT_VERSION,
      executionTarget: 'dev',
      input: { id: 1, status: 'submitted' },
    };
    await assert.rejects(
      () =>
        http.callBearer(
          AUTOMATION_PUBLISH_LOG_ROUTES.updateStatus,
          envelope,
          'wrong-token',
        ),
      (error: unknown) =>
        error instanceof InternalHttpError
        && error.code === 'internal_http_unauthorized',
    );
    await assert.rejects(
      () =>
        http.callBearer(
          AUTOMATION_PUBLISH_LOG_ROUTES.updateStatus,
          { ...envelope, executionTarget: 'ol' },
          TOKEN,
        ),
      (error: unknown) =>
        error instanceof InternalHttpError
        && error.code === 'api_direct_target_mismatch',
    );
    assert.equal(writes, 0);
  } finally {
    await server.close();
  }
});

test('publish clients validate scheduled/read responses and preserve write result unknown', async () => {
  const validScheduled = {
    recordId: 1,
    accountId: 'acct-1',
    title: 'scheduled',
    scheduledAt: 1_000,
    scheduledPlatformId: null,
    reconcileAttempts: 0,
  };
  const malformedScheduled: Array<[string, Record<string, unknown>]> = [
    ['recordId', { recordId: 0 }],
    ['accountId', { accountId: '' }],
    ['title', { title: null }],
    ['scheduledAt', { scheduledAt: Number.POSITIVE_INFINITY }],
    ['scheduledPlatformId', { scheduledPlatformId: 1 }],
    ['reconcileAttempts', { reconcileAttempts: -1 }],
  ];
  for (const [label, patch] of malformedScheduled) {
    const http = {
      async callBearer() {
        return [{ ...validScheduled, ...patch }];
      },
    } as unknown as InternalHttpClient;
    await assert.rejects(
      () =>
        new AutomationPublishLogHttpClient(
          http,
          TOKEN,
          'dev',
        ).listDueScheduled(),
      (error: unknown) =>
        error instanceof ApiDirectHttpError
        && error.code === 'api_authority_bad_response',
      label,
    );
  }

  for (const [label, invoke] of [
    [
      'void mutation ack',
      (client: AutomationPublishLogHttpClient) =>
        client.updateStatus(1, 'submitted'),
    ],
    [
      'scheduled reconcile result',
      (client: AutomationPublishLogHttpClient) =>
        client.deferScheduledReconcile(1, 'pending', 2_000),
    ],
    [
      'scheduled confirmation result',
      (client: AutomationPublishLogHttpClient) =>
        client.confirmScheduledPublished(1, 'post-1', 'https://example.test/1'),
    ],
  ] as const) {
    const http = {
      async callBearer() {
        return { malformed: true };
      },
    } as unknown as InternalHttpClient;
    await assert.rejects(
      () => invoke(new AutomationPublishLogHttpClient(http, TOKEN, 'dev')),
      (error: unknown) =>
        error instanceof ApiDirectHttpError
        && error.code === 'api_authority_result_unknown',
      label,
    );
  }

  const readCases: Array<[
    string,
    unknown,
    (client: AutomationPublishLogHttpClient) => Promise<unknown>,
  ]> = [
    [
      'most recent time',
      Number.POSITIVE_INFINITY,
      (client) => client.getMostRecentPublishTime(),
    ],
    [
      'recent contents',
      ['valid', 2],
      (client) => client.recentPublishedContents(),
    ],
  ];
  for (const [label, result, invoke] of readCases) {
    const http = {
      async callBearer() {
        return result;
      },
    } as unknown as InternalHttpClient;
    await assert.rejects(
      () => invoke(new AutomationPublishLogHttpClient(http, TOKEN, 'dev')),
      (error: unknown) =>
        error instanceof ApiDirectHttpError
        && error.code === 'api_authority_bad_response',
      label,
    );
  }

  const timeoutHttp = {
    async callBearer() {
      throw new InternalHttpError('timeout', 'timed out');
    },
  } as unknown as InternalHttpClient;
  const timeoutClient = new AutomationPublishLogHttpClient(
    timeoutHttp,
    TOKEN,
    'dev',
  );
  await assert.rejects(
    () => timeoutClient.updateStatus(1, 'failed'),
    (error: unknown) =>
      error instanceof ApiDirectHttpError
      && error.code === 'api_authority_result_unknown',
  );
  await assert.rejects(
    () => timeoutClient.getMostRecentPublishTime(),
    (error: unknown) =>
      error instanceof ApiDirectHttpError
      && error.code === 'api_authority_unavailable',
  );
});
