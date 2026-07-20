import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashOffboardCleanupGrantJti,
  issueOffboardCleanupGrant,
  verifyOffboardCleanupGrant,
} from '../src/client-auth/offboard-cleanup-grant.js';

const secret = 'cleanup-test-secret';
const input = {
  offboardId: 'offboard-1',
  envKey: 'env-1',
  accountId: 'account-1',
  edgeId: 'ads-env-1',
  userId: 'user-1',
};

test('cleanup grant signs all scope bindings and expires at a bounded time', () => {
  const issued = issueOffboardCleanupGrant(input, secret, 60, 1_000_000);
  const verified = verifyOffboardCleanupGrant(issued.token, secret, 1_030_000);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.deepEqual({
    offboardId: verified.claims.offboardId,
    envKey: verified.claims.envKey,
    accountId: verified.claims.accountId,
    edgeId: verified.claims.edgeId,
    userId: verified.claims.userId,
  }, input);
  assert.match(hashOffboardCleanupGrantJti(verified.claims.jti), /^[0-9a-f]{64}$/);
  assert.deepEqual(verifyOffboardCleanupGrant(issued.token, secret, 1_060_000), { ok: false, reason: 'expired' });
});

test('cleanup grant rejects tampering and a different signing boundary', () => {
  const issued = issueOffboardCleanupGrant(input, secret);
  const parts = issued.token.split('.');
  const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ ...issued.claims, envKey: 'env-2' })).toString('base64url')}.${parts[2]}`;
  assert.deepEqual(verifyOffboardCleanupGrant(tampered, secret), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyOffboardCleanupGrant(issued.token, 'other-secret'), { ok: false, reason: 'bad_signature' });
});
