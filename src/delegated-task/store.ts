import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import type {
  DelegatedActionFamily,
  DelegatedTask,
  DelegatedTaskAttempt,
  DelegatedTaskIntent,
  DelegatedTaskStatus,
  DelegatedTerminalOutcome,
  DelegatedVerificationKind,
} from './types.js';
import {
  actionFamilyFor,
  assertTaskTransition,
  honestTerminalStatus,
  isTerminalTaskStatus,
  verificationCountsAsSuccess,
} from './types.js';

const { Pool } = pg;

export const DELEGATED_TASK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS delegated_tasks (
  id                    UUID PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES accounts(account_id),
  account_name          TEXT NOT NULL,
  platform              TEXT NOT NULL CHECK (platform IN ('xiaohongshu','facebook')),
  action                TEXT NOT NULL,
  action_family         TEXT NOT NULL CHECK (action_family IN ('comment','publish','candidate_control')),
  target_success_count  INTEGER NOT NULL CHECK (target_success_count > 0),
  max_attempts          INTEGER NOT NULL CHECK (max_attempts >= target_success_count),
  deadline_at           TIMESTAMPTZ NOT NULL,
  not_before            TIMESTAMPTZ NOT NULL,
  execution_window      JSONB NOT NULL DEFAULT '{}',
  source_constraints    JSONB NOT NULL DEFAULT '{}',
  target_constraints    JSONB NOT NULL DEFAULT '{}',
  approval_mode         TEXT NOT NULL CHECK (approval_mode IN ('review','auto_approve','draft_only')),
  priority              TEXT NOT NULL CHECK (priority IN ('normal','high')),
  source                TEXT NOT NULL,
  source_ref            TEXT,
  status                TEXT NOT NULL,
  success_count         INTEGER NOT NULL DEFAULT 0,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  skipped_count         INTEGER NOT NULL DEFAULT 0,
  failure_count         INTEGER NOT NULL DEFAULT 0,
  current_step          TEXT,
  terminal_outcome      JSONB,
  pause_requested       BOOLEAN NOT NULL DEFAULT false,
  cancel_requested      BOOLEAN NOT NULL DEFAULT false,
  next_eligible_at      TIMESTAMPTZ,
  claim_token           TEXT,
  claim_expires_at      TIMESTAMPTZ,
  dedupe_key            TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1,
  confirmed_at          TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delegated_tasks_active_dedupe
  ON delegated_tasks(dedupe_key)
  WHERE status IN ('draft','awaiting_confirmation','queued','planning','waiting_approval','executing','deferred');
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_claim
  ON delegated_tasks(status, next_eligible_at, not_before, deadline_at, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_ownership
  ON delegated_tasks(account_id, action_family, status);

CREATE TABLE IF NOT EXISTS delegated_task_events (
  id          BIGSERIAL PRIMARY KEY,
  task_id     UUID NOT NULL REFERENCES delegated_tasks(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  detail      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delegated_task_events_task ON delegated_task_events(task_id, id);

CREATE TABLE IF NOT EXISTS delegated_task_attempts (
  id                UUID PRIMARY KEY,
  task_id           UUID NOT NULL REFERENCES delegated_tasks(id) ON DELETE CASCADE,
  ordinal           INTEGER NOT NULL,
  target_key        TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('prepared','dispatched','succeeded','skipped','failed','submitted_unknown')),
  verification_kind TEXT,
  evidence_ref      TEXT,
  reason            TEXT,
  prepared_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at     TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  UNIQUE(task_id, ordinal),
  UNIQUE(task_id, target_key)
);
CREATE INDEX IF NOT EXISTS idx_delegated_task_attempts_reconcile
  ON delegated_task_attempts(task_id, status, prepared_at);
`;

export interface DelegatedTaskCreate extends DelegatedTaskIntent {
  accountId: string;
  accountName: string;
  platform: 'xiaohongshu' | 'facebook';
  dedupeKey: string;
}

export interface AttemptFinish {
  status: 'succeeded' | 'skipped' | 'failed' | 'submitted_unknown';
  verificationKind: DelegatedVerificationKind;
  evidenceRef?: string;
  reason?: string;
}

export interface DelegatedTaskStore {
  init(): Promise<void>;
  createDraft(input: DelegatedTaskCreate): Promise<{ task: DelegatedTask; created: boolean }>;
  get(id: string): Promise<DelegatedTask | null>;
  list(filter?: { accountId?: string; limit?: number }): Promise<DelegatedTask[]>;
  confirm(id: string, version: number): Promise<DelegatedTask | null>;
  claimNext(opts: { workerId: string; leaseMs: number; now?: number }): Promise<DelegatedTask | null>;
  markExecuting(id: string, claimToken: string, step: string): Promise<DelegatedTask | null>;
  releaseClaim(id: string, claimToken: string, nextStatus: DelegatedTaskStatus, opts?: { nextEligibleAt?: number; step?: string; reason?: string }): Promise<DelegatedTask | null>;
  releaseWaitingApprovalClaim(id: string, claimToken: string, nextEligibleAt: number): Promise<DelegatedTask | null>;
  startAttempt(taskId: string, claimToken: string, targetKey: string): Promise<DelegatedTaskAttempt>;
  markAttemptDispatched(attemptId: string): Promise<void>;
  annotateAttempt(attemptId: string, verificationKind: DelegatedVerificationKind, evidenceRef: string, reason?: string): Promise<void>;
  finishAttempt(attemptId: string, result: AttemptFinish): Promise<DelegatedTask>;
  listUnsettledAttempts(taskId: string): Promise<DelegatedTaskAttempt[]>;
  requestPause(id: string, version?: number): Promise<DelegatedTask | null>;
  resume(id: string, version?: number): Promise<DelegatedTask | null>;
  requestCancel(id: string, version?: number): Promise<DelegatedTask | null>;
  complete(id: string, claimToken: string | null, status: DelegatedTaskStatus, outcome: DelegatedTerminalOutcome): Promise<DelegatedTask | null>;
  hasActiveOwnership(accountId: string, family: DelegatedActionFamily, excludingTaskId?: string): Promise<boolean>;
  close?(): Promise<void>;
}

interface TaskRow {
  id: string;
  account_id: string;
  account_name: string;
  platform: 'xiaohongshu' | 'facebook';
  action: DelegatedTask['action'];
  action_family: DelegatedActionFamily;
  target_success_count: number;
  max_attempts: number;
  deadline_at: Date | string;
  not_before: Date | string;
  execution_window: DelegatedTask['executionWindow'];
  source_constraints: DelegatedTask['sourceConstraints'];
  target_constraints: DelegatedTask['targetConstraints'];
  approval_mode: DelegatedTask['approvalMode'];
  priority: DelegatedTask['priority'];
  source: DelegatedTask['source'];
  source_ref: string | null;
  status: DelegatedTaskStatus;
  success_count: number;
  attempt_count: number;
  skipped_count: number;
  failure_count: number;
  current_step: string | null;
  terminal_outcome: DelegatedTerminalOutcome | null;
  pause_requested: boolean;
  cancel_requested: boolean;
  next_eligible_at: Date | string | null;
  claim_token: string | null;
  claim_expires_at: Date | string | null;
  dedupe_key: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  confirmed_at: Date | string | null;
  completed_at: Date | string | null;
}

interface AttemptRow {
  id: string;
  task_id: string;
  ordinal: number;
  target_key: string;
  status: DelegatedTaskAttempt['status'];
  verification_kind: DelegatedVerificationKind | null;
  evidence_ref: string | null;
  reason: string | null;
  prepared_at: Date | string;
  dispatched_at: Date | string | null;
  finished_at: Date | string | null;
}

const epoch = (v: Date | string | null): number | null => (v ? new Date(v).getTime() : null);

function mapTask(r: TaskRow): DelegatedTask {
  return {
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    platform: r.platform,
    action: r.action,
    actionFamily: r.action_family,
    targetSuccessCount: Number(r.target_success_count),
    maxAttempts: Number(r.max_attempts),
    deadlineAt: epoch(r.deadline_at)!,
    notBefore: epoch(r.not_before)!,
    executionWindow: r.execution_window,
    sourceConstraints: r.source_constraints,
    targetConstraints: r.target_constraints,
    approvalMode: r.approval_mode,
    priority: r.priority,
    source: r.source,
    sourceRef: r.source_ref,
    status: r.status,
    progress: {
      successCount: Number(r.success_count),
      attemptCount: Number(r.attempt_count),
      skippedCount: Number(r.skipped_count),
      failureCount: Number(r.failure_count),
    },
    currentStep: r.current_step,
    terminalOutcome: r.terminal_outcome,
    pauseRequested: r.pause_requested,
    cancelRequested: r.cancel_requested,
    nextEligibleAt: epoch(r.next_eligible_at),
    claimToken: r.claim_token,
    claimExpiresAt: epoch(r.claim_expires_at),
    dedupeKey: r.dedupe_key,
    version: Number(r.version),
    createdAt: epoch(r.created_at)!,
    updatedAt: epoch(r.updated_at)!,
    confirmedAt: epoch(r.confirmed_at),
    completedAt: epoch(r.completed_at),
  };
}

function mapAttempt(r: AttemptRow): DelegatedTaskAttempt {
  return {
    id: r.id,
    taskId: r.task_id,
    ordinal: Number(r.ordinal),
    targetKey: r.target_key,
    status: r.status,
    verificationKind: r.verification_kind,
    evidenceRef: r.evidence_ref,
    reason: r.reason,
    preparedAt: epoch(r.prepared_at)!,
    dispatchedAt: epoch(r.dispatched_at),
    finishedAt: epoch(r.finished_at),
  };
}

export interface PgDelegatedTaskStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

export class PgDelegatedTaskStore implements DelegatedTaskStore {
  private readonly pool: pg.Pool;

  constructor(options: PgDelegatedTaskStoreOptions = {}) {
    this.pool = options.pool ?? new Pool({
      host: options.host ?? DEFAULT_PG_CONFIG.host,
      port: options.port ?? DEFAULT_PG_CONFIG.port,
      database: options.database ?? DEFAULT_PG_CONFIG.database,
      user: options.user ?? DEFAULT_PG_CONFIG.user,
      password: options.password ?? DEFAULT_PG_CONFIG.password,
    });
  }

  async init(): Promise<void> {
    await this.pool.query(DELEGATED_TASK_SCHEMA_SQL);
  }

  async createDraft(input: DelegatedTaskCreate): Promise<{ task: DelegatedTask; created: boolean }> {
    const id = randomUUID();
    const now = Date.now();
    const values = [
      id, input.accountId, input.accountName, input.platform, input.action, actionFamilyFor(input.action),
      input.targetSuccessCount, input.maxAttempts, new Date(input.deadlineAt), new Date(input.notBefore ?? now),
      input.executionWindow ?? { mode: 'immediate' }, input.sourceConstraints ?? {}, input.targetConstraints ?? {},
      input.approvalMode ?? (input.action === 'generate_candidates' ? 'draft_only' : 'review'),
      input.priority ?? 'normal', input.source, input.sourceRef ?? null, input.dedupeKey,
    ];
    try {
      const { rows } = await this.pool.query<TaskRow>(
        `INSERT INTO delegated_tasks (
           id, account_id, account_name, platform, action, action_family,
           target_success_count, max_attempts, deadline_at, not_before, execution_window,
           source_constraints, target_constraints, approval_mode, priority, source, source_ref,
           status, dedupe_key
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'awaiting_confirmation',$18)
         RETURNING *`,
        values,
      );
      await this.pool.query(
        `INSERT INTO delegated_task_events(task_id,event_type,to_status,detail) VALUES($1,'draft_created','awaiting_confirmation',$2)`,
        [id, JSON.stringify({ source: input.source })],
      );
      return { task: mapTask(rows[0]), created: true };
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      const { rows } = await this.pool.query<TaskRow>(
        `SELECT * FROM delegated_tasks WHERE dedupe_key=$1 AND status IN
         ('draft','awaiting_confirmation','queued','planning','waiting_approval','executing','deferred')
         ORDER BY created_at DESC LIMIT 1`,
        [input.dedupeKey],
      );
      if (!rows[0]) throw err;
      return { task: mapTask(rows[0]), created: false };
    }
  }

  async get(id: string): Promise<DelegatedTask | null> {
    const { rows } = await this.pool.query<TaskRow>('SELECT * FROM delegated_tasks WHERE id=$1', [id]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async list(filter: { accountId?: string; limit?: number } = {}): Promise<DelegatedTask[]> {
    const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
    const q = filter.accountId
      ? { sql: 'SELECT * FROM delegated_tasks WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2', args: [filter.accountId, limit] }
      : { sql: 'SELECT * FROM delegated_tasks ORDER BY created_at DESC LIMIT $1', args: [limit] };
    const { rows } = await this.pool.query<TaskRow>(q.sql, q.args);
    return rows.map(mapTask);
  }

  async confirm(id: string, version: number): Promise<DelegatedTask | null> {
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE delegated_tasks SET status='queued', confirmed_at=now(), updated_at=now(), version=version+1
       WHERE id=$1 AND status='awaiting_confirmation' AND version=$2 RETURNING *`,
      [id, version],
    );
    if (rows[0]) {
      await this.pool.query(
        `INSERT INTO delegated_task_events(task_id,event_type,from_status,to_status) VALUES($1,'confirmed','awaiting_confirmation','queued')`,
        [id],
      );
      return mapTask(rows[0]);
    }
    return this.get(id);
  }

  async claimNext(opts: { workerId: string; leaseMs: number; now?: number }): Promise<DelegatedTask | null> {
    const now = new Date(opts.now ?? Date.now());
    const token = `${opts.workerId}:${randomUUID()}`;
    const expires = new Date(now.getTime() + Math.max(1_000, opts.leaseMs));
    const { rows } = await this.pool.query<TaskRow>(
      `WITH candidate AS (
         SELECT id FROM delegated_tasks
         WHERE status IN ('queued','deferred','waiting_approval')
           AND pause_requested=false AND cancel_requested=false
           AND not_before <= $1 AND (next_eligible_at IS NULL OR next_eligible_at <= $1)
           AND deadline_at > $1 AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
         ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, deadline_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE delegated_tasks t SET
         status=CASE WHEN t.status='waiting_approval' THEN t.status ELSE 'planning' END,
         claim_token=$2, claim_expires_at=$3,
         current_step=CASE WHEN t.status='waiting_approval' THEN 'reconcile_waiting_approval' ELSE 'planning' END,
         updated_at=$1,
         version=CASE WHEN t.status='waiting_approval' THEN t.version ELSE t.version+1 END
       FROM candidate WHERE t.id=candidate.id RETURNING t.*`,
      [now, token, expires],
    );
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async markExecuting(id: string, claimToken: string, step: string): Promise<DelegatedTask | null> {
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE delegated_tasks SET status='executing', current_step=$3, updated_at=now(), version=version+1
       WHERE id=$1 AND claim_token=$2 AND status='planning' RETURNING *`,
      [id, claimToken, step],
    );
    return rows[0] ? mapTask(rows[0]) : this.get(id);
  }

  async releaseClaim(
    id: string,
    claimToken: string,
    nextStatus: DelegatedTaskStatus,
    opts: { nextEligibleAt?: number; step?: string; reason?: string } = {},
  ): Promise<DelegatedTask | null> {
    const before = await this.get(id);
    if (!before || before.claimToken !== claimToken) return before;
    assertTaskTransition(before.status, nextStatus);
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE delegated_tasks SET status=$3, claim_token=NULL, claim_expires_at=NULL,
         next_eligible_at=$4, current_step=$5, updated_at=now(), version=version+1
       WHERE id=$1 AND claim_token=$2 RETURNING *`,
      [id, claimToken, nextStatus, opts.nextEligibleAt ? new Date(opts.nextEligibleAt) : null, opts.step ?? null],
    );
    if (rows[0]) await this.event(id, 'claim_released', before.status, nextStatus, { reason: opts.reason ?? null });
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async releaseWaitingApprovalClaim(id: string, claimToken: string, nextEligibleAt: number): Promise<DelegatedTask | null> {
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE delegated_tasks SET claim_token=NULL, claim_expires_at=NULL,
         next_eligible_at=$3, current_step='waiting_approval', updated_at=now()
       WHERE id=$1 AND claim_token=$2 AND status='waiting_approval' RETURNING *`,
      [id, claimToken, new Date(nextEligibleAt)],
    );
    return rows[0] ? mapTask(rows[0]) : this.get(id);
  }

  async startAttempt(taskId: string, claimToken: string, targetKey: string): Promise<DelegatedTaskAttempt> {
    const task = await this.get(taskId);
    if (!task || task.claimToken !== claimToken) throw new Error('task_claim_mismatch');
    const id = randomUUID();
    const { rows } = await this.pool.query<AttemptRow>(
      `INSERT INTO delegated_task_attempts(id,task_id,ordinal,target_key,status)
       SELECT $1,$2,COALESCE(MAX(ordinal),0)+1,$3,'prepared' FROM delegated_task_attempts WHERE task_id=$2
       RETURNING *`,
      [id, taskId, targetKey],
    );
    return mapAttempt(rows[0]);
  }

  async markAttemptDispatched(attemptId: string): Promise<void> {
    await this.pool.query(
      `WITH marked AS (
         UPDATE delegated_task_attempts SET status='dispatched', dispatched_at=now()
         WHERE id=$1 AND status='prepared' RETURNING task_id
       )
       UPDATE delegated_tasks t SET attempt_count=attempt_count+1, updated_at=now(), version=version+1
       FROM marked WHERE t.id=marked.task_id`,
      [attemptId],
    );
  }

  async annotateAttempt(attemptId: string, verificationKind: DelegatedVerificationKind, evidenceRef: string, reason?: string): Promise<void> {
    await this.pool.query(
      `UPDATE delegated_task_attempts SET verification_kind=$2, evidence_ref=$3, reason=$4
       WHERE id=$1 AND status IN ('prepared','dispatched')`,
      [attemptId, verificationKind, evidenceRef, reason ?? null],
    );
  }

  async finishAttempt(attemptId: string, result: AttemptFinish): Promise<DelegatedTask> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const attemptRows = await client.query<AttemptRow>(
        `UPDATE delegated_task_attempts SET status=$2, verification_kind=$3, evidence_ref=$4,
           reason=$5, finished_at=now() WHERE id=$1 AND status IN ('prepared','dispatched') RETURNING *`,
        [attemptId, result.status, result.verificationKind, result.evidenceRef ?? null, result.reason ?? null],
      );
      const attempt = attemptRows.rows[0];
      if (!attempt) throw new Error('attempt_already_finished_or_missing');
      const currentTask = await client.query<Pick<TaskRow, 'action'>>('SELECT action FROM delegated_tasks WHERE id=$1 FOR UPDATE', [attempt.task_id]);
      const success = result.status === 'succeeded' && verificationCountsAsSuccess(currentTask.rows[0].action, result.verificationKind) ? 1 : 0;
      const skipped = result.status === 'skipped' ? 1 : 0;
      const failure = result.status === 'failed' || result.status === 'submitted_unknown' ? 1 : 0;
      const taskRows = await client.query<TaskRow>(
        `UPDATE delegated_tasks SET success_count=success_count+$2,
           skipped_count=skipped_count+$3, failure_count=failure_count+$4, updated_at=now(), version=version+1
         WHERE id=$1 RETURNING *`,
        [attempt.task_id, success, skipped, failure],
      );
      await client.query(
        `INSERT INTO delegated_task_events(task_id,event_type,detail) VALUES($1,'attempt_finished',$2)`,
        [attempt.task_id, JSON.stringify({ attemptId, ...result })],
      );
      await client.query('COMMIT');
      return mapTask(taskRows.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listUnsettledAttempts(taskId: string): Promise<DelegatedTaskAttempt[]> {
    const { rows } = await this.pool.query<AttemptRow>(
      `SELECT * FROM delegated_task_attempts WHERE task_id=$1 AND status IN ('prepared','dispatched') ORDER BY ordinal`,
      [taskId],
    );
    return rows.map(mapAttempt);
  }

  async requestPause(id: string, version?: number): Promise<DelegatedTask | null> {
    const task = await this.get(id);
    if (!task || isTerminalTaskStatus(task.status) || (version !== undefined && task.version !== version)) return task;
    const immediate = task.status === 'queued' || task.status === 'deferred' || task.status === 'awaiting_confirmation';
    const nextStatus = immediate ? 'deferred' : task.status;
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE delegated_tasks SET pause_requested=true, status=$2, current_step=$3,
         claim_token=CASE WHEN $4 THEN NULL ELSE claim_token END,
         claim_expires_at=CASE WHEN $4 THEN NULL ELSE claim_expires_at END,
         updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`,
      [id, nextStatus, immediate ? 'paused_by_user' : task.currentStep, immediate],
    );
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async resume(id: string, version?: number): Promise<DelegatedTask | null> {
    const task = await this.get(id);
    if (!task || isTerminalTaskStatus(task.status) || (version !== undefined && task.version !== version)) return task;
    if (task.status !== 'deferred' || !task.pauseRequested) return task;
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE delegated_tasks SET pause_requested=false, status='queued', current_step=NULL,
         next_eligible_at=NULL, updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`,
      [id],
    );
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async requestCancel(id: string, version?: number): Promise<DelegatedTask | null> {
    const task = await this.get(id);
    if (!task || isTerminalTaskStatus(task.status) || (version !== undefined && task.version !== version)) return task;
    const inFlight = task.status === 'planning' || task.status === 'executing';
    if (inFlight) {
      const { rows } = await this.pool.query<TaskRow>(
        `UPDATE delegated_tasks SET cancel_requested=true, updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`,
        [id],
      );
      return rows[0] ? mapTask(rows[0]) : null;
    }
    const status = honestTerminalStatus(task.progress, 'cancelled');
    return this.complete(id, null, status, {
      code: 'remaining_cancelled_by_user',
      message: '用户取消尚未执行的剩余部分',
      remainingCount: Math.max(0, task.targetSuccessCount - task.progress.successCount),
    });
  }

  async complete(
    id: string,
    claimToken: string | null,
    status: DelegatedTaskStatus,
    outcome: DelegatedTerminalOutcome,
  ): Promise<DelegatedTask | null> {
    if (!isTerminalTaskStatus(status) && status !== 'deferred' && status !== 'waiting_approval') {
      throw new Error(`invalid_complete_status:${status}`);
    }
    const task = await this.get(id);
    if (!task) return null;
    if (claimToken !== null && task.claimToken !== claimToken) return task;
    if (isTerminalTaskStatus(task.status)) return task;
    assertTaskTransition(task.status, status);
    const terminal = isTerminalTaskStatus(status);
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE delegated_tasks SET status=$2, terminal_outcome=$3, claim_token=NULL, claim_expires_at=NULL,
         current_step=NULL, completed_at=CASE WHEN $4 THEN now() ELSE completed_at END,
         updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`,
      [id, status, JSON.stringify(outcome), terminal],
    );
    if (rows[0]) await this.event(id, 'task_status', task.status, status, outcome as unknown as Record<string, unknown>);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async hasActiveOwnership(accountId: string, family: DelegatedActionFamily, excludingTaskId?: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ present: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM delegated_tasks WHERE account_id=$1 AND action_family=$2
           AND status IN ('planning','waiting_approval','executing')
           AND ($3::uuid IS NULL OR id <> $3::uuid)
       ) AS present`,
      [accountId, family, excludingTaskId ?? null],
    );
    return Boolean(rows[0]?.present);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async event(
    taskId: string,
    eventType: string,
    fromStatus: DelegatedTaskStatus | null,
    toStatus: DelegatedTaskStatus | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO delegated_task_events(task_id,event_type,from_status,to_status,detail) VALUES($1,$2,$3,$4,$5)`,
      [taskId, eventType, fromStatus, toStatus, JSON.stringify(detail)],
    );
  }
}

