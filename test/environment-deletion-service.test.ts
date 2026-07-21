import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentDeletionService } from '../src/adspower/environment-deletion-service.js';

const beginExecute = {
  ok: true as const,
  action: 'execute' as const,
  requestId: 'request-1',
  version: 1,
  envKey: 'profile-1',
  platform: 'facebook',
  targetUserId: 'u1',
  state: 'deleting' as const,
  idempotent: false,
};

test('missing Cloud credential fails before creating deletion state or calling AdsPower', async () => {
  let storeCalled = false;
  let adsCalled = false;
  const service = new EnvironmentDeletionService({
    getApiKey: async () => null,
    store: {
      async beginDirectEnvironmentDeletion() { storeCalled = true; return beginExecute; },
      async finishDirectEnvironmentDeletion() { throw new Error('not reached'); },
    },
    adsPower: {
      async deleteProfile() { adsCalled = true; return { ok: true }; },
      async profileExists() { throw new Error('not reached'); },
    },
  });
  assert.deepEqual(await service.delete('profile-1', 'alice', 'idem-1'), {
    ok: false,
    reason: 'adspower_key_missing',
  });
  assert.equal(storeCalled, false);
  assert.equal(adsCalled, false);
});

test('direct AdsPower success reaches AIDCP deleted only after finish persistence', async () => {
  const order: string[] = [];
  const service = new EnvironmentDeletionService({
    getApiKey: async () => 'cloud-key',
    store: {
      async beginDirectEnvironmentDeletion() { order.push('begin'); return beginExecute; },
      async finishDirectEnvironmentDeletion(_requestId, _version, input) {
        order.push(`finish:${input.status}:${input.resultKind}`);
        return { ok: true as const, requestId: 'request-1', envKey: 'profile-1', state: 'deleted' as const, idempotent: false };
      },
    },
    adsPower: {
      async deleteProfile(envKey, key) {
        order.push(`ads:${envKey}:${key}`);
        return { ok: true as const };
      },
      async profileExists() { throw new Error('success path must not query'); },
    },
  });
  const result = await service.delete('profile-1', 'alice', 'idem-1');
  assert.deepEqual(order, ['begin', 'ads:profile-1:cloud-key', 'finish:succeeded:deleted']);
  assert.deepEqual(result, { ok: true, deletion: {
    requestId: 'request-1', version: 1, envKey: 'profile-1', platform: 'facebook', targetUserId: 'u1',
    state: 'deleted', resultKind: 'deleted', idempotent: false,
  } });
});

test('delete failure can converge only through a successful exact absence query', async () => {
  const finished: unknown[] = [];
  const service = new EnvironmentDeletionService({
    getApiKey: async () => 'cloud-key',
    store: {
      async beginDirectEnvironmentDeletion() { return beginExecute; },
      async finishDirectEnvironmentDeletion(_requestId, _version, input) {
        finished.push(input);
        return { ok: true as const, requestId: 'request-1', envKey: 'profile-1', state: 'deleted' as const, idempotent: false };
      },
    },
    adsPower: {
      async deleteProfile() {
        return { ok: false as const, reason: 'adspower_api_error' as const, detail: 'adspower_api_error:code=-1' };
      },
      async profileExists() { return { ok: true as const, exists: false }; },
    },
  });
  const result = await service.delete('profile-1', 'alice', 'idem-1');
  assert.deepEqual(finished, [{ status: 'succeeded', resultKind: 'already_missing' }]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.deletion.resultKind, 'already_missing');
});

test('delete and proof failure persist delete_failed and never report deleted', async () => {
  const finished: unknown[] = [];
  const service = new EnvironmentDeletionService({
    getApiKey: async () => 'cloud-key',
    store: {
      async beginDirectEnvironmentDeletion() { return beginExecute; },
      async finishDirectEnvironmentDeletion(_requestId, _version, input) {
        finished.push(input);
        return { ok: true as const, requestId: 'request-1', envKey: 'profile-1', state: 'delete_failed' as const, idempotent: false };
      },
    },
    adsPower: {
      async deleteProfile() {
        return { ok: false as const, reason: 'adspower_unreachable' as const, detail: 'adspower_unreachable' };
      },
      async profileExists() {
        return { ok: false as const, reason: 'adspower_unreachable' as const, detail: 'adspower_unreachable' };
      },
    },
  });
  assert.deepEqual(await service.delete('profile-1', 'alice', 'idem-1'), {
    ok: false,
    reason: 'adspower_unreachable',
    deletion: {
      requestId: 'request-1', version: 1, envKey: 'profile-1', platform: 'facebook', targetUserId: 'u1',
      state: 'delete_failed', resultKind: null, idempotent: false,
    },
  });
  assert.deepEqual(finished, [{ status: 'failed', error: 'adspower_unreachable' }]);
});

test('a failed deletion is reported as persistence_failed when its failure state cannot be stored', async () => {
  const service = new EnvironmentDeletionService({
    getApiKey: async () => 'cloud-key',
    store: {
      async beginDirectEnvironmentDeletion() { return beginExecute; },
      async finishDirectEnvironmentDeletion() {
        return { ok: false as const, reason: 'request_version_mismatch' as const };
      },
    },
    adsPower: {
      async deleteProfile() {
        return { ok: false as const, reason: 'adspower_unreachable' as const, detail: 'adspower_unreachable' };
      },
      async profileExists() {
        return { ok: false as const, reason: 'adspower_unreachable' as const, detail: 'adspower_unreachable' };
      },
    },
  });
  assert.deepEqual(await service.delete('profile-1', 'alice', 'idem-1'), {
    ok: false,
    reason: 'persistence_failed',
  });
});

test('fresh in-progress deletion never starts a second AdsPower call', async () => {
  let adsCalls = 0;
  const service = new EnvironmentDeletionService({
    getApiKey: async () => 'cloud-key',
    store: {
      async beginDirectEnvironmentDeletion() {
        return { ...beginExecute, action: 'in_progress' as const, idempotent: true };
      },
      async finishDirectEnvironmentDeletion() { throw new Error('not reached'); },
    },
    adsPower: {
      async deleteProfile() { adsCalls += 1; return { ok: true as const }; },
      async profileExists() { throw new Error('not reached'); },
    },
  });
  const result = await service.delete('profile-1', 'alice', 'idem-2');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'deletion_in_progress');
  assert.equal(adsCalls, 0);
});
