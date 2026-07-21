import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findPlatformCredential,
  resolvePlatformCredentialEnvValue,
} from '../src/config/platform-credentials.js';

test('AdsPower API key is not an allowed platform credential', () => {
  assert.equal(findPlatformCredential('adspower', 'api_key'), undefined);
});

test('unrelated platform credentials keep their environment fallback behavior', () => {
  const credential = findPlatformCredential('aliyun', 'access_key_id');
  assert.ok(credential);
  assert.equal(resolvePlatformCredentialEnvValue(credential, {
    ALIYUN_BILLING_ACCESS_KEY_ID: ' current-key ',
  }), 'current-key');
});
