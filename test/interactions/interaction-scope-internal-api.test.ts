import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { InteractionScopeInternalApi } from '../../src/interactions/interaction-scope-internal-api.js';
import type { ReplyConfigResolver } from '../../src/interactions/reply-config-resolver.js';
import type { ReplyConfigScopeStore } from '../../src/interactions/reply-config-scope-store.js';
import type { ReplyWorkflow } from '../../src/interactions/reply-workflow.js';
import type { ReplyConfigScopeHead, ReplyConfigSnapshot } from '../../src/interactions/types.js';

const source = { type: 'group' as const, groupLabel: '华东组' };
const head: ReplyConfigScopeHead = {
  scopeId: 'scope-east', platform: 'wechat_channels', source, memberCount: 2,
  currentVersion: 3, draftVersion: 3, publishedVersion: 2, updatedAt: 1, updatedBy: 'admin',
};
const snapshot: ReplyConfigSnapshot = {
  accountId: '', configScopeId: head.scopeId, configSource: source, platform: 'wechat_channels',
  configVersion: 3, state: 'draft',
  policy: {
    mode: 'review_before_send', generateDrafts: true, sendReplies: true,
    channels: {
      comment: { enabled: true, aiPolishEnabled: false, allowAutoSend: false },
      dm: { enabled: false, aiPolishEnabled: false, allowAutoSend: false },
    },
    rateLimits: { accountPerMinute: 1, accountPerHour: 5, accountPerDay: 20,
      threadCooldownSeconds: 60, newLoginCooldownSeconds: 600, consecutiveFailureLimit: 3 },
  },
  templates: [], rules: [], profiles: [], createdAt: 1, createdBy: 'admin',
  publishedAt: null, publishedBy: null,
};

async function withApi(
  api: InteractionScopeInternalApi,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    void api.handle(req, res, 'admin').then((handled) => {
      if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('scope API lists default/group aggregates and exposes the resolver effective source without fallback', async () => {
  const api = new InteractionScopeInternalApi({
    scopes: {
      listScopes: async () => [{ ...head }, {
        scopeId: 'scope-default', platform: 'wechat_channels',
        source: { type: 'default', groupLabel: null }, memberCount: 1, currentVersion: 1,
        draftVersion: null, publishedVersion: 1, updatedAt: 1, updatedBy: 'admin',
      }],
    } as unknown as ReplyConfigScopeStore,
    resolver: {
      mode: 'scoped',
      resolve: async (accountId: string) => ({
        accountId, mode: 'scoped', status: 'missing', reason: 'group_config_missing', source,
        head: null, snapshot: null,
      }),
    } as unknown as ReplyConfigResolver,
    workflow: {} as ReplyWorkflow,
    grantsFor: () => new Set(['interaction.config.view']), cursorSecret: 'scope-api-test', clock: () => 9,
  });

  await withApi(api, async (base) => {
    const list = await fetch(`${base}/api/interaction-reply-config-scopes`);
    assert.equal(list.status, 200);
    const listBody = await list.json() as { data: { items: Array<{ source: { type: string }; memberCount: number }> } };
    assert.deepEqual(listBody.data.items.map((item) => [item.source.type, item.memberCount]), [['group', 2], ['default', 1]]);

    const effective = await fetch(`${base}/api/accounts/account-east/effective-reply-config`);
    assert.equal(effective.status, 200);
    const effectiveBody = await effective.json() as { data: Record<string, unknown> };
    assert.deepEqual(effectiveBody.data, {
      accountId: 'account-east', mode: 'scoped', status: 'missing', reason: 'group_config_missing', source,
      currentVersion: null, draftVersion: null, publishedVersion: null,
    });
  });
});

test('scope policy mutation is CAS-bound to the stable scope id', async () => {
  const writes: Array<{ scopeId: string; expectedVersion: number }> = [];
  const api = new InteractionScopeInternalApi({
    scopes: {
      getHead: async () => head,
      savePolicy: async (scopeId: string, expectedVersion: number) => {
        writes.push({ scopeId, expectedVersion });
        return { ...snapshot, configVersion: 4 };
      },
    } as unknown as ReplyConfigScopeStore,
    resolver: {} as ReplyConfigResolver,
    workflow: {} as ReplyWorkflow,
    grantsFor: () => new Set(['interaction.config.edit']), cursorSecret: 'scope-api-test', clock: () => 9,
  });

  await withApi(api, async (base) => {
    const response = await fetch(`${base}/api/interaction-reply-config-scopes/scope-east/policy`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 3, policy: snapshot.policy }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(writes, [{ scopeId: 'scope-east', expectedVersion: 3 }]);
  });
});

test('scope preview rejects a non-member before running the body-bearing preview workflow', async () => {
  let workflowCalls = 0;
  const api = new InteractionScopeInternalApi({
    scopes: {
      getHead: async () => head,
      accountMatchesScope: async () => false,
    } as unknown as ReplyConfigScopeStore,
    resolver: {} as ReplyConfigResolver,
    workflow: { buildPreview: async () => { workflowCalls += 1; throw new Error('must_not_run'); } } as unknown as ReplyWorkflow,
    grantsFor: () => new Set(['interaction.config.preview']), cursorSecret: 'scope-api-test', clock: () => 9,
  });

  await withApi(api, async (base) => {
    const response = await fetch(`${base}/api/interaction-reply-config-scopes/scope-east/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-other', expectedVersion: 3, use: 'draft', channel: 'comment', messageType: 'text',
        userMessage: '你好', videoTitle: null, userName: null,
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'INTERACTION_SCOPE_MISMATCH');
    assert.equal(workflowCalls, 0);
  });
});