/** Deterministic store for domain/worker tests. It follows the same transition and claim rules. */
export class MemoryDelegatedTaskStore implements DelegatedTaskStore {
  private readonly tasks = new Map<string, DelegatedTask>();
  private readonly attempts = new Map<string, DelegatedTaskAttempt>();

  async init(): Promise<void> {}

  async createDraft(input: DelegatedTaskCreate): Promise<{ task: DelegatedTask; created: boolean }> {
    const existing = [...this.tasks.values()].find((t) => t.dedupeKey === input.dedupeKey && !isTerminalTaskStatus(t.status));
    if (existing) return { task: structuredClone(existing), created: false };
    const now = Date.now();
    const task: DelegatedTask = {
      id: randomUUID(), accountId: input.accountId, accountName: input.accountName, platform: input.platform,
      action: input.action, actionFamily: actionFamilyFor(input.action), targetSuccessCount: input.targetSuccessCount,
      maxAttempts: input.maxAttempts, deadlineAt: input.deadlineAt, notBefore: input.notBefore ?? now,
      executionWindow: input.executionWindow ?? { mode: 'immediate' },
      sourceConstraints: input.sourceConstraints ?? {}, targetConstraints: input.targetConstraints ?? {},
      approvalMode: input.approvalMode ?? (input.action === 'generate_candidates' ? 'draft_only' : 'review'),
      priority: input.priority ?? 'normal', source: input.source, sourceRef: input.sourceRef ?? null,
      status: 'awaiting_confirmation', progress: { successCount: 0, attemptCount: 0, skippedCount: 0, failureCount: 0 },
      currentStep: null, terminalOutcome: null, pauseRequested: false, cancelRequested: false,
      nextEligibleAt: null, claimToken: null, claimExpiresAt: null, dedupeKey: input.dedupeKey,
      version: 1, createdAt: now, updatedAt: now, confirmedAt: null, completedAt: null,
    };
    this.tasks.set(task.id, task);
    return { task: structuredClone(task), created: true };
  }

