import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, hashKey, verifyKey, decoyVerify } from '../src/client-auth/key.js';
import { LoginRateLimiter } from '../src/client-auth/rate-limiter.js';

test('generateKey 带 ck_ 前缀且高熵唯一', () => {
  const a = generateKey();
  const b = generateKey();
  assert.ok(a.startsWith('ck_'));
  assert.notEqual(a, b);
  assert.ok(a.length > 20);
});

test('hashKey/verifyKey 往返正确,错误 key 拒绝', () => {
  const key = generateKey();
  const { hash, salt } = hashKey(key);
  assert.equal(verifyKey(key, hash, salt), true);
  assert.equal(verifyKey(key + 'x', hash, salt), false);
  assert.equal(verifyKey('ck_totally_wrong', hash, salt), false);
});

test('verifyKey 对垃圾 hash/salt fail-closed', () => {
  assert.equal(verifyKey('ck_x', 'nothex!!', 'nothex!!'), false);
  assert.equal(verifyKey('ck_x', '', ''), false);
  assert.equal(verifyKey('ck_x', 'ab', 'cd'), false); // 长度不符
});

test('decoyVerify 不抛(抹平时延)', () => {
  assert.doesNotThrow(() => decoyVerify('ck_whatever'));
  assert.doesNotThrow(() => decoyVerify(''));
});

test('限流:达阈拦截、clear 复位、维度独立', () => {
  const rl = new LoginRateLimiter({ max: 3, windowMs: 60_000 });
  const now = 1_000_000;
  const dims = ['name:acme', 'ip:1.2.3.4'];
  assert.equal(rl.retryAfter(dims, now), 0);
  rl.recordFailure(dims, now);
  rl.recordFailure(dims, now);
  rl.recordFailure(dims, now);
  assert.ok(rl.retryAfter(dims, now) > 0, '达 max 后应被限流');
  // 另一维度(不同 name/ip)不受影响
  assert.equal(rl.retryAfter(['name:other', 'ip:9.9.9.9'], now), 0);
  rl.clear(dims);
  assert.equal(rl.retryAfter(dims, now), 0, 'clear 后复位');
});

test('限流:窗口过期自动放行', () => {
  const rl = new LoginRateLimiter({ max: 1, windowMs: 1000 });
  const t0 = 1_000_000;
  rl.recordFailure(['ip:x'], t0);
  assert.ok(rl.retryAfter(['ip:x'], t0) > 0);
  assert.equal(rl.retryAfter(['ip:x'], t0 + 1001), 0, '过窗后放行');
});
