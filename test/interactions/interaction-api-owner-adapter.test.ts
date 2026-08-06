import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import type { InteractionAuditEventRecord } from '@kernel/kernel/interaction-audit-outbox.js';
import { PgInteractionApiWrites } from '@api/interactions/interaction-api-writes.js';

const AUDIT: InteractionAuditEventRecord = {
  eventId: 'audit-owner-1',
  platform: 'wechat_channels',
  accountId: 'account-1',
  envKey: 'env-1',
  actor: 'edge',
  action: 'config_published',
  configVersion: 3,
  entityType: 'reply_config',
  entityId: 'config-1',
  summary: 'published',
  labels: { source: 'test' },
  createdAt: 1_784_044_812_345,
};

test('PgInteractionApiWrites: audit eventId 重放返回 inserted/duplicate 真态', async () => {
  let calls = 0;
  const pool = {
    query: async (sql: string) => {
      calls += 1;
      assert.match(sql, /ON CONFLICT \(event_id\) DO NOTHING/);
      return { rows: [], rowCount: calls === 1 ? 1 : 0 };
    },
  } as unknown as pg.Pool;
  const writes = new PgInteractionApiWrites(pool);

  assert.deepEqual(await writes.insertAuditEvent(AUDIT), { outcome: 'inserted' });
  assert.deepEqual(await writes.insertAuditEvent(AUDIT), { outcome: 'duplicate' });
});

test('PgInteractionApiWrites: reply purge 在 API owner 事务内汇总真实删除行数', async () => {
  const statements: string[] = [];
  const rowCounts = [2, 0, 3, 1, 4];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith('DELETE FROM reply_') || sql.startsWith('DELETE FROM account_reply_')
        || sql.startsWith('DELETE FROM interaction_reply_')) {
        return { rows: [], rowCount: rowCounts.shift() ?? 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => statements.push('RELEASE'),
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  const writes = new PgInteractionApiWrites(pool);

  assert.deepEqual(await writes.purgeReplyConfigForAccount('account-1'), { removedRows: 10 });
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-2), 'COMMIT');
  assert.equal(statements.at(-1), 'RELEASE');
});

test('PgInteractionApiWrites: owner SQL 失败回滚且不返回假 row count', async () => {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith('DELETE FROM interaction_audit_events')) throw new Error('api_write_down');
      return { rows: [], rowCount: 0 };
    },
    release: () => statements.push('RELEASE'),
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  const writes = new PgInteractionApiWrites(pool);

  await assert.rejects(() => writes.purgeExpiredAuditEvents(1_784_044_812_345), /api_write_down/);
  assert.ok(statements.includes('ROLLBACK'));
  assert.equal(statements.at(-1), 'RELEASE');
});
