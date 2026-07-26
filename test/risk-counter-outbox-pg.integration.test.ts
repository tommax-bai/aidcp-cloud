/**
 * PgRiskCounterOutboxStore 与部署索引形状的 PostgreSQL 合约测试。
 *
 * FakeDatabase 无法执行 PostgreSQL 的 partial unique index inference，所以旧的
 * `ON CONFLICT (outbox_id) DO NOTHING` 会在单元测试全绿时上线失败。本文件只在
 * `npm run test:pg` 显式通道运行，并由 pg-test-database-guard 拒绝生产目标。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { PgRiskCounterOutboxStore } from '../src/risk/risk-counter-outbox-store.js';
import { OUTBOX_URL_ENV, resolveIntegrationDatabase } from './helpers/pg-test-database-guard.js';

const target = resolveIntegrationDatabase(OUTBOX_URL_ENV);
const connectionString = target.enabled ? target.connectionString : undefined;
const skipReason = target.enabled ? (false as const) : target.skipReason;

const SCHEMA_SQL = `
CREATE TABLE risk_counters (
  id          BIGSERIAL PRIMARY KEY,
  account_id  TEXT NOT NULL,
  action      TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outbox_id   BIGINT
);
CREATE UNIQUE INDEX uq_risk_counters_outbox
  ON risk_counters (outbox_id) WHERE outbox_id IS NOT NULL;

CREATE TABLE risk_counter_outbox (
  id                BIGSERIAL PRIMARY KEY,
  account_id        TEXT NOT NULL,
  action            TEXT NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,
  execution_target  TEXT NOT NULL,
  dedupe_key        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  attempts          INTEGER NOT NULL DEFAULT 0,
  claim_token       TEXT,
  claim_expires_at  TIMESTAMPTZ,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_risk_counter_outbox_target_dedupe
  ON risk_counter_outbox (execution_target, dedupe_key);
`;

test(
  'PostgreSQL: partial outbox_id index is inferred and duplicate apply remains exactly-once',
  { skip: skipReason },
  async () => {
    const adminPool = new pg.Pool({ connectionString });
    const schema = `risk_outbox_contract_${process.pid}_${Date.now()}`;
    assert.match(schema, /^[a-z0-9_]+$/);

    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });

    try {
      await pool.query(SCHEMA_SQL);
      const store = new PgRiskCounterOutboxStore({ executionTarget: 'dev', pool });
      await store.init();

      const enqueued = await store.enqueue({
        accountId: 'account-partial-index',
        action: 'view',
        occurredAt: Date.now(),
        dedupeKey: 'receipt-partial-index:view',
      });
      assert.equal(enqueued.inserted, true);

      const [claim] = await store.claimBatch({ workerId: 'pg-contract', leaseMs: 30_000, limit: 1 });
      assert.ok(claim, 'queued fact must be claimable');

      const first = await store.applyClaimed([claim]);
      assert.deepEqual(first.map((row) => row.id), [claim.id]);

      const firstState = await pool.query<{
        status: string;
        counter_count: string;
      }>(
        `SELECT o.status,
                (SELECT COUNT(*)::text FROM risk_counters c WHERE c.outbox_id = o.id) AS counter_count
           FROM risk_counter_outbox o
          WHERE o.id = $1`,
        [claim.id],
      );
      assert.deepEqual(firstState.rows, [{ status: 'applied', counter_count: '1' }]);

      const duplicate = await store.applyClaimed([claim]);
      assert.deepEqual(duplicate, [], 'an already-applied claim is not reported as newly applied');

      const counterCount = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM risk_counters WHERE outbox_id = $1',
        [claim.id],
      );
      assert.equal(counterCount.rows[0]?.count, '1', 'database uniqueness keeps duplicate apply exactly-once');
    } finally {
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminPool.end();
    }
  },
);
