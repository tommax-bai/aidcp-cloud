import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { InteractionInternalApi } from '../../src/interactions/interaction-internal-api.js';
import type { InteractionStore } from '../../src/interactions/interaction-store.js';
import type { ReplyConfigStore } from '../../src/interactions/reply-config-store.js';
import type { ReplyWorkflow } from '../../src/interactions/reply-workflow.js';
import type { ReplyConfigSnapshot } from '../../src/interactions/types.js';

test('runtime-control CAS reports online delivery separately from persisted success', async () => {
  let updates = 0;
  let deliveries = 0;
  let edgeOnline = true;
  const controls = {
    accountId: 'acct_wc_demo', platform: 'wechat_channels' as const, envKey: 'env_wc_demo', version: 8,
    commentsReadEnabled: true, commentsReplyEnabled: false, dmReadEnabled: true,
    dmSendTextEnabled: false, dmSendImageEnabled: false as const, writePaused: true,
    consecutiveFailures: 3, circuitOpenedAt: 1784044790000, lastConfirmedAt: null,
    updatedAt: 1784044800000, updatedBy: 'admin',
  };
  const api = new InteractionInternalApi({
    store: {
      updateRuntimeControls: async () => { updates += 1; return controls; },
    } as unknown as InteractionStore,
    configs: {} as ReplyConfigStore,
    workflow: {} as ReplyWorkflow,
    grantsFor: () => new Set(['interaction.config.edit']),
    cursorSecret: 'internal-test-cursor-secret',
    onRuntimeControlsUpdated: async (value) => {
      deliveries += 1;
      assert.equal(value.version, 8);
      if (!edgeOnline) throw new Error('edge offline');
      return { delivered: 1 };
    },
    clock: () => 1784044800000,
  });
  const server = http.createServer((req, res) => { void api.handle(req, res, 'admin'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/accounts/acct_wc_demo/interaction-runtime-controls`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 7, commentsReadEnabled: true, commentsReplyEnabled: false,
        dmReadEnabled: true, dmSendTextEnabled: false, dmSendImageEnabled: false, writePaused: true }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: {
      version: number; circuitOpen: boolean; circuitOpenedAt: number | null; consecutiveFailures: number;
      edgeDelivery: { status: string; delivered: number };
    } };
    assert.equal(body.data.version, 8);
    assert.equal(body.data.circuitOpen, true);
    assert.equal(body.data.circuitOpenedAt, 1784044790000);
    assert.equal(body.data.consecutiveFailures, 3);
    assert.deepEqual(body.data.edgeDelivery, { status: 'enqueued', delivered: 1 });
    assert.equal(updates, 1);
    assert.equal(deliveries, 1);

    edgeOnline = false;
    const offline = await fetch(`http://127.0.0.1:${address.port}/api/accounts/acct_wc_demo/interaction-runtime-controls`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 8, commentsReadEnabled: true, commentsReplyEnabled: false,
        dmReadEnabled: true, dmSendTextEnabled: false, dmSendImageEnabled: false, writePaused: true }),
    });
    assert.equal(offline.status, 200, 'socket delivery failure must not roll back the authoritative CAS');
    const offlineBody = await offline.json() as { data: { edgeDelivery: { status: string; delivered: number } } };
    assert.deepEqual(offlineBody.data.edgeDelivery, { status: 'deferred', delivered: 0 });
    assert.equal(updates, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('scoped mode retires every account strategy route without reading legacy data', async () => {
  const api = new InteractionInternalApi({
    store: {} as InteractionStore,
    configs: new Proxy({}, {
      get() { throw new Error('retired_account_strategy_must_not_read_legacy_store'); },
    }) as ReplyConfigStore,
    workflow: new Proxy({}, {
      get() { throw new Error('retired_account_strategy_must_not_run_preview'); },
    }) as ReplyWorkflow,
    grantsFor: () => new Set(['interaction.config.view', 'interaction.config.edit']),
    cursorSecret: 'internal-test-cursor-secret',
    resolutionMode: 'scoped',
  });
  const server = http.createServer((req, res) => { void api.handle(req, res, 'admin'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    for (const path of ['interaction-reply-policy', 'reply-templates', 'reply-rules', 'reply-profile',
      'reply-preview', 'reply-config/initialize', 'reply-config/publish', 'reply-config/audit']) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/accounts/acct_wc_demo/${path}`);
      assert.equal(response.status, 410, path);
      const body = await response.json() as { error: { details?: { reason?: string } } };
      assert.equal(body.error.details?.reason, 'account_reply_config_retired');
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('missing reply config is initialized only by an explicit safe-draft action', async () => {
  let initializeCalls = 0;
  const snapshot = {
    accountId: 'acct_wc_demo', platform: 'wechat_channels', configVersion: 1, state: 'draft',
    policy: {
      mode: 'draft_only', generateDrafts: false, sendReplies: false,
      channels: {
        comment: { enabled: false, aiPolishEnabled: false, allowAutoSend: false },
        dm: { enabled: false, aiPolishEnabled: false, allowAutoSend: false },
      },
      rateLimits: { accountPerMinute: 0, accountPerHour: 0, accountPerDay: 0,
        threadCooldownSeconds: 60, newLoginCooldownSeconds: 600, consecutiveFailureLimit: 3 },
    },
    templates: [], rules: [], profiles: [], createdAt: 1, createdBy: 'admin', publishedAt: null, publishedBy: null,
  } satisfies ReplyConfigSnapshot;
  const api = new InteractionInternalApi({
    store: {} as InteractionStore,
    configs: {
      initialize: async (_accountId: string, expected: number) => {
        initializeCalls += 1;
        assert.equal(expected, 0);
        return snapshot;
      },
      getHead: async () => ({ accountId: 'acct_wc_demo', platform: 'wechat_channels', currentVersion: 1,
        draftVersion: 1, publishedVersion: null, updatedAt: 1, updatedBy: 'admin' }),
    } as unknown as ReplyConfigStore,
    workflow: {} as ReplyWorkflow,
    grantsFor: () => new Set(['interaction.config.edit']),
    cursorSecret: 'internal-test-cursor-secret',
    clock: () => 1784044800000,
  });
  const server = http.createServer((req, res) => { void api.handle(req, res, 'admin'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api/accounts/acct_wc_demo/reply-config/initialize`;
    const invalid = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1 }) });
    assert.equal(invalid.status, 422);
    assert.equal(initializeCalls, 0);

    const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 0 }) });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { head: { currentVersion: number; draftVersion: number; publishedVersion: null }; initializedVersion: number } };
    assert.deepEqual(body.data, {
      head: { accountId: 'acct_wc_demo', platform: 'wechat_channels', currentVersion: 1, draftVersion: 1,
        publishedVersion: null, updatedAt: 1, updatedBy: 'admin' },
      initializedVersion: 1,
    });
    assert.equal(initializeCalls, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('Console preview is read-only: no reply job and no WS command are created', async () => {
  const snapshot = {
    accountId: 'acct_wc_demo', platform: 'wechat_channels', configVersion: 7, state: 'draft',
    policy: {
      mode: 'review_before_send', generateDrafts: true, sendReplies: true,
      channels: {
        comment: { enabled: true, aiPolishEnabled: true, allowAutoSend: false },
        dm: { enabled: true, aiPolishEnabled: true, allowAutoSend: false },
      },
      rateLimits: { accountPerMinute: 1, accountPerHour: 5, accountPerDay: 20,
        threadCooldownSeconds: 60, newLoginCooldownSeconds: 600, consecutiveFailureLimit: 3 },
    },
    templates: [], rules: [], profiles: [], createdAt: 1, createdBy: 'admin', publishedAt: null, publishedBy: null,
  } satisfies ReplyConfigSnapshot;
  let previewCalls = 0;
  let auditCalls = 0;
  const forbiddenStore = new Proxy({}, {
    get() { throw new Error('preview_must_not_touch_interaction_store'); },
  }) as InteractionStore;
  const api = new InteractionInternalApi({
    store: forbiddenStore,
    configs: {
      getHead: async () => ({ accountId: 'acct_wc_demo', platform: 'wechat_channels', currentVersion: 7,
        draftVersion: 7, publishedVersion: null, updatedAt: 1, updatedBy: 'admin' }),
      getSnapshot: async () => snapshot,
      recordPreview: async () => { auditCalls += 1; },
    } as unknown as ReplyConfigStore,
    workflow: {
      buildPreview: async () => {
        previewCalls += 1;
        return {
          matchedRuleId: 'rule-thanks', templateId: 'tpl-thanks', templateVersion: 2,
          renderedText: '谢谢。', polishedText: '谢谢你的喜欢。', finalText: '谢谢你的喜欢。',
          riskLevel: 'low' as const, riskReasons: [], requiresApproval: true,
          meaningChanged: false, introducedClaims: [], reviewReasons: [],
          fallbacks: { classifier: 'none' as const, polisher: 'none' as const, reviewer: 'none' as const },
        };
      },
    } as unknown as ReplyWorkflow,
    grantsFor: () => new Set(['interaction.config.preview']),
    cursorSecret: 'internal-test-cursor-secret',
    clock: () => 1784044800000,
  });
  const server = http.createServer((req, res) => {
    void api.handle(req, res, 'admin').then((handled) => {
      if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/accounts/acct_wc_demo/reply-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 7, use: 'draft', channel: 'comment', messageType: 'text',
        userMessage: '谢谢分享', videoTitle: '示例视频', userName: '小王' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      data: { action: string; polish: { fallbackUsed: boolean; fallbackReason: string } };
      meta: { asOf: number };
    };
    assert.equal(body.data.action, 'review_required');
    assert.equal(body.data.polish.fallbackUsed, false);
    assert.equal(body.data.polish.fallbackReason, 'none');
    assert.equal(body.meta.asOf, 1784044800000);
    assert.equal(previewCalls, 1);
    assert.equal(auditCalls, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('preview contexts expose only account-scoped inbound fields and return an empty list without a binding', async () => {
  const calls: Array<{ accountId: string; channel: string; limit: number }> = [];
  let empty = false;
  const api = new InteractionInternalApi({
    store: {
      listReplyPreviewContexts: async (accountId: string, channel: string, limit: number) => {
        calls.push({ accountId, channel, limit });
        return empty ? [] : [{
          threadId: 'thread-a', messageId: 'message-a', channel: 'comment' as const, messageType: 'text' as const,
          userMessage: '这双靴子还有吗', userName: '清', videoTitle: '血小板的cos', receivedAt: 1_784_044_802_000,
        }];
      },
    } as unknown as InteractionStore,
    configs: {} as ReplyConfigStore,
    workflow: {} as ReplyWorkflow,
    grantsFor: () => new Set(['interaction.config.preview']),
    cursorSecret: 'internal-test-cursor-secret',
    clock: () => 1_784_044_803_000,
  });
  const server = http.createServer((req, res) => { void api.handle(req, res, 'admin'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api/accounts/acct_wc_demo/reply-preview-contexts`;
    const response = await fetch(`${base}?channel=comment&limit=10`);
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { accountId: string; items: Array<Record<string, unknown>> } };
    assert.equal(body.data.accountId, 'acct_wc_demo');
    assert.deepEqual(body.data.items, [{
      threadId: 'thread-a', messageId: 'message-a', channel: 'comment', messageType: 'text',
      userMessage: '这双靴子还有吗', userName: '清', videoTitle: '血小板的cos', receivedAt: 1_784_044_802_000,
    }]);
    assert.equal('externalThreadId' in body.data.items[0], false);
    assert.deepEqual(calls, [{ accountId: 'acct_wc_demo', channel: 'comment', limit: 10 }]);

    empty = true;
    const emptyResponse = await fetch(`${base}?channel=comment`);
    assert.equal(emptyResponse.status, 200);
    const emptyBody = await emptyResponse.json() as { data: { items: unknown[] } };
    assert.deepEqual(emptyBody.data.items, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('DM preview contexts require full-text permission before the store is read', async () => {
  let storeReads = 0;
  const api = new InteractionInternalApi({
    store: {
      listReplyPreviewContexts: async () => { storeReads += 1; return []; },
    } as unknown as InteractionStore,
    configs: {} as ReplyConfigStore,
    workflow: {} as ReplyWorkflow,
    grantsFor: () => new Set(['interaction.config.preview']),
    cursorSecret: 'internal-test-cursor-secret',
  });
  const server = http.createServer((req, res) => { void api.handle(req, res, 'admin'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/accounts/acct_wc_demo/reply-preview-contexts?channel=dm`,
    );
    assert.equal(response.status, 403);
    assert.equal(storeReads, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('internal config reads fall back to the published snapshot after publish clears draftVersion', async () => {
  let selector: unknown;
  const published = {
    accountId: 'acct_wc_demo', platform: 'wechat_channels', configVersion: 8, state: 'published',
    policy: {
      mode: 'draft_only', generateDrafts: false, sendReplies: false,
      channels: { comment: { enabled: false, aiPolishEnabled: false, allowAutoSend: false },
        dm: { enabled: false, aiPolishEnabled: false, allowAutoSend: false } },
      rateLimits: { accountPerMinute: 0, accountPerHour: 0, accountPerDay: 0,
        threadCooldownSeconds: 60, newLoginCooldownSeconds: 600, consecutiveFailureLimit: 3 },
    },
    templates: [], rules: [], profiles: [], createdAt: 1, createdBy: 'admin', publishedAt: 2, publishedBy: 'admin',
  } satisfies ReplyConfigSnapshot;
  const api = new InteractionInternalApi({
    store: {} as InteractionStore,
    configs: {
      getHead: async () => ({ accountId: 'acct_wc_demo', platform: 'wechat_channels', currentVersion: 8,
        draftVersion: null, publishedVersion: 8, updatedAt: 2, updatedBy: 'admin' }),
      getSnapshot: async (_accountId: string, value: unknown) => { selector = value; return published; },
    } as unknown as ReplyConfigStore,
    workflow: {} as ReplyWorkflow,
    grantsFor: () => new Set(['interaction.config.view']),
    cursorSecret: 'internal-test-cursor-secret',
    clock: () => 3,
  });
  const server = http.createServer((req, res) => { void api.handle(req, res, 'admin'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/accounts/acct_wc_demo/interaction-reply-policy`);
    assert.equal(response.status, 200);
    assert.equal(selector, 'published');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
