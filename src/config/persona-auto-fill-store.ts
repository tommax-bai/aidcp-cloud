/**
 * 客户 Facebook 人设自动补齐任务存储。
 *
 * 客户端只提交一次意图；环境范围、账号绑定与人设缺失均由 Cloud 现读权威表决定。
 * run 创建时快照当前客户名下 Facebook 环境，避免一个旧 run 吞入未来无关环境。
 */
import crypto from 'node:crypto';
import pg from 'pg';
import { resolveEnvPgConfig } from '../kernel/pg-config.js';
import type { WritingLanguage } from '../kernel/soul-types.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';

const { Pool } = pg;

export type PersonaAutoFillRunState = 'running' | 'completed' | 'completed_with_failures';
export type PersonaAutoFillStrategy = 'facebook_auto_v1' | 'selected_persona_v1';
export type PersonaAutoFillTargetState =
  | 'waiting_binding'
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'skipped_existing'
  | 'failed';

export interface PersonaAutoFillRun {
  runId: string;
  userId: string;
  idempotencyKey: string;
  platform: 'facebook';
  strategy: PersonaAutoFillStrategy;
  writingLanguage: WritingLanguage;
  soulYaml: string | null;
  state: PersonaAutoFillRunState;
}

export interface PersonaAutoFillTarget {
  runId: string;
  userId: string;
  envKey: string;
  accountId: string | null;
  strategy: PersonaAutoFillStrategy;
  writingLanguage: WritingLanguage;
  soulYaml: string | null;
  state: PersonaAutoFillTargetState;
  attempts: number;
  reason: string | null;
}

