import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountStateManager } from '../src/account-state.js';

test('初始状态默认 active（isPaused 返回 false）', () => {
  const mgr = new AccountStateManager();
  assert.equal(mgr.isPaused('acc-1'), false);
});

test('pause 后 isPaused 返回 true', () => {
  const mgr = new AccountStateManager();
  mgr.pause('acc-1');
  assert.equal(mgr.isPaused('acc-1'), true);
});

test('resume 后 isPaused 返回 false', () => {
  const mgr = new AccountStateManager();
  mgr.pause('acc-1');
  mgr.resume('acc-1');
  assert.equal(mgr.isPaused('acc-1'), false);
});

test('getStatus 返回正确结构', () => {
  const mgr = new AccountStateManager();
  mgr.pause('acc-1');
  const status = mgr.getStatus('acc-1');
  assert.equal(status.accountId, 'acc-1');
  assert.equal(status.status, 'paused');
  assert.equal(typeof status.pausedAt, 'number');
});

test('getStatus 对未知账号返回默认 active', () => {
  const mgr = new AccountStateManager();
  const status = mgr.getStatus('unknown');
  assert.equal(status.accountId, 'unknown');
  assert.equal(status.status, 'active');
  assert.equal(status.pausedAt, undefined);
});

test('pause 设置 pausedAt 时间戳', () => {
  const mgr = new AccountStateManager();
  const before = Date.now();
  mgr.pause('acc-1');
  const after = Date.now();
  const status = mgr.getStatus('acc-1');
  assert.ok(status.pausedAt! >= before);
  assert.ok(status.pausedAt! <= after);
});
