import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReplyConfigStore } from '../../src/interactions/reply-config-store.js';
import type { ReplyConfigScopeStore } from '../../src/interactions/reply-config-scope-store.js';
import { ReplyConfigResolver, replyConfigFingerprint } from '../../src/interactions/reply-config-resolver.js';
import type { ReplyConfigScopeHead, ReplyConfigSnapshot, ReplyConfigSource } from '../../src/interactions/types.js';

function snapshot(accountId: string, version: number, scopeId?: string, source?: ReplyConfigSource): ReplyConfigSnapshot {
  return {
    accountId,
    configScopeId: scopeId ?? null,
    configSource: source ?? null,
    platform: 'wechat_channels',
    configVersion: version,
    state: 'published',
    policy: {
      mode: 'review_before_send', generateDrafts: true, sendReplies: true,
      channels: {
        comment: { enabled: true, aiPolishEnabled: false, allowAutoSend: false },
        dm: { enabled: false, aiPolishEnabled: false, allowAutoSend: false },
      },
      rateLimits: { accountPerMinute: 1, accountPerHour: 5, accountPerDay: 20,
        threadCooldownSeconds: 60, newLoginCooldownSeconds: 600, consecutiveFailureLimit: 3 },
    },
    templates: [], rules: [], profiles: [], createdAt: 1, createdBy: 'admin', publishedAt: 2, publishedBy: 'admin',
  };
}

function head(scopeId: string, source: ReplyConfigSource, publishedVersion: number | null): ReplyConfigScopeHead {
  return {
    scopeId, platform: 'wechat_channels', source, memberCount: 1, currentVersion: publishedVersion ?? 0,
    draftVersion: null, publishedVersion, updatedAt: 1, updatedBy: 'admin',
  };
}

test('scoped resolver uses group exactly and never falls back to default', async () => {
  const group: ReplyConfigSource = { type: 'group', groupLabel: '华东组' };
  const defaultSource: ReplyConfigSource = { type: 'default', groupLabel: null };
  const scopes = {
    sourceForAccount: async () => group,
    getScopeBySource: async (source: ReplyConfigSource) => source.type === 'default'
      ? head('scope-default', defaultSource, 9) : null,
    getSnapshot: async () => snapshot('account-a', 9, 'scope-default', defaultSource),
  } as unknown as ReplyConfigScopeStore;
  const legacy = { getSnapshot: async () => snapshot('account-a', 3), getHead: async () => null } as unknown as ReplyConfigStore;
  const resolver = new ReplyConfigResolver(legacy, scopes, 'scoped');
  const resolved = await resolver.resolve('account-a');
  assert.equal(resolved.status, 'missing');
  assert.equal(resolved.reason, 'group_config_missing');
  assert.deepEqual(resolved.source, group);
  assert.equal(resolved.snapshot, null);
});

test('ungrouped account resolves the singleton default published snapshot', async () => {
  const source: ReplyConfigSource = { type: 'default', groupLabel: null };
  const published = snapshot('account-u', 4, 'scope-default', source);
  const scopes = {
    sourceForAccount: async () => source,
    getScopeBySource: async () => head('scope-default', source, 4),
    getSnapshot: async () => published,
  } as unknown as ReplyConfigScopeStore;
  const resolver = new ReplyConfigResolver({} as ReplyConfigStore, scopes, 'scoped');
  const resolved = await resolver.resolve('account-u');
  assert.equal(resolved.status, 'published');
  assert.equal(resolved.snapshot, published);
  assert.equal(resolved.source.type, 'default');
});

test('shadow executes legacy while reporting body-free fingerprint parity', async () => {
  const source: ReplyConfigSource = { type: 'group', groupLabel: 'A' };
  const legacySnapshot = snapshot('account-a', 2);
  const scopedSnapshot = { ...snapshot('account-a', 7, 'scope-a', source), createdAt: 999, createdBy: 'other' };
  const observations: unknown[] = [];
  const scopes = {
    sourceForAccount: async () => source,
    getScopeBySource: async () => head('scope-a', source, 7),
    getSnapshot: async () => scopedSnapshot,
  } as unknown as ReplyConfigScopeStore;
  const legacy = {
    getSnapshot: async () => legacySnapshot,
    getHead: async () => ({ currentVersion: 2, draftVersion: null, publishedVersion: 2 }),
  } as unknown as ReplyConfigStore;
  const resolver = new ReplyConfigResolver(legacy, scopes, 'shadow', {
    onShadowObservation: (value) => observations.push(value),
  });
  const resolved = await resolver.resolve('account-a');
  assert.equal(resolved.snapshot, legacySnapshot);
  assert.equal(replyConfigFingerprint(legacySnapshot), replyConfigFingerprint(scopedSnapshot));
  assert.deepEqual(observations, [{
    accountId: 'account-a', source, legacyVersion: 2, scopedVersion: 7, sameFingerprint: true,
  }]);
});

test('historical job lookup uses frozen scope id instead of current account grouping', async () => {
  const frozen = snapshot('account-a', 5, 'scope-old', { type: 'group', groupLabel: '旧组' });
  let loaded: unknown[] = [];
  const scopes = {
    getSnapshot: async (...args: unknown[]) => { loaded = args; return frozen; },
  } as unknown as ReplyConfigScopeStore;
  const resolver = new ReplyConfigResolver({} as ReplyConfigStore, scopes, 'scoped');
  assert.equal(await resolver.getSnapshotForJob('account-a', 'scope-old', 5), frozen);
  assert.deepEqual(loaded, ['scope-old', 5, 'account-a']);
});
