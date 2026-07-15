import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { InteractionInternalApi } from '../../src/interactions/interaction-internal-api.js';
import type { InteractionStore } from '../../src/interactions/interaction-store.js';
import type { ReplyConfigStore } from '../../src/interactions/reply-config-store.js';
import type { ReplyWorkflow } from '../../src/interactions/reply-workflow.js';
import type { ReplyConfigSnapshot } from '../../src/interactions/types.js';

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
    const body = await response.json() as { data: { action: string }; meta: { asOf: number } };
    assert.equal(body.data.action, 'review_required');
    assert.equal(body.meta.asOf, 1784044800000);
    assert.equal(previewCalls, 1);
    assert.equal(auditCalls, 1);
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
