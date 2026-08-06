import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { InteractionStore } from '@automation/interactions/interaction-store.js';
import { PgInteractionApiWrites } from '@api/interactions/interaction-api-writes.js';
import type { InteractionSyncBatchPayload } from '@kernel/kernel/interaction-types.js';
import {
  INTERACTION_TEST_EXECUTION_TARGET,
  allowAllAuthGate,
  interactionAccountPlatform,
} from '../helpers/interaction-store-test-deps.js';

function runtimeRow() {
  return {
    account_id: 'acct-circuit', env_key: 'env-circuit', version: 7,
    comments_read_enabled: true, comments_reply_enabled: true,
    dm_read_enabled: true, dm_send_text_enabled: true, dm_send_image_enabled: false,
    write_paused: true, consecutive_failures: 3,
    circuit_opened_at: new Date(1_784_044_800_000) as Date | null, last_confirmed_at: null,
    updated_at: new Date(1_784_044_801_000), updated_by: 'circuit_breaker',
  };
}

test('runtime-control CAS resets circuit in the same UPDATE and conflict leaves it untouched', async () => {
  const row = runtimeRow();
  let updateSql = '';
  const audits: Array<Record<string, unknown>> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO interaction_runtime_controls')) return { rows: [] };
      if (sql.includes('SELECT * FROM interaction_runtime_controls')) return { rows: [{ ...row }] };
      if (sql.includes('UPDATE interaction_runtime_controls SET version=version+1')) {
        updateSql = sql;
        if (params[8] !== row.version) return { rows: [] };
        const previousPaused = row.write_paused;
        row.version += 1;
        row.comments_read_enabled = params[2] as boolean;
        row.comments_reply_enabled = params[3] as boolean;
        row.dm_read_enabled = params[4] as boolean;
        row.dm_send_text_enabled = params[5] as boolean;
        row.write_paused = params[6] as boolean;
        row.updated_by = params[7] as string;
        if (previousPaused && !row.write_paused) {
          row.consecutive_failures = 0;
          row.circuit_opened_at = null;
        }
        return { rows: [{ version: row.version }] };
      }
      // 配置面审计已改走本域 outbox（api 属主表由中继幂等落地）；这里断言的是入队载荷的 labels。
      if (sql.includes('INSERT INTO event_outbox')) {
        const record = JSON.parse(params[1] as string) as { labels: Record<string, unknown> };
        audits.push(record.labels);
        return { rows: [{ id: audits.length }] };
      }
      if (sql.includes('pg_notify')) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  } as unknown as Pool;
  const store = new InteractionStore({ pool, idGen: (prefix) => `${prefix}-test`,
    authGate: allowAllAuthGate(), executionTarget: INTERACTION_TEST_EXECUTION_TARGET,
    accountPlatform: interactionAccountPlatform() });
  const input = {
    accountId: 'acct-circuit', actor: 'admin', commentsReadEnabled: true,
    commentsReplyEnabled: true, dmReadEnabled: true, dmSendTextEnabled: true,
    dmSendImageEnabled: false as const, writePaused: false,
  };

  await assert.rejects(store.updateRuntimeControls({ ...input, expectedVersion: 6 }),
    (error: unknown) => (error as { code?: string }).code === 'INTERACTION_VERSION_CONFLICT');
  assert.equal(row.consecutive_failures, 3);
  assert.ok(row.circuit_opened_at instanceof Date);
  assert.equal(audits.length, 0);

  const cleared = await store.updateRuntimeControls({ ...input, expectedVersion: 7 });
  assert.match(updateSql, /consecutive_failures=CASE WHEN write_paused=true AND \$7=false THEN 0/);
  assert.match(updateSql, /circuit_opened_at=CASE WHEN write_paused=true AND \$7=false THEN NULL/);
  assert.match(updateSql, /WHERE platform=\$1 AND account_id=\$2 AND version=\$9/);
  assert.equal(cleared.writePaused, false);
  assert.equal(cleared.consecutiveFailures, 0);
  assert.equal(cleared.circuitOpenedAt, null);
  assert.deepEqual(audits, [{
    version: 8, circuitReset: true, circuitWasOpen: true, previousConsecutiveFailures: 3,
  }]);
});