  async get(id: string): Promise<DelegatedTask | null> {
    const t = this.tasks.get(id);
    return t ? structuredClone(t) : null;
  }

  async list(filter: { accountId?: string; limit?: number } = {}): Promise<DelegatedTask[]> {
    return [...this.tasks.values()]
      .filter((t) => !filter.accountId || t.accountId === filter.accountId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, filter.limit ?? 50)
      .map((t) => structuredClone(t));
  }

  async confirm(id: string, version: number): Promise<DelegatedTask | null> {
    const t = this.tasks.get(id);
    if (!t) return null;
    if (t.status === 'awaiting_confirmation' && t.version === version) this.mutate(t, { status: 'queued', confirmedAt: Date.now() });
    return structuredClone(t);
  }

  async claimNext(opts: { workerId: string; leaseMs: number; now?: number }): Promise<DelegatedTask | null> {
    const now = opts.now ?? Date.now();
    const candidates = [...this.tasks.values()].filter((t) =>
      (t.status === 'queued' || t.status === 'deferred' || t.status === 'waiting_approval') && !t.pauseRequested && !t.cancelRequested &&
      t.notBefore <= now && (t.nextEligibleAt === null || t.nextEligibleAt <= now) && t.deadlineAt > now &&
      (t.claimExpiresAt === null || t.claimExpiresAt <= now));
    candidates.sort((a, b) => (a.priority === b.priority ? a.deadlineAt - b.deadlineAt : a.priority === 'high' ? -1 : 1));
    const t = candidates[0];
    if (!t) return null;
    const fromWaiting = t.status === 'waiting_approval';
    const claim = { claimToken: `${opts.workerId}:${randomUUID()}`, claimExpiresAt: now + opts.leaseMs };
    if (fromWaiting) {
      Object.assign(t, claim, { currentStep: 'reconcile_waiting_approval', updatedAt: now });
    } else {
      this.mutate(t, { ...claim, status: 'planning', currentStep: 'planning' });
    }
    return structuredClone(t);
  }

