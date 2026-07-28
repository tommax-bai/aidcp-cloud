import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {
  FACEBOOK_RULE_DEFINITION_ID,
  FACEBOOK_RULE_DEFINITION_VERSION,
  FACEBOOK_RULE_JOIN_EVERY_N_ROUNDS,
  FACEBOOK_RULE_VIEW_THRESHOLD,
  FacebookRuleModeStore,
} from '../../src/config/facebook-rule-mode-store.js';
import { FacebookRuleModeRuntimeStore } from '../../src/orchestrator/facebook-rule-mode-runtime-store.js';
import type { SchemaProber } from '../../src/kernel/schema-capability-contract.js';

interface ProgressRow {
  accountId: string;
  target: string;
  sequence: number;
  viewCount: number;
  activeBatchId: string | null;
  updatedAt: Date;
}

interface BatchRow {
  batch_id: string;
  accountId: string;
  target: string;
  sequence: number;
  trigger_content_key: string;
  like_state: string;
  join_state: string;
  comment_state: string;
  terminal: boolean;
  blocker: string | null;
  created_at: Date;
  updated_at: Date;
}

function memoryDatabase(accounts: Record<string, string>) {
  const configs = new Map<string, {
    account_id: string;
    enabled: boolean;
    definition_id: string;
    definition_version: number;
    updated_at: Date;
    updated_by: string;
  }>();
  const progress = new Map<string, ProgressRow>();
  const contentFacts = new Set<string>();
  const sourceFacts = new Set<string>();
  const batches = new Map<string, BatchRow>();
  let lockTail = Promise.resolve();

  const progressKey = (accountId: string, target: string) => `${accountId}|${target}`;
  const acquire = async () => {
    let release!: () => void;
    const previous = lockTail;
    lockTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  };

  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };

    if (sql.startsWith('SELECT account_id, enabled, definition_id')) {
      return { rows: [...configs.values()], rowCount: configs.size };
    }
    if (sql.startsWith('SELECT platform FROM accounts')) {
      const platform = accounts[String(params[0])];
      return { rows: platform === undefined ? [] : [{ platform }], rowCount: platform === undefined ? 0 : 1 };
    }
    if (sql.startsWith('INSERT INTO facebook_rule_mode_config')) {
      const row = {
        account_id: String(params[0]),
        enabled: params[1] === true,
        definition_id: String(params[2]),
        definition_version: Number(params[3]),
        updated_at: new Date(),
        updated_by: String(params[4]),
      };
      configs.set(row.account_id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE facebook_rule_batch SET like_state=CASE')) {
      const target = String(params[0]);
      const recovered: { batch_id: string }[] = [];
      for (const row of batches.values()) {
        if (row.target !== target || row.terminal) continue;
        row.like_state = row.like_state === 'pending'
          ? 'not_started'
          : row.like_state === 'dispatched' ? 'ambiguous' : row.like_state;
        row.join_state = row.join_state === 'pending'
          ? 'not_started'
          : row.join_state === 'dispatched' ? 'ambiguous' : row.join_state;
        row.comment_state = row.comment_state === 'pending'
          ? 'not_started'
          : row.comment_state === 'dispatched' ? 'submitted_unknown' : row.comment_state;
        row.terminal = true;
        row.blocker = 'recovered_after_restart';
        row.updated_at = new Date();
        recovered.push({ batch_id: row.batch_id });
      }
      return { rows: recovered, rowCount: recovered.length };
    }
    if (sql.startsWith('UPDATE facebook_rule_progress p SET active_batch_id=NULL')) {
      const target = String(params[0]);
      const ids = new Set(params[1] as string[]);
      for (const row of progress.values()) {
        if (row.target === target && row.activeBatchId && ids.has(row.activeBatchId)) row.activeBatchId = null;
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('INSERT INTO facebook_rule_progress')) {
      const key = progressKey(String(params[0]), String(params[1]));
      if (!progress.has(key)) {
        progress.set(key, {
          accountId: String(params[0]),
          target: String(params[1]),
          sequence: 1,
          viewCount: 0,
          activeBatchId: null,
          updatedAt: new Date(),
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM facebook_rule_progress') && sql.includes('FOR UPDATE')) {
      const row = progress.get(progressKey(String(params[0]), String(params[1])));
      return {
        rows: row ? [{
          collecting_sequence: row.sequence,
          view_count: row.viewCount,
          active_batch_id: row.activeBatchId,
        }] : [],
        rowCount: row ? 1 : 0,
      };
    }
    if (sql.startsWith('INSERT INTO facebook_rule_view_fact')) {
      const accountId = String(params[0]);
      const target = String(params[1]);
      const sequence = Number(params[4]);
      const contentKey = String(params[5]);
      const sourceKey = String(params[6]);
      const contentFact = `${accountId}|${target}|${sequence}|${contentKey}`;
      const sourceFact = `${accountId}|${target}|${sourceKey}`;
      if (contentFacts.has(contentFact) || sourceFacts.has(sourceFact)) {
        return { rows: [], rowCount: 0 };
      }
      contentFacts.add(contentFact);
      sourceFacts.add(sourceFact);
      return { rows: [{ content_key: contentKey }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE facebook_rule_progress SET view_count=')) {
      const row = progress.get(progressKey(String(params[0]), String(params[1])))!;
      row.viewCount = Number(params[4]);
      row.updatedAt = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO facebook_rule_batch')) {
      const accountId = String(params[1]);
      const target = String(params[2]);
      const sequence = Number(params[5]);
      const existing = [...batches.values()].find(
        (row) => row.accountId === accountId && row.target === target && row.sequence === sequence,
      );
      if (existing) return { rows: [existing], rowCount: 1 };
      const now = new Date();
      const row: BatchRow = {
        batch_id: String(params[0]),
        accountId,
        target,
        sequence,
        trigger_content_key: String(params[6]),
        like_state: 'pending',
        join_state: 'pending',
        comment_state: 'pending',
        terminal: false,
        blocker: null,
        created_at: now,
        updated_at: now,
      };
      batches.set(row.batch_id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE facebook_rule_progress SET collecting_sequence=')) {
      const row = progress.get(progressKey(String(params[0]), String(params[1])))!;
      row.sequence = Number(params[4]);
      row.viewCount = 0;
      row.activeBatchId = String(params[5]);
      row.updatedAt = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE facebook_rule_batch SET like_state=COALESCE')) {
      const row = batches.get(String(params[0]));
      if (!row || row.target !== String(params[7])) return { rows: [], rowCount: 0 };
      if (params[1] !== null) row.like_state = String(params[1]);
      if (params[2] !== null) row.join_state = String(params[2]);
      if (params[3] !== null) row.comment_state = String(params[3]);
      if (params[4] !== null) row.terminal = params[4] === true;
      if (params[5] === true) row.blocker = params[6] == null ? null : String(params[6]);
      row.updated_at = new Date();
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE facebook_rule_progress SET active_batch_id=NULL')) {
      for (const row of progress.values()) {
        if (row.activeBatchId === String(params[0]) && row.target === String(params[1])) {
          row.activeBatchId = null;
          row.updatedAt = new Date();
        }
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT view_count, collecting_sequence, updated_at FROM facebook_rule_progress')) {
      const row = progress.get(progressKey(String(params[0]), String(params[1])));
      return {
        rows: row
          ? [{
            view_count: row.viewCount,
            collecting_sequence: row.sequence,
            updated_at: row.updatedAt,
          }]
          : [],
        rowCount: row ? 1 : 0,
      };
    }
    if (sql.includes('FROM facebook_rule_batch') && sql.includes('ORDER BY sequence DESC')) {
      const rows = [...batches.values()]
        .filter((row) => row.accountId === String(params[0]) && row.target === String(params[1]))
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, 1);
      return { rows, rowCount: rows.length };
    }
    throw new Error(`unhandled test query: ${sql}`);
  };

  const pool = {
    query,
    connect: async () => {
      let release: (() => void) | undefined;
      return {
        query: async (text: string, params?: unknown[]) => {
          if (text === 'BEGIN') release = await acquire();
          const result = await query(text, params);
          if (text === 'COMMIT' || text === 'ROLLBACK') {
            release?.();
            release = undefined;
          }
          return result;
        },
        release: () => release?.(),
      };
    },
  } as unknown as pg.Pool;
  return { pool, configs, progress, batches };
}

const schemaColumns: Record<string, string[]> = {
  facebook_rule_mode_config: [
    'account_id', 'enabled', 'definition_id', 'definition_version', 'updated_at', 'updated_by',
  ],
  facebook_rule_progress: [
    'account_id', 'execution_target', 'definition_id', 'definition_version',
    'collecting_sequence', 'view_count', 'active_batch_id', 'updated_at',
  ],
  facebook_rule_view_fact: [
    'account_id', 'execution_target', 'definition_id', 'definition_version',
    'collecting_sequence', 'content_key', 'source_dedupe_key', 'occurred_at', 'created_at',
  ],
  facebook_rule_batch: [
    'batch_id', 'account_id', 'execution_target', 'definition_id', 'definition_version',
    'sequence', 'trigger_content_key', 'like_state', 'join_state', 'comment_state',
    'terminal', 'blocker', 'created_at', 'updated_at',
  ],
};
const readySchema: SchemaProber = async (_client, tables) => ({
  tables: new Set(tables),
  columns: new Set(tables.flatMap((table) =>
    (schemaColumns[table] ?? []).map((column) => `${table}.${column}`),
  )),
  indexes: new Set(tables.includes('facebook_rule_batch')
    ? ['idx_facebook_rule_batch_account_target']
    : []),
});

function store(pool: pg.Pool, target: 'dev' | 'ol') {
  const configStore = new FacebookRuleModeStore({ pool, schemaProber: readySchema });
  const runtimeStore = new FacebookRuleModeRuntimeStore({
    pool,
    executionTarget: target,
    schemaProber: readySchema,
  });
  return {
    async init() {
      await configStore.init();
      await runtimeStore.init();
    },
    getConfig: (accountId: string) => configStore.getConfig(accountId),
    setAccount: (
      accountId: string,
      patch: { enabled?: boolean },
      updatedBy: string,
    ) => configStore.setAccount(accountId, patch, updatedBy),
    async getView(accountId: string) {
      return {
        config: configStore.getConfig(accountId),
        runtime: await runtimeStore.getRuntimeView(accountId),
      };
    },
    applyConfirmedView: (input: {
      accountId: string;
      contentKey: string;
      sourceDedupeKey: string;
      occurredAt: number;
    }) => runtimeStore.applyConfirmedView(input),
    updateBatch: (
      batchId: string,
      patch: Parameters<FacebookRuleModeRuntimeStore['updateBatch']>[1],
    ) => runtimeStore.updateBatch(batchId, patch),
  };
}

async function apply(
  targetStore: ReturnType<typeof store>,
  index: number,
  overrides: Partial<{ accountId: string; contentKey: string; sourceDedupeKey: string }> = {},
) {
  return targetStore.applyConfirmedView({
    accountId: overrides.accountId ?? 'fb-1',
    contentKey: overrides.contentKey ?? `post-${index}`,
    sourceDedupeKey: overrides.sourceDedupeKey ?? `receipt-${index}`,
    occurredAt: 1_700_000_000_000 + index,
  });
}

describe('FacebookRuleModeStore config authority', () => {
  it('defaults disabled, persists audit readback, and rejects missing or non-Facebook accounts', async () => {
    const db = memoryDatabase({ 'fb-1': 'facebook', 'xhs-1': 'xiaohongshu' });
    const targetStore = store(db.pool, 'dev');
    await targetStore.init();

    assert.equal((await targetStore.getView('fb-1')).config.enabled, false);
    assert.deepEqual(await targetStore.setAccount('missing', { enabled: true }, 'panel:alice'), {
      ok: false,
      reason: 'account_not_found',
    });
    assert.deepEqual(await targetStore.setAccount('xhs-1', { enabled: true }, 'panel:alice'), {
      ok: false,
      reason: 'unsupported_platform',
    });
    const written = await targetStore.setAccount('fb-1', { enabled: true }, 'panel:alice');
    assert.equal(written.ok, true);
    assert.equal((await targetStore.getView('fb-1')).config.updatedBy, 'panel:alice');
    assert.equal(db.configs.get('fb-1')?.definition_id, FACEBOOK_RULE_DEFINITION_ID);
    assert.equal(db.configs.get('fb-1')?.definition_version, FACEBOOK_RULE_DEFINITION_VERSION);
  });

  it('fails closed with the exact migration version when schema capability is missing', async () => {
    const db = memoryDatabase({ 'fb-1': 'facebook' });
    const targetStore = new FacebookRuleModeStore({
      pool: db.pool,
      schemaProber: async () => ({
        tables: new Set(),
        columns: new Set(),
        indexes: new Set(),
      }),
    });
    await assert.rejects(
      () => targetStore.init(),
      /schema_missing_facebook_rule_mode_config_run_0092_facebook_rule_mode_config/,
    );
  });

  it('bumps the shared content-schedule mirror in the same config transaction', async () => {
    const db = memoryDatabase({ 'fb-1': 'facebook' });
    const bumped: string[] = [];
    const targetStore = new FacebookRuleModeStore({
      pool: db.pool,
      schemaProber: readySchema,
      mirrorVersionBumper: {
        bumpDomain: 'api',
        bumpInTx: async (_client, mirrorKey) => { bumped.push(mirrorKey); },
      },
    });
    await targetStore.init();
    const result = await targetStore.setAccount('fb-1', { enabled: true }, 'panel:alice');
    assert.equal(result.ok, true);
    assert.deepEqual(bumped, ['content_schedule']);
  });
});

describe('FacebookRuleModeStore durable cadence', () => {
  it('resumes at 3/5, dedupes content and receipts, then atomically creates one fifth-view round', async () => {
    const db = memoryDatabase({ 'fb-1': 'facebook' });
    const first = store(db.pool, 'dev');
    await first.init();
    for (let i = 1; i <= 3; i += 1) assert.equal((await apply(first, i)).kind, 'counted');
    assert.equal((await first.getView('fb-1')).runtime.viewCount, 3);

    const restarted = store(db.pool, 'dev');
    await restarted.init();
    assert.equal((await restarted.getView('fb-1')).runtime.viewCount, 3);
    assert.deepEqual(await apply(restarted, 3, { sourceDedupeKey: 'replayed-other-receipt' }), {
      kind: 'duplicate',
      viewCount: 3,
    });
    assert.deepEqual(await apply(restarted, 4, { sourceDedupeKey: 'receipt-3' }), {
      kind: 'duplicate',
      viewCount: 3,
    });
    assert.equal((await apply(restarted, 4)).kind, 'counted');

    const fifthRace = await Promise.all([
      apply(restarted, 5),
      apply(restarted, 5, { sourceDedupeKey: 'receipt-5-replay' }),
      apply(restarted, 6),
    ]);
    assert.equal(fifthRace.filter((result) => result.kind === 'batch_created').length, 1);
    assert.equal(db.batches.size, 1);
    const view = await restarted.getView('fb-1');
    assert.equal(view.runtime.viewCount, 0);
    assert.equal(view.runtime.currentBatch?.triggerContentKey, 'post-5');
    assert.equal(view.runtime.currentBatch?.sequence, 1);
    assert.equal(FACEBOOK_RULE_VIEW_THRESHOLD, 5);
    assert.equal(FACEBOOK_RULE_JOIN_EVERY_N_ROUNDS, 2);
  });

  it('marks round 1 like-only and round 2 as the join round, and projects both cadence tiers', async () => {
    const db = memoryDatabase({ 'fb-1': 'facebook' });
    const dev = store(db.pool, 'dev');
    await dev.init();

    // 尚未开始收集：下一轮就是第 1 轮，不含加群。
    const fresh = await dev.getView('fb-1');
    assert.equal(fresh.runtime.threshold, 5);
    assert.equal(fresh.runtime.joinEveryNRounds, 2);
    assert.equal(fresh.runtime.collectingSequence, 1);
    assert.equal(fresh.runtime.collectingRoundIncludesJoin, false);

    let created;
    for (let i = 1; i <= 5; i += 1) created = await apply(dev, i);
    if (created?.kind !== 'batch_created') throw new Error('expected round 1');
    assert.equal(created.batch.sequence, 1);
    assert.equal(created.batch.includesJoin, false, '周期第 1 位只点赞');

    // 只点赞的轮次以 not_scheduled 终结（调度器写入的形状），随后收集第 2 轮。
    await dev.updateBatch(created.batch.batchId, {
      likeState: 'confirmed',
      joinState: 'not_scheduled',
      commentState: 'not_scheduled',
      terminal: true,
    });
    const afterRound1 = await dev.getView('fb-1');
    assert.equal(afterRound1.runtime.collectingSequence, 2);
    assert.equal(afterRound1.runtime.collectingRoundIncludesJoin, true, '下一轮含加群');
    assert.equal(afterRound1.runtime.currentBatch?.includesJoin, false);
    assert.equal(afterRound1.runtime.currentBatch?.joinState, 'not_scheduled');

    let second;
    for (let i = 6; i <= 10; i += 1) second = await apply(dev, i);
    if (second?.kind !== 'batch_created') throw new Error('expected round 2');
    assert.equal(second.batch.sequence, 2);
    assert.equal(second.batch.includesJoin, true, '周期第 2 位才加群');
    // 加群频率仍是每 10 条确认浏览一次，与单轴旧节奏逐位相等。
  });

  it('holds collection while a round is active, clears without debt at terminal, and isolates dev from ol', async () => {
    const db = memoryDatabase({ 'fb-1': 'facebook' });
    const dev = store(db.pool, 'dev');
    const ol = store(db.pool, 'ol');
    await dev.init();
    await ol.init();
    let created;
    for (let i = 1; i <= 5; i += 1) created = await apply(dev, i);
    assert.equal(created?.kind, 'batch_created');
    assert.equal((await apply(dev, 6)).kind, 'batch_active');

    assert.equal((await apply(ol, 1)).kind, 'counted');
    assert.equal((await ol.getView('fb-1')).runtime.viewCount, 1);
    assert.equal((await dev.getView('fb-1')).runtime.viewCount, 0);

    if (created?.kind !== 'batch_created') throw new Error('expected batch');
    // 点赞阶段先写入抑制原因……
    await dev.updateBatch(created.batch.batchId, {
      likeState: 'risk_suppressed',
      blocker: 'daily_like_quota',
    });
    // ……只点赞的轮次终结时**省略** blocker 键，存储层 MUST 原样保留它。
    // blocker 是三阶段共用一列、写入语义后写覆盖先写，补写任何值都会抹掉「点赞为什么被抑制」。
    await dev.updateBatch(created.batch.batchId, {
      joinState: 'not_scheduled',
      commentState: 'not_scheduled',
      terminal: true,
    });
    assert.deepEqual(await apply(dev, 6), { kind: 'counted', viewCount: 1 });
    assert.equal(db.batches.get(created.batch.batchId)?.like_state, 'risk_suppressed');
    assert.equal(
      db.batches.get(created.batch.batchId)?.blocker,
      'daily_like_quota',
      '省略 blocker 键时 MUST 保留点赞阶段的抑制原因',
    );
  });

  it('recovers dispatched work after restart as honest terminal ambiguity without replay', async () => {
    const db = memoryDatabase({ 'fb-1': 'facebook' });
    const first = store(db.pool, 'dev');
    await first.init();
    let created;
    for (let i = 1; i <= 5; i += 1) created = await apply(first, i);
    if (created?.kind !== 'batch_created') throw new Error('expected batch');
    await first.updateBatch(created.batch.batchId, {
      likeState: 'dispatched',
      joinState: 'dispatched',
      commentState: 'dispatched',
    });

    const restarted = store(db.pool, 'dev');
    await restarted.init();
    const recovered = (await restarted.getView('fb-1')).runtime.currentBatch;
    assert.equal(recovered?.terminal, true);
    assert.equal(recovered?.likeState, 'ambiguous');
    assert.equal(recovered?.joinState, 'ambiguous');
    assert.equal(recovered?.commentState, 'submitted_unknown');
    assert.equal(recovered?.blocker, 'recovered_after_restart');
    assert.deepEqual(await apply(restarted, 6), { kind: 'counted', viewCount: 1 });
  });

  it('leaves not_scheduled untouched during restart recovery', async () => {
    const db = memoryDatabase({ 'fb-1': 'facebook' });
    const first = store(db.pool, 'dev');
    await first.init();
    let created;
    for (let i = 1; i <= 5; i += 1) created = await apply(first, i);
    if (created?.kind !== 'batch_created') throw new Error('expected batch');
    // 只点赞的轮次已终结：恢复只扫 terminal=false，MUST NOT 把 not_scheduled 改写成失败态。
    await first.updateBatch(created.batch.batchId, {
      likeState: 'confirmed',
      joinState: 'not_scheduled',
      commentState: 'not_scheduled',
      terminal: true,
    });

    const restarted = store(db.pool, 'dev');
    await restarted.init();
    const after = (await restarted.getView('fb-1')).runtime.currentBatch;
    assert.equal(after?.joinState, 'not_scheduled');
    assert.equal(after?.commentState, 'not_scheduled');
    assert.notEqual(after?.blocker, 'recovered_after_restart');
  });
});