test('ingest replay advances timestamps but only a newly inserted job returns its thread to review', async () => {
  const threadUpdates: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM client_env_revocation_holds')) return { rows: [] };
      if (sql.includes('SELECT platform FROM accounts')) return { rows: [{ platform: 'wechat_channels' }] };
      if (sql.includes('FROM interaction_auth_state') && sql.includes('FOR SHARE')) {
        return { rows: [{ account_id: 'acct-ingest', env_key: 'env-ingest' }] };
      }
      if (sql.includes('FROM interaction_sync_batches') && sql.includes('SELECT env_key')) return { rows: [] };
      if (sql.includes('INSERT INTO interaction_threads')) return { rows: [{ id: `db-${params[5]}` }] };
      if (sql.includes('INSERT INTO interaction_messages')) return { rows: [{ id: `db-${params[7]}`, inserted: true }] };
      if (sql.includes('INSERT INTO interaction_reply_jobs')) {
        return params[5] === 'db-message-old' ? { rows: [] } : { rows: [{ id: 'job-new' }] };
      }
      if (sql.includes('UPDATE interaction_threads') && sql.includes('last_message_at')) {
        threadUpdates.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      // 配置面审计入队（api 属主表由中继落地）：emit 要读回自增 id。
      if (sql.includes('INSERT INTO event_outbox')) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const store = new InteractionStore({ pool, clock: () => 1_784_044_900_100, idGen: (prefix) => `${prefix}-test`,
    authGate: allowAllAuthGate(), executionTarget: INTERACTION_TEST_EXECUTION_TARGET });
  const payload: InteractionSyncBatchPayload = {
    batchId: 'batch-replay', requestId: null, envKey: 'env-ingest', accountId: 'acct-ingest',
    platform: 'wechat_channels', channel: 'comment', scopeExternalId: null,
    cursorBefore: null, cursorAfter: 'cursor-replay', hasMore: false,
    threads: ['old', 'new'].map((suffix) => ({ externalThreadId: `thread-${suffix}`,
      sourceExternalId: null, sourceTitle: null, sourceCoverUrl: null,
      participant: null, updatedAt: 1_784_044_900_000 })),
    messages: ['old', 'new'].map((suffix, index) => ({ externalThreadId: `thread-${suffix}`,
      externalMessageId: `message-${suffix}`, direction: 'inbound' as const,
      externalParentId: null, externalRootId: `message-${suffix}`, messageType: 'text' as const,
      contentText: suffix, attachmentMeta: null, lifecycle: 'active' as const,
      platformCreatedAt: 1_784_044_900_000 + index, rawMetaSanitized: {} })),
    observedAt: 1_784_044_900_010,
  };

  const result = await store.ingestBatch(payload);
  assert.deepEqual(result.newJobIds, ['job-new']);
  assert.equal(threadUpdates.length, 2);
  assert.ok(threadUpdates.every(({ sql }) => /status=CASE WHEN \$6::boolean THEN 'waiting_review' ELSE status END/.test(sql)));
  assert.deepEqual(threadUpdates.map(({ params }) => params[5]), [false, true]);
});

test('classifying recovery keeps the stale threshold in the SQL predicate', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];
  const jobs = [
    { state: 'classifying', version: 10, updatedAt: 1_784_044_850_000 },
    { state: 'classifying', version: 20, updatedAt: 1_784_044_870_000 },
  ];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      const threshold = params[0] as number;
      let rowCount = 0;
      for (const job of jobs) {
        if (job.state === 'classifying' && job.updatedAt < threshold) {
          job.state = 'new';
          job.version += 1;
          rowCount += 1;
        }
      }
      return { rows: [], rowCount };
    },
  } as unknown as Pool;
  const store = new InteractionStore({ pool });
  assert.equal(await store.recoverStalledClassifyingJobs(1_784_044_860_000), 1);
  assert.match(capturedSql, /state='classifying' AND updated_at < to_timestamp\(\$1\/1000\.0\)/);
  assert.match(capturedSql, /state='new',version=version\+1/);
  assert.deepEqual(capturedParams, [1_784_044_860_000]);
  assert.deepEqual(jobs, [
    { state: 'new', version: 11, updatedAt: 1_784_044_850_000 },
    { state: 'classifying', version: 20, updatedAt: 1_784_044_870_000 },
  ]);
});

