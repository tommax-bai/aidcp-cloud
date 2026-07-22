import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountStateManager } from '../src/account-state.js';
import type { AccountStore, AccountRecord } from '../src/account-store.js';

/** 内存 AccountStore：不依赖真 PG，可被多个 manager 共享以模拟"重启后重新加载"。 */
class MemoryAccountStore implements AccountStore {
  rows = new Map<string, AccountRecord>();
  async listAll(): Promise<AccountRecord[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async setPaused(accountId: string, paused: boolean, at: number | null): Promise<void> {
    this.rows.set(accountId, {
      accountId,
      status: paused ? 'paused' : 'active',
      pausedAt: paused ? at : null,
    });
  }
}

// ── 纯内存（无 store）：向后兼容 ──────────────────────────────────────────
test('初始状态默认 active（pauseStateOf 返回 active）', () => {
  const mgr = new AccountStateManager();
  assert.equal(mgr.pauseStateOf('acc-1'), 'active');
});

test('pause 后 pauseStateOf 返回 paused（同步缓存立即生效）', async () => {
  const mgr = new AccountStateManager();
  await mgr.pause('acc-1');
  assert.equal(mgr.pauseStateOf('acc-1'), 'paused');
});

test('resume 后 pauseStateOf 返回 active', async () => {
  const mgr = new AccountStateManager();
  await mgr.pause('acc-1');
  await mgr.resume('acc-1');
  assert.equal(mgr.pauseStateOf('acc-1'), 'active');
});

test('getStatus 返回正确结构', async () => {
  const mgr = new AccountStateManager();
  await mgr.pause('acc-1');
  const status = mgr.getStatus('acc-1');
  assert.equal(status.accountId, 'acc-1');
  assert.equal(status.status, 'paused');
  assert.equal(typeof status.pausedAt, 'number');
});

test('getStatus 对从未注册账号视为 active（合理语义，非掩盖持久化暂停态）', () => {
  const mgr = new AccountStateManager();
  const status = mgr.getStatus('unknown');
  assert.equal(status.accountId, 'unknown');
  assert.equal(status.status, 'active');
  assert.equal(status.pausedAt, undefined);
});

// ── store-backed：持久化 + 跨重启加载（验收 2.3 核心）──────────────────────
test('暂停态持久化：同一 store 新 manager 加载后仍 paused，不静默复活', async () => {
  const store = new MemoryAccountStore();
  const m1 = new AccountStateManager(store);
  await m1.init();
  await m1.pause('default');
  assert.equal(m1.pauseStateOf('default'), 'paused');

  // 模拟 cloud 重启：新 manager 从同一持久化 store 加载
  const m2 = new AccountStateManager(store);
  await m2.init();
  assert.equal(m2.pauseStateOf('default'), 'paused', '被暂停账号重启后必须仍为 paused');
  assert.equal(m2.getStatus('default').status, 'paused');
});

test('resume 持久化：跨重启仍为 active', async () => {
  const store = new MemoryAccountStore();
  const m1 = new AccountStateManager(store);
  await m1.init();
  await m1.pause('default');
  await m1.resume('default');

  const m2 = new AccountStateManager(store);
  await m2.init();
  assert.equal(m2.pauseStateOf('default'), 'active');
});

test('pause 写入持久化 store（未注册账号自动建行）', async () => {
  const store = new MemoryAccountStore();
  const mgr = new AccountStateManager(store);
  await mgr.init();
  await mgr.pause('default');
  const rows = await store.listAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountId, 'default');
  assert.equal(rows[0].status, 'paused');
  assert.equal(typeof rows[0].pausedAt, 'number');
});
