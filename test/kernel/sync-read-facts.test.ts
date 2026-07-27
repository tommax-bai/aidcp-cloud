import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSyncReadFactPayload } from '../../src/kernel/sync-read-facts.js';

test('gate payload validators reject malformed nested fields instead of accepting array-shaped data', () => {
  assert.equal(
    isSyncReadFactPayload('automation_config_mirror_health', {
      sourceService: 'automation',
      asOf: 1,
      enabled: true,
      pollMs: 1_000,
      entries: [{ mirrorKey: 'x', tier: 'gate', state: 'fresh' }],
    }),
    false,
  );
  assert.equal(
    isSyncReadFactPayload('content_schedule', {
      global: { contentActiveMask: null },
      accounts: [{ accountId: 'a', autoEnabled: true }],
    }),
    false,
  );
  assert.equal(
    isSyncReadFactPayload('facebook_comment_config', {
      accounts: [{ accountId: 'a', keywords: 'not-an-array' }],
    }),
    false,
  );
  assert.equal(
    isSyncReadFactPayload('facebook_comment_config', {
      accounts: [{
        accountId: 'a',
        keywords: ['coffee'],
        containers: [],
        commentMode: 'templates',
        commentTemplates: [],
      }],
    }),
    false,
    '显式方案状态缺失时不得把快照当成完整权威',
  );
  assert.equal(
    isSyncReadFactPayload('facebook_comment_config', {
      accounts: [{
        accountId: 'a',
        keywords: ['coffee'],
        containers: [],
        commentMode: 'templates',
        commentModeConfigured: false,
        commentTemplates: [],
      }],
    }),
    true,
  );
  assert.equal(
    isSyncReadFactPayload('facebook_group_join_automation_config', {
      accounts: [{ accountId: 'a', enabled: 'yes', dailyCap: -1, weekMask: null }],
    }),
    false,
  );
});

test('runtime and shared payload validators enforce semantic count and identity invariants', () => {
  assert.equal(
    isSyncReadFactPayload('captcha_availability', {
      state: ['available'],
    }),
    false,
  );
  assert.equal(
    isSyncReadFactPayload('edge_presence', {
      edgeCount: 1,
      onlineEdgeCount: 2,
      accountEdges: [],
    }),
    false,
  );
  assert.equal(
    isSyncReadFactPayload('publish_in_flight', { recordIds: [7, 7] }),
    false,
  );
  assert.equal(
    isSyncReadFactPayload('account_persona', {
      accounts: [
        { accountId: 'a', personaText: 'one', soul: null },
        { accountId: 'a', personaText: 'two', soul: null },
      ],
    }),
    false,
  );
  assert.equal(
    isSyncReadFactPayload('account_persona', {
      accounts: [{ accountId: 'a', personaText: '   ', soul: null }],
    }),
    false,
  );
  assert.equal(
    isSyncReadFactPayload('automation_config_mirror_health', {
      sourceService: 'automation',
      asOf: 1,
      enabled: true,
      pollMs: 1_000,
      entries: [
        {
          mirrorKey: 'not_a_config_mirror',
          tier: 'gate',
          version: 1,
          lastComparedAt: 1,
          lastReloadedAt: 1,
          reloadFailingSince: null,
          state: 'fresh',
          staleMs: 1,
          observeStaleMs: 1,
          haltsOnStale: true,
          staleForMs: 0,
        },
      ],
    }),
    false,
  );
  assert.equal(
    isSyncReadFactPayload('automation_account_projection', {
      accounts: [
        {
          accountId: 'a',
          platform: '',
          groupLabel: null,
          createdAt: null,
          status: 'active',
        },
      ],
    }),
    false,
  );
});

test('B1/B2/B4 closed shapes reject removed display and sensitive fields', () => {
  assert.equal(
    isSyncReadFactPayload('account_persona', {
      accounts: [
        {
          accountId: 'a',
          personaText: 'persona',
          soul: null,
          displayName: 'must-not-cross',
        },
      ],
    }),
    false,
  );
  assert.equal(
    isSyncReadFactPayload('client_environment_automation', {
      blockedEnvironmentKeys: [],
      slowStartAnchors: [
        {
          accountId: 'a',
          slowStartSince: null,
          ambiguous: false,
          proxyPassword: 'must-not-cross',
        },
      ],
    }),
    false,
  );
  assert.equal(
    isSyncReadFactPayload('automation_account_projection', {
      accounts: [
        {
          accountId: 'a',
          platform: 'facebook',
          groupLabel: null,
          createdAt: null,
          status: 'active',
          nickname: 'removed-by-post-4a-census',
        },
      ],
    }),
    false,
  );
});

test('complete well-formed gate payloads remain accepted', () => {
  assert.equal(
    isSyncReadFactPayload('automation_config_mirror_health', {
      sourceService: 'automation',
      asOf: 10,
      enabled: true,
      pollMs: 1_000,
      entries: [
        {
          mirrorKey: 'quota_config',
          tier: 'gate',
          version: 2,
          lastComparedAt: 9,
          lastReloadedAt: 8,
          reloadFailingSince: null,
          state: 'fresh',
          staleMs: 0,
          observeStaleMs: 10_000,
          haltsOnStale: true,
          staleForMs: 0,
        },
      ],
    }),
    true,
  );
  assert.equal(
    isSyncReadFactPayload('content_schedule', {
      global: { contentActiveMask: null },
      accounts: [
        {
          accountId: 'a',
          autoEnabled: true,
          postMode: 'review',
          postDailyCap: 1,
          commentMode: 'off',
          commentDailyCap: 0,
          contactCommentMode: 'auto_approve',
          contactCommentDailyCap: 2,
          activeWeekMask: null,
          contentActiveMask: null,
        },
      ],
    }),
    true,
  );
});
