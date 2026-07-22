import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFacebookGroupJoinAutomationCatalogView,
  buildFacebookGroupJoinAutomationCatalogViewFailClosed,
  intersectFacebookGroupJoinAutomationMasks,
} from '../../src/config/facebook-group-join-automation-view.js';

const FULL = '1'.repeat(168);
const EVEN = Array.from({ length: 168 }, (_, index) => index % 2 === 0 ? '1' : '0').join('');
const FIRST_HALF = '1'.repeat(84) + '0'.repeat(84);

test('join automation catalog projects effective cap, intersected mask, scope readiness, and scheduled result truth', () => {
  const recentResult = {
    outcome: 'joined' as const,
    reason: null,
    groupUrl: 'https://www.facebook.com/groups/group-a',
    createdAt: '2026-07-22T08:00:00.000Z',
  };
  const view = buildFacebookGroupJoinAutomationCatalogView({
    config: {
      accountId: 'fb-1', enabled: true, dailyCap: 3, weekMask: EVEN,
      updatedAt: '2026-07-22T07:00:00.000Z', updatedBy: 'alice',
    },
    riskDailyCap: 1,
    effectiveActiveWeekMask: FIRST_HALF,
    effectiveContentActiveMask: FULL,
    accountGroupLabel: '华东组',
    scopedTargetCount: 2,
    recentResult,
  });
  assert.equal(view.effectiveDailyCap, 1);
  assert.equal(view.weekMaskSource, 'custom');
  assert.equal(view.effectiveWeekMask, EVEN.slice(0, 84) + '0'.repeat(84));
  assert.equal(view.scopeReady, true);
  assert.equal(view.scopedTargetCount, 2);
  assert.deepEqual(view.recentResult, recentResult);
});

test('join automation catalog follows content mask when action mask is null and fails closed on invalid required masks', () => {
  assert.equal(intersectFacebookGroupJoinAutomationMasks(null, FIRST_HALF, null), FIRST_HALF);
  assert.equal(intersectFacebookGroupJoinAutomationMasks(FULL, null, null), null);
  assert.equal(intersectFacebookGroupJoinAutomationMasks('bad', FULL, null), null);
  assert.equal(intersectFacebookGroupJoinAutomationMasks(FULL, FULL, 'bad'), null);

  const view = buildFacebookGroupJoinAutomationCatalogView({
    config: { accountId: 'fb-2', enabled: false, dailyCap: 0, weekMask: null, updatedAt: null, updatedBy: null },
    riskDailyCap: 3,
    effectiveActiveWeekMask: FULL,
    effectiveContentActiveMask: FULL,
    accountGroupLabel: null,
    scopedTargetCount: 0,
    recentResult: null,
  });
  assert.equal(view.weekMaskSource, 'content');
  assert.equal(view.effectiveWeekMask, FULL);
  assert.equal(view.scopeReady, false);
  assert.equal(view.recentResult, null);
});

test('post-commit projection failures never fake a failed config write and instead fail derived fields closed', async () => {
  const view = await buildFacebookGroupJoinAutomationCatalogViewFailClosed({
    config: {
      accountId: 'fb-3', enabled: true, dailyCap: 2, weekMask: null,
      updatedAt: '2026-07-22T09:00:00.000Z', updatedBy: 'alice',
    },
    effectiveActiveWeekMask: null,
    effectiveContentActiveMask: null,
    loadRiskDailyCap: async () => { throw new Error('risk unavailable'); },
    loadScope: async () => { throw new Error('scope unavailable'); },
    loadRecentResult: async () => { throw new Error('audit unavailable'); },
  });
  assert.equal(view.enabled, true, 'durable config truth remains visible');
  assert.equal(view.dailyCap, 2);
  assert.equal(view.effectiveDailyCap, 0, 'unknown risk quota must not loosen execution');
  assert.equal(view.effectiveWeekMask, null, 'missing catalog masks fail closed');
  assert.equal(view.scopeReady, false);
  assert.equal(view.recentResult, null);
});
