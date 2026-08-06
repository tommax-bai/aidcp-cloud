import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { SchemaProber } from '../../src/kernel/schema-capability-contract.js';
import { FacebookGroupCommentPolicyStore } from '../../src/config/facebook-group-comment-policy-store.js';

interface Row {
  join_to_first_comment_hours: number;
  revision: number;
  updated_at: Date;
  updated_by: string;
}

const readySchema: SchemaProber = async (_pool, tables) => ({
  tables: new Set(tables),
  columns: new Set([
    'facebook_group_comment_policy.singleton',
    'facebook_group_comment_policy.join_to_first_comment_hours',
    'facebook_group_comment_policy.revision',
    'facebook_group_comment_policy.updated_at',
    'facebook_group_comment_policy.updated_by',
    'facebook_group_comment_policy_audit.audit_id',
    'facebook_group_comment_policy_audit.execution_target',
    'facebook_group_comment_policy_audit.prior_revision',
    'facebook_group_comment_policy_audit.new_revision',
    'facebook_group_comment_policy_audit.before_policy',
    'facebook_group_comment_policy_audit.after_policy',
    'facebook_group_comment_policy_audit.actor_class',
    'facebook_group_comment_policy_audit.actor_id',
    'facebook_group_comment_policy_audit.request_id',
    'facebook_group_comment_policy_audit.reason',
    'facebook_group_comment_policy_audit.created_at',
  ]),
  indexes: new Set(['idx_facebook_group_comment_policy_audit_target_revision']),
});

function database() {
  // 收缩之后这张表在库层面就只有一行（单例主键），假库照此建模：
  // 仍留一个 Map 会让用例在一个「其实插得进第二行」的世界里通过。
  let row: Row | null = null;
  let audits: unknown[][] = [];
  let auditFailure = false;
  let lockTail = Promise.resolve();

  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('SELECT join_to_first_comment_hours')) {
      // 读 MUST NOT 再带任何选行参数；带了就说明分行维度被改名留了下来。
      assert.deepEqual(params, [], '群评论策略读 MUST NOT 再带任何选行参数');
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('INSERT INTO facebook_group_comment_policy_audit')) {
      if (auditFailure) throw new Error('audit failed');
      audits.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.startsWith('INSERT INTO facebook_group_comment_policy')
      || sql.startsWith('UPDATE facebook_group_comment_policy')
    ) {
      row = {
        join_to_first_comment_hours: Number(params[0]),
        revision: Number(params[1]),
        updated_at: new Date(),
        updated_by: String(params[2]),
      };
      return { rows: [row], rowCount: 1 };
    }
    throw new Error(`unhandled query: ${sql}`);
  };

  const pool = {
    query,
    connect: async () => {
      let unlock: (() => void) | null = null;
      let snapshot: { row: Row | null; audits: unknown[][] } | null = null;
      return {
        query: async (text: string, params?: unknown[]) => {
          const sql = text.replace(/\s+/g, ' ').trim();
          if (sql === 'BEGIN') {
            let release!: () => void;
            const prior = lockTail;
            lockTail = new Promise<void>((resolve) => { release = resolve; });
            await prior;
            unlock = release;
            snapshot = {
              row: row ? { ...row } : null,
              audits: audits.map((entry) => [...entry]),
            };
            return { rows: [], rowCount: 0 };
          }
          if (sql === 'COMMIT') {
            unlock?.();
            unlock = null;
            snapshot = null;
            return { rows: [], rowCount: 0 };
          }
          if (sql === 'ROLLBACK') {
            if (snapshot) {
              row = snapshot.row;
              audits = snapshot.audits;
            }
            unlock?.();
            unlock = null;
            snapshot = null;
            return { rows: [], rowCount: 0 };
          }
          return query(text, params);
        },
        release: () => unlock?.(),
      };
    },
  } as unknown as pg.Pool;

  return {
    pool,
    get row() { return row; },
    get audits() { return audits; },
    failAudit() { auditFailure = true; },
  };
}

describe('FacebookGroupCommentPolicyStore', () => {
  it('reads db then legacy env then default with truthful source', async () => {
    const db = database();
    const legacy = new FacebookGroupCommentPolicyStore({
      pool: db.pool,
      schemaProber: readySchema,
      legacyWarmupHours: () => '36',
      legacyRecommentCooldownHours: () => '80',
    });
    await legacy.init();
    assert.deepEqual(legacy.get(), {
      joinToFirstCommentHours: 36,
      revision: null,
      source: 'legacy_env',
      bounds: { joinToFirstCommentHours: { min: 1, max: 168, default: 24 } },
      sameGroupRecommentCooldownHours: 80,
      sameGroupRecommentCooldownSource: 'legacy_env',
      updatedAt: null,
      updatedBy: null,
    });

    const fallback = new FacebookGroupCommentPolicyStore({
      pool: db.pool,
      schemaProber: readySchema,
      legacyWarmupHours: () => 'bad',
    });
    await fallback.init();
    assert.equal(fallback.get()?.joinToFirstCommentHours, 24);
    assert.equal(fallback.get()?.source, 'default');
  });

  it('uses single-row CAS and write-after-read truth', async () => {
    const db = database();
    // 三个进程共用同一份唯一策略：一个写、另外两个在自己刷新之前仍看着旧值。
    const writer = new FacebookGroupCommentPolicyStore({
      pool: db.pool,
      schemaProber: readySchema,
    });
    const bystander = new FacebookGroupCommentPolicyStore({
      pool: db.pool,
      schemaProber: readySchema,
    });
    const staleWriter = new FacebookGroupCommentPolicyStore({
      pool: db.pool,
      schemaProber: readySchema,
    });
    await writer.init();
    await bystander.init();
    await staleWriter.init();
    const written = await writer.write(
      {
        expectedRevision: 0,
        joinToFirstCommentHours: 12,
        requestId: 'request-writer',
      },
      'panel:alice',
    );
    assert.equal(written.ok, true);
    if (written.ok) {
      assert.equal(written.view.source, 'db');
      assert.equal(written.view.revision, 1);
      assert.equal(written.view.joinToFirstCommentHours, 12);
    }
    // 旁观进程在自己刷新之前仍是旧值 —— 这是缓存滞后，不再是「另一行」。
    assert.equal(bystander.get()?.revision, null);

    const stale = await staleWriter.write(
      {
        expectedRevision: 0,
        joinToFirstCommentHours: 18,
        requestId: 'request-stale',
      },
      'panel:bob',
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.reason, 'revision_conflict');
      assert.equal(stale.current?.revision, 1, 'conflict refreshes another process write');
    }
    assert.equal(db.audits.length, 1);
  });

  it('rejects invalid bounds and rolls back when audit fails', async () => {
    const db = database();
    const store = new FacebookGroupCommentPolicyStore({
      pool: db.pool,
      schemaProber: readySchema,
    });
    await store.init();
    assert.deepEqual(
      await store.write(
        {
          expectedRevision: 0,
          joinToFirstCommentHours: 0,
          requestId: 'request-invalid',
        },
        'panel:alice',
      ),
      { ok: false, reason: 'invalid_value' },
    );

    db.failAudit();
    await assert.rejects(
      store.write(
        {
          expectedRevision: 0,
          joinToFirstCommentHours: 48,
          requestId: 'request-fail',
        },
        'panel:alice',
      ),
      /audit failed/,
    );
    assert.equal(db.row, null, '审计写失败必须把那一行策略一起回滚掉');
    assert.equal(db.audits.length, 0);
  });
});
