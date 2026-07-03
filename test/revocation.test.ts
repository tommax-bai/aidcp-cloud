import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenRevocationStore } from '../src/panel/revocation.js';

const NOW = 1_700_000_000_000;
const sec = (ms: number) => Math.floor(ms / 1000);

test('revoke → isRevoked true；未撤销 / 空 jti → false（#26）', () => {
  const s = new TokenRevocationStore();
  s.revoke('jti-1', sec(NOW) + 3600);
  assert.equal(s.isRevoked('jti-1', NOW), true);
  assert.equal(s.isRevoked('jti-2', NOW), false);
  assert.equal(s.isRevoked(undefined, NOW), false);
});

test('已过 exp 的 jti isRevoked 返 false 并惰性清理', () => {
  const s = new TokenRevocationStore();
  s.revoke('jti-1', sec(NOW) + 60);
  assert.equal(s.isRevoked('jti-1', NOW + 61_000), false);
  assert.equal(s.size(), 0); // 惰性清理已删
});

test('空 jti revoke 忽略（旧令牌无 jti 不可撤销）', () => {
  const s = new TokenRevocationStore();
  s.revoke(undefined, 999);
  s.revoke('', 999);
  assert.equal(s.size(), 0);
});

test('sweep 批量清理过期条目、保留未过期', () => {
  const s = new TokenRevocationStore();
  s.revoke('old', sec(NOW) + 60);
  s.revoke('fresh', sec(NOW) + 7200);
  const removed = s.sweep(NOW + 3_600_000); // 1h 后
  assert.equal(removed, 1);
  assert.equal(s.size(), 1);
  assert.equal(s.isRevoked('fresh', NOW + 3_600_000), true);
});
