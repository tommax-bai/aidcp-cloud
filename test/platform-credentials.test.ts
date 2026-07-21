import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findPlatformCredential,
  resolvePlatformCredentialEnvValue,
} from '../src/config/platform-credentials.js';

test('AdsPower API key is an encrypted platform credential with hot runtime semantics', () => {
  const credential = findPlatformCredential('adspower', 'api_key');
  assert.ok(credential);
  assert.equal(credential.group, 'browser_service');
  assert.equal(credential.groupLabel, '浏览器服务 API Key');
  assert.equal(credential.restartRequired, false);
  assert.deepEqual(credential.envKeys, ['ADS_API_KEY', 'ADSPOWER_API_KEY']);
  assert.equal(resolvePlatformCredentialEnvValue(credential, { ADS_API_KEY: ' current-key ' }), 'current-key');
});