  async markExecuting(id: string, token: string, step: string): Promise<DelegatedTask | null> {
    const t = this.tasks.get(id);
    if (!t || t.claimToken !== token || t.status !== 'planning') return t ? structuredClone(t) : null;
    this.mutate(t, { status: 'executing', currentStep: step });
    return structuredClone(t);
  }

  async releaseClaim(id: string, token: string, nextStatus: DelegatedTaskStatus, opts: { nextEligibleAt?: number; step?: string } = {}): Promise<DelegatedTask | null> {
    const t = this.tasks.get(id);
    if (!t || t.claimToken !== token) return t ? structuredClone(t) : null;
    assertTaskTransition(t.status, nextStatus);
    this.mutate(t, { status: nextStatus, claimToken: null, claimExpiresAt: null, nextEligibleAt: opts.nextEligibleAt ?? null, currentStep: opts.step ?? null });
    return structuredClone(t);
  }

  async releaseWaitingApprovalClaim(id: string, token: string, nextEligibleAt: number): Promise<DelegatedTask | null> {
    const t = this.tasks.get(id);
    if (!t || t.claimToken !== token || t.status !== 'waiting_approval') return t ? structuredClone(t) : null;
    Object.assign(t, {
      claimToken: null,
      claimExpiresAt: null,
      nextEligibleAt,
      currentStep: 'waiting_approval',
      updatedAt: Date.now(),
    });
    return structuredClone(t);
  }