test('the recovery cycle resets stale classifying jobs before scanning new and queued work', async () => {
  // 事实源翻转后（invert-split-fact-source 5.6 re-anchor）：恢复扫描的现役落点在
  // aidcp-automation 的交互装配层（`automation-interaction.ts` 的 drainRecovery，
  // 其注释自证「三段与单体逐字同序」）。单体 `src/server.ts` 已冻结、不再部署。
  // 属主仓自身没有这条顺序守卫，故它留在本集成仓。
  const { siblingRepoRoot } = await import('../helpers/sibling-repos.js');
  const { join } = await import('node:path');
  const source = await readFile(
    join(siblingRepoRoot('aidcp-automation'), 'src', 'automation-interaction.ts'),
    'utf8',
  );
  const start = source.indexOf('const drainRecovery');
  const end = source.indexOf('recoveryTimer = setTimer', start);
  assert.ok(start >= 0 && end > start, '恢复扫描的段落锚点失效——先确认它搬去了哪里');
  const cycle = source.slice(start, end);
  const reset = cycle.indexOf('recoverStalledClassifyingJobs');
  const drafts = cycle.indexOf('pendingGenerationJobs');
  const queued = cycle.indexOf('pendingQueuedJobs');
  assert.ok(reset >= 0 && reset < drafts && drafts < queued);
  assert.match(cycle, /Date\.now\(\) - aiTimeoutMs \* 2/);
});

test('deadline purges Cloud data without Edge receipt and a late receipt is recorded separately', async () => {
  let dueReturned = false;
  const deletedSql: string[] = [];
  const offboardAudits: Array<{ event: string; status: string }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT offboard_id,account_id,env_key,user_id,edge_result_status')) {
        if (dueReturned) return { rows: [] };
        dueReturned = true;
        return { rows: [{ offboard_id: 'offboard-due', account_id: 'acct-due', env_key: 'env-due',
          user_id: 'user-due', edge_result_status: null }] };
      }
      if (sql.includes('SELECT env_key FROM interaction_auth_state')) {
        return { rows: [{ env_key: 'env-due' }], rowCount: 1 };
      }
      if (sql.startsWith('DELETE FROM')) {
        deletedSql.push(sql);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE interaction_offboards SET state='purged'")) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO interaction_offboard_audit')) {
        offboardAudits.push({ event: sql.match(/'(cloud_purge[a-z_]*)'/)?.[1] ?? 'unknown', status: params[5] as string });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const store = new InteractionStore({
    pool,
    idGen: (prefix) => `${prefix}-test`,
    apiPurge: new PgInteractionApiWrites(pool),
  });
  assert.equal(await store.purgeDueOffboards(1_784_044_900_000), 1);
  assert.ok(deletedSql.some((sql) => sql.includes('DELETE FROM interaction_threads')));
  assert.ok(deletedSql.some((sql) => sql.includes('DELETE FROM interaction_auth_state')));
  assert.equal(deletedSql.some((sql) => sql.includes('interaction_reply_config_scopes') ||
    sql.includes('interaction_reply_scope_versions') || sql.includes('interaction_reply_scope_audit')), false,
  'offboarding an account must preserve group/default strategy aggregates and their immutable versions');
  assert.deepEqual(offboardAudits, [
    { event: 'cloud_purged', status: 'purged_edge_unconfirmed' },
    { event: 'cloud_purge_rows', status: 'scope=account+env;api_requests=1,auth_state=1,reply_config=5,'
      + 'runtime_controls=1,sync_batches=1,sync_cursors=1,threads=1' },
  ]);

  const lateAudits: Array<{ event: string; status: string }> = [];
  const lateClient = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT state,edge_result_status,user_id')) {
        return { rows: [{ state: 'purged', edge_result_status: null, user_id: 'user-due' }] };
      }
      if (sql.includes('UPDATE interaction_offboards SET edge_result_status')) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO interaction_offboard_audit')) {
        lateAudits.push({ event: params[6] as string, status: params[7] as string });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const lateStore = new InteractionStore({ pool: { connect: async () => lateClient } as unknown as Pool,
    idGen: (prefix) => `${prefix}-late` });
  assert.deepEqual(await lateStore.applyOffboardResult({
    offboardId: 'offboard-due', accountId: 'acct-due', envKey: 'env-due', platform: 'wechat_channels',
    status: 'cleared', errorCode: null, finishedAt: 1_784_044_901_000,
  }), { duplicate: false });
  assert.deepEqual(lateAudits, [{
    event: 'edge_cleanup_confirmed_after_cloud_purge', status: 'purged_edge_confirmed',
  }]);
});
