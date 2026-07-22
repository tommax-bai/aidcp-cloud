import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFacebookGroupJoinAutomationCatalogView,
  buildFacebookGroupJoinAutomationCatalogViewFailClosed,
  intersectFacebookGroupJoinAutomationMasks,
  projectFacebookGroupJoinAutomationCatalog,
} from '../../src/config/facebook-group-join-automation-view.js';
import type { ContentScheduleCatalogRow } from '../../src/config/content-schedule-store.js';

const FULL = '1'.repeat(168);
const EVEN = Array.from({ length: 168 }, (_, index) => index % 2 === 0 ? '1' : '0').join('');
const FIRST_HALF = '1'.repeat(84) + '0'.repeat(84);

function catalogRow(accountId: string, platform: string): ContentScheduleCatalogRow {
  return {
    accountId,
    platform,
    label: null,
    groupLabel: platform === 'facebook' ? '华东组' : null,
    nickname: null,
    operatorAlias: null,
    displayName: accountId,
    displayNameSource: 'account_id',
    availableActions: [],
    autoEnabled: false,
    postEnabled: false,
    postMode: 'off',
    postDailyCap: 0,
    commentEnabled: false,
    commentMode: 'off',
    commentDailyCap: 0,
    contactCommentEnabled: false,
    contactCommentMode: 'off',
    contactCommentDailyCap: 0,
    hasContactInfo: false,
    activeWeekMask: null,
    contentActiveMask: null,
    effectiveActiveWeekMask: FULL,
    effectiveContentActiveMask: FULL,
    activeMaskSource: 'global',
    contentMaskSource: 'global',
    hasActiveOverrideMask: false,
    hasContentOverrideMask: false,
    maskSource: 'global',
    hasOverrideMask: false,
    configured: false,
    updatedAt: null,
    updatedBy: null,
  };
}

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

test('large Facebook catalog uses two batch loaders and caps RiskController resolution at two in flight', async () => {
  const facebookRows = Array.from({ length: 24 }, (_, index) => catalogRow(`fb-${index}`, 'facebook'));
  const nonFacebookRows = Array.from({ length: 4 }, (_, index) => catalogRow(`xhs-${index}`, 'xiaohongshu'));
  const rows = [...facebookRows, ...nonFacebookRows];
  let scopeCalls = 0;
  let recentCalls = 0;
  let riskInFlight = 0;
  let maxRiskInFlight = 0;
  const scopeInputs: string[][] = [];
  const recentInputs: string[][] = [];

  const projected = await projectFacebookGroupJoinAutomationCatalog(rows, {
    getConfig: (accountId) => ({
      accountId, enabled: true, dailyCap: 2, weekMask: null, updatedAt: null, updatedBy: null,
    }),
    loadScopes: async (accountIds) => {
      scopeCalls++;
      scopeInputs.push([...accountIds]);
      return new Map(accountIds.map((accountId) => [accountId, { accountGroupLabel: '华东组', count: 3 }]));
    },
    loadRecentResults: async (accountIds) => {
      recentCalls++;
      recentInputs.push([...accountIds]);
      return new Map(accountIds.map((accountId) => [accountId, {
        outcome: 'joined' as const,
        reason: null,
        groupUrl: `https://www.facebook.com/groups/${accountId}`,
        createdAt: '2026-07-22T08:00:00.000Z',
      }]));
    },
    loadRiskDailyCap: async () => {
      riskInFlight++;
      maxRiskInFlight = Math.max(maxRiskInFlight, riskInFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      riskInFlight--;
      return 1;
    },
  });

  assert.equal(scopeCalls, 1);
  assert.equal(recentCalls, 1);
  assert.deepEqual(scopeInputs[0], facebookRows.map((row) => row.accountId));
  assert.deepEqual(recentInputs[0], facebookRows.map((row) => row.accountId));
  assert.equal(maxRiskInFlight, 2, '24 个账号也只能同时初始化两个 RiskController');
  assert.ok(projected.slice(0, 24).every((row) =>
    row.joinGroupAutomation?.effectiveDailyCap === 1 &&
    row.joinGroupAutomation.scopeReady === true &&
    row.joinGroupAutomation.recentResult?.outcome === 'joined'));
  assert.ok(projected.slice(24).every((row) => row.joinGroupAutomation === undefined));
});