  async startAttempt(taskId: string, token: string, targetKey: string): Promise<DelegatedTaskAttempt> {
    const t = this.tasks.get(taskId);
    if (!t || t.claimToken !== token) throw new Error('task_claim_mismatch');
    const duplicate = [...this.attempts.values()].find((a) => a.taskId === taskId && a.targetKey === targetKey);
    if (duplicate) throw new Error('duplicate_attempt_target');
    const attempt: DelegatedTaskAttempt = {
      id: randomUUID(), taskId, ordinal: [...this.attempts.values()].filter((a) => a.taskId === taskId).length + 1,
      targetKey, status: 'prepared', verificationKind: null, evidenceRef: null, reason: null,
      preparedAt: Date.now(), dispatchedAt: null, finishedAt: null,
    };
    this.attempts.set(attempt.id, attempt);
    return structuredClone(attempt);
  }

  async markAttemptDispatched(id: string): Promise<void> {
    const a = this.attempts.get(id);
    if (a?.status === 'prepared') {
      Object.assign(a, { status: 'dispatched' as const, dispatchedAt: Date.now() });
      const task = this.tasks.get(a.taskId);
      if (task) {
        task.progress.attemptCount += 1;
        this.mutate(task, {});
      }
    }
  }

  async annotateAttempt(id: string, verificationKind: DelegatedVerificationKind, evidenceRef: string, reason?: string): Promise<void> {
    const a = this.attempts.get(id);
    if (a && (a.status === 'prepared' || a.status === 'dispatched')) {
      Object.assign(a, { verificationKind, evidenceRef, reason: reason ?? null });
    }
  }