export const PERSONA_AUTO_FILL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS persona_auto_fill_runs (
  run_id            UUID        PRIMARY KEY,
  user_id           TEXT        NOT NULL REFERENCES client_users(user_id) ON DELETE CASCADE,
  idempotency_key   TEXT        NOT NULL,
  platform          TEXT        NOT NULL CHECK (platform = 'facebook'),
  strategy          TEXT        NOT NULL CHECK (strategy IN ('facebook_auto_v1','selected_persona_v1')),
  writing_language  TEXT        NOT NULL CHECK (writing_language IN ('zh-CN','en','vi')),
  persona_soul_yaml TEXT,
  state             TEXT        NOT NULL DEFAULT 'running'
    CHECK (state IN ('running','completed','completed_with_failures')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS persona_auto_fill_targets (
  run_id      UUID        NOT NULL REFERENCES persona_auto_fill_runs(run_id) ON DELETE CASCADE,
  env_key     TEXT        NOT NULL,
  account_id  TEXT,
  state       TEXT        NOT NULL DEFAULT 'pending'
    CHECK (state IN ('waiting_binding','pending','running','succeeded','skipped_existing','failed')),
  attempts    INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  reason      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, env_key)
);
CREATE INDEX IF NOT EXISTS persona_auto_fill_targets_env_idx
  ON persona_auto_fill_targets (env_key, state);
CREATE INDEX IF NOT EXISTS persona_auto_fill_targets_run_state_idx
  ON persona_auto_fill_targets (run_id, state);

ALTER TABLE persona_auto_fill_runs
  ADD COLUMN IF NOT EXISTS persona_soul_yaml TEXT;
ALTER TABLE persona_auto_fill_runs
  DROP CONSTRAINT IF EXISTS persona_auto_fill_runs_strategy_check;
ALTER TABLE persona_auto_fill_runs
  ADD CONSTRAINT persona_auto_fill_runs_strategy_check
  CHECK (strategy IN ('facebook_auto_v1','selected_persona_v1'));
`;

export interface PersonaAutoFillStoreOptions {
  pool?: pg.Pool;
  /** schema 保障能力注入端口（必填、无默认）：组合根传 automation 的 ensureCapabilitySchema，本文件只从 kernel 取类型。 */
  schemaEnsurer: SchemaEnsurer;
}

interface RunDbRow {
  run_id: string;
  user_id: string;
  idempotency_key: string;
  platform: 'facebook';
  strategy: PersonaAutoFillStrategy;
  writing_language: WritingLanguage;
  persona_soul_yaml: string | null;
  state: PersonaAutoFillRunState;
}

interface TargetDbRow extends RunDbRow {
  env_key: string;
  account_id: string | null;
  target_state: PersonaAutoFillTargetState;
  attempts: number;
  reason: string | null;
}

function mapRun(row: RunDbRow): PersonaAutoFillRun {
  return {
    runId: row.run_id,
    userId: row.user_id,
    idempotencyKey: row.idempotency_key,
    platform: row.platform,
    strategy: row.strategy,
    writingLanguage: row.writing_language,
    soulYaml: row.persona_soul_yaml,
    state: row.state,
  };
}

function mapTarget(row: TargetDbRow): PersonaAutoFillTarget {
  return {
    runId: row.run_id,
    userId: row.user_id,
    envKey: row.env_key,
    accountId: row.account_id,
    strategy: row.strategy,
    writingLanguage: row.writing_language,
    soulYaml: row.persona_soul_yaml,
    state: row.target_state,
    attempts: Number(row.attempts),
    reason: row.reason,
  };
}

const TARGET_SELECT = `
  SELECT t.run_id, r.user_id, r.idempotency_key, r.platform, r.strategy, r.writing_language, r.persona_soul_yaml,
         r.state, t.env_key, t.account_id, t.state AS target_state, t.attempts, t.reason
    FROM persona_auto_fill_targets t
    JOIN persona_auto_fill_runs r ON r.run_id=t.run_id`;

export class PersonaAutoFillStore {
  private readonly pool: pg.Pool;

  private readonly schemaEnsurer: SchemaEnsurer;

  constructor(options: PersonaAutoFillStoreOptions) {
    this.schemaEnsurer = options.schemaEnsurer;
    this.pool = options.pool ?? new Pool(resolveEnvPgConfig());
  }

  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await this.schemaEnsurer(this.pool, {
      capability: 'persona_auto_fill',
      sinceVersion: '0068_baseline_persona_auto_fill_tables',
      ddl: [PERSONA_AUTO_FILL_SCHEMA_SQL],
    });
  }

  /** 创建幂等 run，并在同一事务内快照当前客户名下的 Facebook 环境。 */
  async createRun(input: {
    userId: string;
    idempotencyKey: string;
    writingLanguage: WritingLanguage;
    soulYaml: string;
  }): Promise<{ run: PersonaAutoFillRun; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const runId = crypto.randomUUID();
      const inserted = await client.query<RunDbRow>(
        `INSERT INTO persona_auto_fill_runs
           (run_id,user_id,idempotency_key,platform,strategy,writing_language,persona_soul_yaml,state,created_at,updated_at)
         SELECT $1,$2,$3,'facebook','selected_persona_v1',$4,$5,'running',now(),now()
           FROM client_users u WHERE u.user_id=$2 AND u.status='enabled'
         ON CONFLICT (user_id,idempotency_key) DO NOTHING
         RETURNING run_id,user_id,idempotency_key,platform,strategy,writing_language,persona_soul_yaml,state`,
        [runId, input.userId, input.idempotencyKey, input.writingLanguage, input.soulYaml],
      );
      const created = Boolean(inserted.rows[0]);
      let row = inserted.rows[0];
      if (!row) {
        const existing = await client.query<RunDbRow>(
          `SELECT run_id,user_id,idempotency_key,platform,strategy,writing_language,persona_soul_yaml,state
             FROM persona_auto_fill_runs WHERE user_id=$1 AND idempotency_key=$2`,
          [input.userId, input.idempotencyKey],
        );
        row = existing.rows[0];
      }
      if (!row) throw new Error('persona_auto_fill_user_disabled_or_missing');

      if (created) {
        await client.query(
          `INSERT INTO persona_auto_fill_targets (run_id,env_key,state,attempts,updated_at)
           SELECT $1,s.env_key,'pending',0,now()
             FROM client_env_scope s
             LEFT JOIN client_environments e ON e.env_key=s.env_key
            WHERE s.user_id=$2 AND s.source='admin'
              AND lower(trim(COALESCE(e.platform,s.platform,''))) IN ('facebook','fb')
           ON CONFLICT (run_id,env_key) DO NOTHING`,
          [row.run_id, input.userId],
        );
        await this.refreshRunStateWith(client, row.run_id);
        const refreshed = await client.query<RunDbRow>(
          `SELECT run_id,user_id,idempotency_key,platform,strategy,writing_language,persona_soul_yaml,state
             FROM persona_auto_fill_runs WHERE run_id=$1`,
          [row.run_id],
        );
        row = refreshed.rows[0] ?? row;
      }
      await client.query('COMMIT');
      return { run: mapRun(row), created };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listPendingForRun(runId: string, limit = 20): Promise<PersonaAutoFillTarget[]> {
    const { rows } = await this.pool.query<TargetDbRow>(
      `${TARGET_SELECT}
        WHERE t.run_id=$1 AND r.state='running' AND t.state='pending'
        ORDER BY t.updated_at,t.env_key LIMIT $2`,
      [runId, limit],
    );
    return rows.map(mapTarget);
  }

  async listWaitingForEnvironment(envKey: string): Promise<PersonaAutoFillTarget[]> {
    const { rows } = await this.pool.query<TargetDbRow>(
      `${TARGET_SELECT}
        WHERE t.env_key=$1 AND r.state='running' AND t.state IN ('waiting_binding','pending')
        ORDER BY r.created_at`,
      [envKey],
    );
    return rows.map(mapTarget);
  }

  /** 抢占单个 target；只有一个 worker 能把它从 pending/waiting 推到 running。 */
  async claimTarget(runId: string, envKey: string, accountId: string): Promise<PersonaAutoFillTarget | null> {
    const { rows } = await this.pool.query<TargetDbRow>(
      `WITH claimed AS (
         UPDATE persona_auto_fill_targets
            SET state='running',account_id=$3,attempts=attempts+1,reason=NULL,updated_at=now()
          WHERE run_id=$1 AND env_key=$2 AND state IN ('pending','waiting_binding')
         RETURNING *
       )
       SELECT c.run_id,r.user_id,r.idempotency_key,r.platform,r.strategy,r.writing_language,r.persona_soul_yaml,r.state,
              c.env_key,c.account_id,c.state AS target_state,c.attempts,c.reason
         FROM claimed c JOIN persona_auto_fill_runs r ON r.run_id=c.run_id`,
      [runId, envKey, accountId],
    );
    return rows[0] ? mapTarget(rows[0]) : null;
  }

  async markTarget(
    runId: string,
    envKey: string,
    state: Exclude<PersonaAutoFillTargetState, 'running'>,
    reason: string | null = null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE persona_auto_fill_targets SET state=$3,reason=$4,updated_at=now()
        WHERE run_id=$1 AND env_key=$2`,
      [runId, envKey, state, reason],
    );
    await this.refreshRunState(runId);
  }

  async refreshRunState(runId: string): Promise<PersonaAutoFillRunState> {
    return this.refreshRunStateWith(this.pool, runId);
  }

  private async refreshRunStateWith(exec: pg.Pool | pg.PoolClient, runId: string): Promise<PersonaAutoFillRunState> {
    const { rows } = await exec.query<{ state: PersonaAutoFillRunState }>(
      `UPDATE persona_auto_fill_runs r
          SET state=CASE
            WHEN EXISTS (SELECT 1 FROM persona_auto_fill_targets t
                          WHERE t.run_id=r.run_id AND t.state IN ('waiting_binding','pending','running'))
              THEN 'running'
            WHEN EXISTS (SELECT 1 FROM persona_auto_fill_targets t
                          WHERE t.run_id=r.run_id AND t.state='failed')
              THEN 'completed_with_failures'
            ELSE 'completed'
          END,
          updated_at=now()
        WHERE r.run_id=$1
      RETURNING state`,
      [runId],
    );
    if (!rows[0]) throw new Error('persona_auto_fill_run_missing');
    return rows[0].state;
  }

  /** 进程重启时把超时 running 退回 pending，并列出需要继续处理的 run。 */
  async recoverRunnableRunIds(staleAfterMs = 10 * 60_000): Promise<string[]> {
    await this.pool.query(
      `UPDATE persona_auto_fill_targets
          SET state='pending',reason='recovered_after_restart',updated_at=now()
        WHERE state='running' AND updated_at < now() - ($1::bigint * interval '1 millisecond')`,
      [staleAfterMs],
    );
    const { rows } = await this.pool.query<{ run_id: string }>(
      `SELECT DISTINCT r.run_id
         FROM persona_auto_fill_runs r
         JOIN persona_auto_fill_targets t ON t.run_id=r.run_id
        WHERE r.state='running' AND t.state='pending'
        ORDER BY r.run_id`,
    );
    return rows.map((row) => row.run_id);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
