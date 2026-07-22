import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { AccountContentSchedulePatch, AccountContentScheduleRow } from '../src/config/content-schedule-store.js';
import type { PanelConfig, PanelContentSchedule, PanelDeps } from '../src/panel/types.js';

const silentLogger = { log() {}, warn() {}, error() {} };

function makeConfig(): PanelConfig {
  return {
    port: 0,
    jwtSecret: 'test-secret',
    users: parsePanelUsers('alice:pw1'),
    jwtTtlSeconds: 3600,
    forbiddenPorts: [8787, 5432, 8788],
    logger: silentLogger,
  };
}

async function loginToken(base: string): Promise<string> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'pw1' }),
  });
  return ((await response.json()) as { token: string }).token;
}

function row(accountId: string, patch: AccountContentSchedulePatch): AccountContentScheduleRow {
  return {
    accountId,
    autoEnabled: false,
    postEnabled: false,
    postMode: 'off',
    postDailyCap: 0,
    commentEnabled: false,
    commentMode: 'off',
    commentDailyCap: 0,
    contactCommentEnabled: false,
    contactCommentMode: 'off',
    contactCommentDailyCap: 0,
    activeWeekMask: patch.activeWeekMask ?? null,
    contentActiveMask: patch.contentActiveMask ?? null,
    updatedAt: '2026-07-22T00:00:00.000Z',
    updatedBy: 'alice',
  };
}

test('账号排期 PUT 原子透传两层掩码，支持 null 恢复全局并拒绝错误类型', async () => {
  const calls: Array<{ accountId: string; patch: AccountContentSchedulePatch; actor: string }> = [];
  const contentSchedule: PanelContentSchedule = {
    getGlobalView: () => ({ contentActiveMask: null, overridden: false, updatedAt: null, updatedBy: null }),
    listCatalog: async () => [],
    setGlobal: async () => ({ ok: false, reason: 'no_valid_fields' }),
    setAccount: async (accountId, patch, actor) => {
      calls.push({ accountId, patch, actor });
      return { ok: true, row: row(accountId, patch) };
    },
  };
  const deps = { eventBus: { onAny: () => () => {} }, contentSchedule } as unknown as PanelDeps;
  const handle = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    const token = await loginToken(base);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const activeWeekMask = '1'.repeat(168);
    const contentActiveMask = '0'.repeat(168);

    const save = await fetch(`${base}/api/content-schedule/acc%2F1`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ activeWeekMask, contentActiveMask }),
    });
    assert.equal(save.status, 200);
    assert.deepEqual(calls[0], {
      accountId: 'acc/1',
      patch: { activeWeekMask, contentActiveMask },
      actor: 'alice',
    });

    const inherit = await fetch(`${base}/api/content-schedule/acc%2F1`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ activeWeekMask: null, contentActiveMask: null }),
    });
    assert.equal(inherit.status, 200);
    assert.deepEqual(calls[1]?.patch, { activeWeekMask: null, contentActiveMask: null });

    const badType = await fetch(`${base}/api/content-schedule/acc%2F1`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ activeWeekMask: 1, contentActiveMask }),
    });
    assert.equal(badType.status, 400);
    assert.equal(((await badType.json()) as { reason: string }).reason, 'value_type');
    assert.equal(calls.length, 2, '错误类型不得触发写入');
  } finally {
    await handle.close();
  }
});

test('账号排期 PUT 如实透出平台动作不支持原因', async () => {
  let calls = 0;
  const contentSchedule: PanelContentSchedule = {
    getGlobalView: () => ({ contentActiveMask: null, overridden: false, updatedAt: null, updatedBy: null }),
    listCatalog: async () => [],
    setGlobal: async () => ({ ok: false, reason: 'no_valid_fields' }),
    setAccount: async () => {
      calls += 1;
      return { ok: false, reason: 'unsupported_automation_action' };
    },
  };
  const deps = { eventBus: { onAny: () => () => {} }, contentSchedule } as unknown as PanelDeps;
  const handle = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    const token = await loginToken(base);
    const response = await fetch(`${base}/api/content-schedule/wx-1`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ commentMode: 'review', commentDailyCap: 1 }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'bad_request',
      reason: 'unsupported_automation_action',
    });
    assert.equal(calls, 1);
  } finally {
    await handle.close();
  }
});