  async finishAttempt(id: string, result: AttemptFinish): Promise<DelegatedTask> {
    const a = this.attempts.get(id);
    if (!a || (a.status !== 'prepared' && a.status !== 'dispatched')) throw new Error('attempt_already_finished_or_missing');
    Object.assign(a, { status: result.status, verificationKind: result.verificationKind, evidenceRef: result.evidenceRef ?? null, reason: result.reason ?? null, finishedAt: Date.now() });
    const t = this.tasks.get(a.taskId)!;
    if (result.status === 'succeeded' && verificationCountsAsSuccess(t.action, result.verificationKind)) t.progress.successCount += 1;
    if (result.status === 'skipped') t.progress.skippedCount += 1;
    if (result.status === 'failed' || result.status === 'submitted_unknown') t.progress.failureCount += 1;
    this.mutate(t, {});
    return structuredClone(t);
  }

  async listUnsettledAttempts(taskId: string): Promise<DelegatedTaskAttempt[]> {
    return [...this.attempts.values()].filter((a) => a.taskId === taskId && (a.status === 'prepared' || a.status === 'dispatched')).map((a) => structuredClone(a));
  }

  async requestPause(id: string, version?: number): Promise<DelegatedTask | null> {
    const t = this.tasks.get(id);
    if (!t || isTerminalTaskStatus(t.status) || (version !== undefined && t.version !== version)) return t ? structuredClone(t) : null;
    const immediate = t.status === 'queued' || t.status === 'deferred' || t.status === 'awaiting_confirmation';
    this.mutate(t, { pauseRequested: true, ...(immediate ? { status: 'deferred' as const, claimToken: null, claimExpiresAt: null, currentStep: 'paused_by_user' } : {}) });
    return structuredClone(t);
  }

