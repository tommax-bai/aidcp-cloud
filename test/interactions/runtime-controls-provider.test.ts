import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectRuntimeControls } from '../../src/interactions/runtime-controls-provider.js';
import type { RuntimeControls } from '../../src/interactions/types.js';

function controls(overrides: Partial<RuntimeControls> = {}): RuntimeControls {
  return {
    accountId: 'env_wc_a', platform: 'wechat_channels', envKey: 'env_wc_a', version: 4,
    commentsReadEnabled: true, commentsReplyEnabled: true, dmReadEnabled: true,
    dmSendTextEnabled: true, dmSendImageEnabled: false, writePaused: false,
    consecutiveFailures: 0, circuitOpenedAt: null, lastConfirmedAt: null,
    updatedAt: 1, updatedBy: 'admin', ...overrides,
  };
}

test('runtime controls projection keeps reads but closes writes when global write is off', async () => {
  const snapshot = await projectRuntimeControls({
    getRuntimeControls: async () => controls(), hasPendingOffboard: async () => false,
    hasPendingRevocationHold: async () => false,
    globalWriteEnabled: false,
  }, 'env_wc_a');
  assert.deepEqual(snapshot, {
    accountId: 'env_wc_a', envKey: 'env_wc_a', version: 4,
    commentsReadEnabled: true, commentsReplyEnabled: false,
    dmReadEnabled: true, dmSendTextEnabled: false, dmSendImageEnabled: false,
  });
});

test('runtime controls projection closes every capability during offboarding', async () => {
  const snapshot = await projectRuntimeControls({
    getRuntimeControls: async () => controls(), hasPendingOffboard: async () => true,
    hasPendingRevocationHold: async () => false,
    globalWriteEnabled: true,
  }, 'env_wc_a');
  assert.equal(snapshot.commentsReadEnabled, false);
  assert.equal(snapshot.commentsReplyEnabled, false);
  assert.equal(snapshot.dmReadEnabled, false);
  assert.equal(snapshot.dmSendTextEnabled, false);
});

test('runtime controls projection preserves stored env mismatch so Edge rejects the scope', async () => {
  const snapshot = await projectRuntimeControls({
    getRuntimeControls: async () => controls({ envKey: 'env_wc_b' }), hasPendingOffboard: async () => false,
    hasPendingRevocationHold: async () => false,
    globalWriteEnabled: true,
  }, 'env_wc_a');
  assert.equal(snapshot.accountId, 'env_wc_a');
  assert.equal(snapshot.envKey, 'env_wc_b');
});

test('runtime controls projection fails closed without inventing an environment before first bind', async () => {
  const snapshot = await projectRuntimeControls({
    getRuntimeControls: async () => controls({ envKey: null, writePaused: true }),
    hasPendingOffboard: async () => false, hasPendingRevocationHold: async () => false,
    globalWriteEnabled: true,
  }, 'env_wc_a');
  assert.equal(snapshot.envKey, '');
  assert.equal(snapshot.commentsReadEnabled, false);
  assert.equal(snapshot.commentsReplyEnabled, false);
  assert.equal(snapshot.dmReadEnabled, false);
  assert.equal(snapshot.dmSendTextEnabled, false);
});

test('runtime controls projection closes every capability while a revocation hold is pending', async () => {
  const snapshot = await projectRuntimeControls({
    getRuntimeControls: async () => controls(),
    hasPendingOffboard: async () => false,
    hasPendingRevocationHold: async () => true,
    globalWriteEnabled: true,
  }, 'env_wc_a');
  assert.equal(snapshot.commentsReadEnabled, false);
  assert.equal(snapshot.commentsReplyEnabled, false);
  assert.equal(snapshot.dmReadEnabled, false);
  assert.equal(snapshot.dmSendTextEnabled, false);
});
