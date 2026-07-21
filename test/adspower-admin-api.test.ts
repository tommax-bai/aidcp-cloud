import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADSPOWER_MIN_INTERVAL_MS,
  AdsPowerAdminApi,
} from '../src/adspower/admin-api.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('deleteProfile uses only fixed user/delete path, bearer auth, and one envKey body', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const api = new AdsPowerAdminApi({
    apiBase: 'http://ads.internal:50325/',
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ code: 0, data: {} });
    },
  });
  assert.deepEqual(await api.deleteProfile('profile-1', 'secret-key'), { ok: true });
  assert.equal(calls[0]?.url, 'http://ads.internal:50325/api/v1/user/delete');
  assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, 'Bearer secret-key');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { user_ids: ['profile-1'] });
});

test('profileExists accepts only a well-formed exact filtered list as proof', async () => {
  const responses = [
    jsonResponse({ code: 0, data: { list: [{ user_id: 'profile-1' }] } }),
    jsonResponse({ code: 0, data: { list: [] } }),
    jsonResponse({ code: 0, data: {} }),
  ];
  const urls: string[] = [];
  const api = new AdsPowerAdminApi({
    fetchImpl: async (input) => {
      urls.push(String(input));
      return responses.shift()!;
    },
    sleepImpl: async () => {},
    nowImpl: (() => { let now = 0; return () => (now += ADSPOWER_MIN_INTERVAL_MS); })(),
  });
  assert.deepEqual(await api.profileExists('profile-1', 'key'), { ok: true, exists: true });
  assert.deepEqual(await api.profileExists('profile-1', 'key'), { ok: true, exists: false });
  assert.deepEqual(await api.profileExists('profile-1', 'key'), {
    ok: false,
    reason: 'adspower_invalid_response',
    detail: 'adspower_invalid_response:list_shape',
  });
  assert.match(urls[0]!, /\/api\/v1\/user\/list\?user_id=profile-1&page=1&page_size=10$/);
});

test('profileExists rejects a different profile instead of treating an ignored filter as absence', async () => {
  const api = new AdsPowerAdminApi({
    fetchImpl: async () => jsonResponse({ code: 0, data: { list: [{ user_id: 'profile-2' }] } }),
  });
  assert.deepEqual(await api.profileExists('profile-1', 'key'), {
    ok: false,
    reason: 'adspower_invalid_response',
    detail: 'adspower_invalid_response:list_filter',
  });
});

test('errors expose only stable categories and never echo response message or credential', async () => {
  const api = new AdsPowerAdminApi({
    fetchImpl: async () => jsonResponse({ code: -1, msg: 'token=secret-key password=hunter2' }),
  });
  const result = await api.deleteProfile('profile-1', 'secret-key');
  assert.deepEqual(result, { ok: false, reason: 'adspower_api_error', detail: 'adspower_api_error:code=-1' });
  assert.equal(JSON.stringify(result).includes('secret-key'), false);
  assert.equal(JSON.stringify(result).includes('hunter2'), false);
});

test('requests are serialized and keep at least the AdsPower interval', async () => {
  let now = 1_000;
  const sleeps: number[] = [];
  const starts: number[] = [];
  const api = new AdsPowerAdminApi({
    nowImpl: () => now,
    sleepImpl: async (ms) => { sleeps.push(ms); now += ms; },
    fetchImpl: async () => {
      starts.push(now);
      now += 10;
      return jsonResponse({ code: 0, data: {} });
    },
  });
  await Promise.all([
    api.deleteProfile('profile-1', 'key'),
    api.deleteProfile('profile-2', 'key'),
  ]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1]! - starts[0]! >= ADSPOWER_MIN_INTERVAL_MS);
  assert.deepEqual(sleeps, [ADSPOWER_MIN_INTERVAL_MS]);
});

test('timeout is bounded and categorized without exposing fetch error text', async () => {
  const api = new AdsPowerAdminApi({
    timeoutMs: 5,
    fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('secret network detail'), { name: 'AbortError' })));
    }),
  });
  assert.deepEqual(await api.deleteProfile('profile-1', 'secret-key'), {
    ok: false,
    reason: 'adspower_timeout',
    detail: 'adspower_timeout:5ms',
  });
});