  async resume(id: string, version?: number): Promise<DelegatedTask | null> {
    const t = this.tasks.get(id);
    if (!t || (version !== undefined && t.version !== version)) return t ? structuredClone(t) : null;
    if (t.status === 'deferred' && t.pauseRequested) this.mutate(t, { status: 'queued', pauseRequested: false, currentStep: null, nextEligibleAt: null });
    return structuredClone(t);
  }

  async requestCancel(id: string, version?: number): Promise<DelegatedTask | null> {
    const t = this.tasks.get(id);
    if (!t || isTerminalTaskStatus(t.status) || (version !== undefined && t.version !== version)) return t ? structuredClone(t) : null;
    if (t.status === 'planning' || t.status === 'executing') {
      this.mutate(t, { cancelRequested: true });
      return structuredClone(t);
    }
    const status = honestTerminalStatus(t.progress, 'cancelled');
    return this.complete(id, null, status, { code: 'remaining_cancelled_by_user', message: '用户取消尚未执行的剩余部分' });
  }

  async complete(id: string, token: string | null, status: DelegatedTaskStatus, outcome: DelegatedTerminalOutcome): Promise<DelegatedTask | null> {
    const t = this.tasks.get(id);
    if (!t || (token !== null && t.claimToken !== token)) return t ? structuredClone(t) : null;
    if (isTerminalTaskStatus(t.status)) return structuredClone(t);
    assertTaskTransition(t.status, status);
    this.mutate(t, { status, terminalOutcome: outcome, claimToken: null, claimExpiresAt: null, currentStep: null, completedAt: isTerminalTaskStatus(status) ? Date.now() : t.completedAt });
    return structuredClone(t);
  }

  async hasActiveOwnership(accountId: string, family: DelegatedActionFamily, excludingTaskId?: string): Promise<boolean> {
    return [...this.tasks.values()].some((t) => t.accountId === accountId && t.actionFamily === family && t.id !== excludingTaskId &&
      ['planning', 'waiting_approval', 'executing'].includes(t.status));
  }

  private mutate(task: DelegatedTask, patch: Partial<DelegatedTask>): void {
    Object.assign(task, patch, { version: task.version + 1, updatedAt: Date.now() });
  }
}
