import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signJwt, verifyJwt } from '../src/panel/jwt.js';

const SECRET = 'test-secret-0123456789';

test('sign 后 verify 成功并回带 sub/exp', () => {
  const now = 1_700_000_000_000;
  const token = signJwt({ sub: 'alice' }, SECRET, 3600, now);
  const r = verifyJwt(token, SECRET, now);
  assert.equal(r.valid, true);
  if (r.valid) {
    assert.equal(r.payload.sub, 'alice');
    assert.equal(r.payload.exp, Math.floor(now / 1000) + 3600);
  }
});

test('过期 token 被拒（expired）', () => {
  const issuedAt = 1_700_000_000_000;
  const token = signJwt({ sub: 'alice' }, SECRET, 60, issuedAt);
  const later = issuedAt + 61_000; // 61s 后，已过 60s TTL
  const r = verifyJwt(token, SECRET, later);
  assert.equal(r.valid, false);
  if (!r.valid) assert.equal(r.reason, 'expired');
});

test('错误密钥验签失败（bad_signature）', () => {
  const now = 1_700_000_000_000;
  const token = signJwt({ sub: 'alice' }, SECRET, 3600, now);
  const r = verifyJwt(token, 'wrong-secret', now);
  assert.equal(r.valid, false);
  if (!r.valid) assert.equal(r.reason, 'bad_signature');
});

test('篡改 payload 被拒（bad_signature）', () => {
  const now = 1_700_000_000_000;
  const token = signJwt({ sub: 'alice' }, SECRET, 3600, now);
  const [h, , s] = token.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ sub: 'attacker', iat: 1, exp: 9_999_999_999 }), 'utf8').toString('base64url');
  const forged = `${h}.${forgedBody}.${s}`;
  const r = verifyJwt(forged, SECRET, now);
  assert.equal(r.valid, false);
  if (!r.valid) assert.equal(r.reason, 'bad_signature');
});

test('alg 非 HS256 被拒（bad_alg）——杜绝 alg=none/混淆', () => {
  const now = 1_700_000_000_000;
  const head = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: 'x', iat: 1, exp: 9_999_999_999 }), 'utf8').toString('base64url');
  const token = `${head}.${body}.`;
  const r = verifyJwt(token, SECRET, now);
  assert.equal(r.valid, false);
  if (!r.valid) assert.equal(r.reason, 'bad_alg');
});

test('结构不合法被拒（malformed）', () => {
  const r = verifyJwt('not-a-jwt', SECRET);
  assert.equal(r.valid, false);
  if (!r.valid) assert.equal(r.reason, 'malformed');
});

test('signJwt 产出唯一 jti，verify 回带（#26 撤销标识）', () => {
  const now = 1_700_000_000_000;
  const t1 = signJwt({ sub: 'a' }, SECRET, 3600, now);
  const t2 = signJwt({ sub: 'a' }, SECRET, 3600, now);
  const r1 = verifyJwt(t1, SECRET, now);
  const r2 = verifyJwt(t2, SECRET, now);
  assert.ok(r1.valid && typeof r1.payload.jti === 'string' && r1.payload.jti.length > 0, 'payload 带非空 jti');
  if (r1.valid && r2.valid) assert.notEqual(r1.payload.jti, r2.payload.jti); // 每次签发唯一
});
