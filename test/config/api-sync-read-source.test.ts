import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';

import { ApiSyncReadSnapshotSource } from '../../src/config/api-sync-read-source.js';

test('B1 complete snapshot treats empty persona rows as unbound', async () => {
  const calls: string[] = [];
  const parsed: string[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes('FROM config_mirror_version')) {
        return { rows: [{ mirror_key: 'persona_config', version: '4' }] };
      }
      if (sql.includes('FROM persona_config')) {
        return {
          rows: [
            { account_id: 'blank', persona: '' },
            { account_id: 'space', persona: '   ' },
            { account_id: 'bound', persona: 'persona body' },
          ],
        };
      }
      return { rows: [] };
    },
    release() {
      calls.push('RELEASE');
    },
  };
  const source = new ApiSyncReadSnapshotSource({
    executionTarget: 'dev',
    // 本组用例不覆盖运营策略流；桩当场抛，避免「空表 + 零曲线」被误当成
    // 「这台机器没有 FB 环境、且没有任何逐日上限」。
    facebookOperationPolicy: async () => {
      throw new Error('facebook_operation_policy_not_exercised_here');
    },
    pool: { connect: async () => client } as unknown as pg.Pool,
    parseSoul(personaText) {
      parsed.push(personaText);
      return { parsed: true };
    },
  });

  const snapshot = await source.snapshot('account_persona', 1_000);
  assert.deepEqual(snapshot.value, {
    accounts: [
      {
        accountId: 'bound',
        personaText: 'persona body',
        soul: { parsed: true },
      },
    ],
  });
  assert.deepEqual(parsed, ['persona body']);
  assert.equal(calls[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(calls.at(-2), 'COMMIT');
  assert.equal(calls.at(-1), 'RELEASE');
});

test('B1 source rolls back the repeatable-read snapshot when payload loading fails', async () => {
  const calls: string[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes('FROM config_mirror_version')) return { rows: [] };
      if (sql.includes('FROM persona_config')) throw new Error('persona_read_failed');
      return { rows: [] };
    },
    release() {},
  };
  const source = new ApiSyncReadSnapshotSource({
    executionTarget: 'dev',
    // 本组用例不覆盖运营策略流；桩当场抛，避免「空表 + 零曲线」被误当成
    // 「这台机器没有 FB 环境、且没有任何逐日上限」。
    facebookOperationPolicy: async () => {
      throw new Error('facebook_operation_policy_not_exercised_here');
    },
    pool: { connect: async () => client } as unknown as pg.Pool,
    parseSoul: () => null,
  });

  await assert.rejects(
    source.snapshot('account_persona', 1_000),
    /persona_read_failed/,
  );
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(calls.includes('COMMIT'), false);
});
