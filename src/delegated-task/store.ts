import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import type {
  DelegatedActionFamily,
  DelegatedExecutionTarget,
  DelegatedPlatformId,
  DelegatedTask,
  DelegatedTaskAttempt,
  DelegatedTaskIntent,
  DelegatedTaskStatus,
  DelegatedTerminalOutcome,
  DelegatedVerificationKind,
} from './types.js';
import { delegatedTasksConflict } from './ownership.js';
import {
  actionFamilyFor,
  assertTaskTransition,
  honestTerminalStatus,
  isTerminalTaskStatus,
  verificationCountsAsSuccess,
} from './types.js';
import { ensureCapabilitySchema } from '../schema/schema-capability.js';

const { Pool } = pg;

export const DELEGATED_TASK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS delegated_tasks (
  id                    UUID PRIMARY KEY,
  execution_target      TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  -- 跨 owner 外键（引 accounts，另一服务所有）。additive 拆库前置：共库期保留此约束。
  -- 拆库后的替代已就位在 claimNext 的读侧 fail-closed —— 那里已改读**本域的账号投影表**
  -- （change automation-accounts-projection），不再内联 accounts。降约束本身押到拆库那刻，
  -- 语句已备在 scripts/db-split/0076_downgrade_cross_owner_account_fk.sql（delegated_tasks_account_id_fkey
  -- 那一行），此处不删。
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
-- change restore-delegated-command-card-origin-chat：命令来源会话（操作员向卡片投递目标）。
-- 无迁移器、schema 启动自建；幂等 ADD COLUMN，旧行为 NULL = 回落既有默认 / 团队路由，零回归。
ALTER TABLE delegated_tasks ADD COLUMN IF NOT EXISTS origin_chat_id TEXT;
-- scope-delegated-tasks-by-cloud-target：历史任务由用户确认全部属于 dev。
-- 先回填再收紧；不保留列默认值，未来每条新任务都必须由可信 Cloud target 显式写入。
ALTER TABLE delegated_tasks ADD COLUMN IF NOT EXISTS execution_target TEXT;
UPDATE delegated_tasks SET execution_target='dev' WHERE execution_target IS NULL;
ALTER TABLE delegated_tasks ALTER COLUMN execution_target SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='delegated_tasks'::regclass
       AND conname='delegated_tasks_execution_target_check'
  ) THEN
    ALTER TABLE delegated_tasks
      ADD CONSTRAINT delegated_tasks_execution_target_check
      CHECK (execution_target IN ('dev','ol'));
  END IF;
END $$;
DROP INDEX IF EXISTS idx_delegated_tasks_active_dedupe;
CREATE UNIQUE INDEX IF NOT EXISTS idx_delegated_tasks_target_active_dedupe
  ON delegated_tasks(execution_target, dedupe_key)
  WHERE status IN ('draft','awaiting_confirmation','queued','planning','waiting_approval','executing','deferred');
DROP INDEX IF EXISTS idx_delegated_tasks_claim;
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_target_claim
  ON delegated_tasks(execution_target, status, next_eligible_at, not_before, deadline_at, priority, created_at);
DROP INDEX IF EXISTS idx_delegated_tasks_ownership;
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_target_ownership
  ON delegated_tasks(execution_target, account_id, action_family, status);
-- split-curated-creation-status-filters：灵感库按账号判断是否曾触发精选洗稿。
-- 两个局部表达式索引允许 curatedId/sourceId 的 OR 谓词走 BitmapOr，任务终态不参与归类。
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_curated_publish_id
  ON delegated_tasks(account_id, (source_constraints->>'curatedId'))
  WHERE action = 'publish_post';
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_curated_publish_source
  ON delegated_tasks(account_id, (source_constraints->>'sourceId'))
  WHERE action = 'publish_post';

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
  platform: DelegatedPlatformId;
  dedupeKey: string;
}

export interface DelegatedTaskListFilter {
  accountId?: string;
  actionFamily?: DelegatedActionFamily;
  statuses?: DelegatedTaskStatus[];
  limit?: number;
}

export interface AttemptFinish {
  status: 'succeeded' | 'skipped' | 'failed' | 'submitted_unknown';
  verificationKind: DelegatedVerificationKind;
  evidenceRef?: string;
  reason?: string;
}

export interface InterruptedClaimRecovery {
  task: DelegatedTask;
  fromStatus: 'planning' | 'executing';
  previousClaimExpiresAt: number | null;
}

export interface DelegatedTaskStore {
  init(): Promise<void>;
  createDraft(input: DelegatedTaskCreate): Promise<{ task: DelegatedTask; created: boolean }>;
  get(id: string): Promise<DelegatedTask | null>;
  list(filter?: DelegatedTaskListFilter): Promise<DelegatedTask[]>;
  /** One-shot process-start recovery. Never call while this process is executing delegated work. */
  recoverInterruptedClaims(now?: number): Promise<InterruptedClaimRecovery[]>;
  confirm(id: string, version: number): Promise<DelegatedTask | null>;
  claimNext(opts: { workerId: string; leaseMs: number; now?: number }): Promise<DelegatedTask | null>;
  markExecuting(id: string, claimToken: string, step: string): Promise<DelegatedTask | null>;
  releaseClaim(id: string, claimToken: string, nextStatus: DelegatedTaskStatus, opts?: { nextEligibleAt?: number; step?: string; reason?: string }): Promise<DelegatedTask | null>;
  releaseWaitingApprovalClaim(id: string, claimToken: string, nextEligibleAt: number): Promise<DelegatedTask | null>;
  startAttempt(taskId: string, claimToken: string, targetKey: string): Promise<DelegatedTaskAttempt>;
  markAttemptDispatched(attemptId: string): Promise<void>;
  /** 仅用于已证明零动作的等待：原子移除临时账本，并在需要时撤回 attempt_count。 */
  discardAttemptBeforeStart(attemptId: string, reason: string): Promise<DelegatedTask>;
  annotateAttempt(attemptId: string, verificationKind: DelegatedVerificationKind, evidenceRef: string, reason?: string): Promise<void>;
  finishAttempt(attemptId: string, result: AttemptFinish): Promise<DelegatedTask>;
  listUnsettledAttempts(taskId: string): Promise<DelegatedTaskAttempt[]>;
  /**
   * 全部 attempt（含已 settle 的 succeeded / skipped / failed / submitted_unknown），按 ordinal 升序。
   *
   * change delegated-terminal-failure-reason：终态回执要说「为什么没成」，原因就躺在已 settle 的
   * attempt 的 `reason` 里——而 `listUnsettledAttempts` 按构造只返回 prepared / dispatched，对已 settle
   * 的 failed / skipped 恒返回 []，恰好排除掉要读的那些。故另开此读路径，勿改前者（对账链依赖其语义）。
   */
  listAttempts(taskId: string): Promise<DelegatedTaskAttempt[]>;
  requestPause(id: string, version?: number): Promise<DelegatedTask | null>;
  resume(id: string, version?: number): Promise<DelegatedTask | null>;
  requestCancel(id: string, version?: number): Promise<DelegatedTask | null>;
  complete(id: string, claimToken: string | null, status: DelegatedTaskStatus, outcome: DelegatedTerminalOutcome): Promise<DelegatedTask | null>;
  hasActiveOwnership(accountId: string, family: DelegatedActionFamily, excludingTaskId?: string): Promise<boolean>;
  hasTaskOwnershipConflict(task: DelegatedTask): Promise<boolean>;
  close?(): Promise<void>;
}

interface TaskRow {
  id: string;
  execution_target: DelegatedExecutionTarget;
  account_id: string;
  account_name: string;
  platform: DelegatedPlatformId;
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
  origin_chat_id: string | null;
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

interface InterruptedTaskRow extends TaskRow {
  recovered_from: 'planning' | 'executing';
  previous_claim_expires_at: Date | string | null;
}

const epoch = (v: Date | string | null): number | null => (v ? new Date(v).getTime() : null);

function mapTask(r: TaskRow): DelegatedTask {
  return {
    id: r.id,
    executionTarget: r.execution_target,
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
    originChatId: r.origin_chat_id,
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
  executionTarget: DelegatedExecutionTarget;
}

export class PgDelegatedTaskStore implements DelegatedTaskStore {
  private readonly pool: pg.Pool;
  private readonly executionTarget: DelegatedExecutionTarget;

  constructor(options: PgDelegatedTaskStoreOptions) {
    this.executionTarget = options.executionTarget;
    this.pool = options.pool ?? new Pool({
      host: options.host ?? DEFAULT_PG_CONFIG.host,
      port: options.port ?? DEFAULT_PG_CONFIG.port,
      database: options.database ?? DEFAULT_PG_CONFIG.database,
      user: options.user ?? DEFAULT_PG_CONFIG.user,
      password: options.password ?? DEFAULT_PG_CONFIG.password,
    });
  }

  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await ensureCapabilitySchema(this.pool, {
      capability: 'delegated_tasks',
      sinceVersion: '0038_delegated_tasks',
      ddl: [DELEGATED_TASK_SCHEMA_SQL],
    });
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
      input.originChatId ?? null, this.executionTarget,
    ];
    try {
      const { rows } = await this.pool.query<TaskRow>(
        `INSERT INTO delegated_tasks (
           id, account_id, account_name, platform, action, action_family,
           target_success_count, max_attempts, deadline_at, not_before, execution_window,
           source_constraints, target_constraints, approval_mode, priority, source, source_ref,
           status, dedupe_key, origin_chat_id, execution_target
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'awaiting_confirmation',$18,$19,$20)
         RETURNING *`,
        values,
      );
      await this.pool.query(
        `INSERT INTO delegated_task_events(task_id,event_type,to_status,detail) VALUES($1,'draft_created','awaiting_confirmation',$2)`,
        [id, JSON.stringify({ source: input.source, executionTarget: this.executionTarget })],
      );
      return { task: mapTask(rows[0]), created: true };
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      const { rows } = await this.pool.query<TaskRow>(
        `SELECT * FROM delegated_tasks WHERE dedupe_key=$1 AND execution_target=$2 AND status IN
         ('draft','awaiting_confirmation','queued','planning','waiting_approval','executing','deferred')
         ORDER BY created_at DESC LIMIT 1`,
        [input.dedupeKey, this.executionTarget],
      );
      if (!rows[0]) throw err;
      return { task: mapTask(rows[0]), created: false };
    }
  }

  async get(id: string): Promise<DelegatedTask | null> {
    const { rows } = await this.pool.query<TaskRow>(
      'SELECT * FROM delegated_tasks WHERE id=$1 AND execution_target=$2',
      [id, this.executionTarget],
    );
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async list(filter: DelegatedTaskListFilter = {}): Promise<DelegatedTask[]> {
    const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
    const predicates: string[] = ['execution_target=$1'];
    const args: unknown[] = [this.executionTarget];
    if (filter.accountId) {
      args.push(filter.accountId);
      predicates.push(`account_id=$${args.length}`);
    }
    if (filter.actionFamily) {
      args.push(filter.actionFamily);
      predicates.push(`action_family=$${args.length}`);
    }
    if (filter.statuses?.length) {
      args.push(filter.statuses);
      predicates.push(`status = ANY($${args.length}::text[])`);
    }
    args.push(limit);
    const where = ` WHERE ${predicates.join(' AND ')}`;
    const sql = `SELECT * FROM delegated_tasks${where} ORDER BY created_at DESC LIMIT $${args.length}`;
    const { rows } = await this.pool.query<TaskRow>(sql, args);
    return rows.map(mapTask);
  }

  /**
   * 「已触发发帖」引用集（TriggeredPublishRefsReader 端口实现，属主 automation）：该账号 + target 下
   * publish_post 委托任务的 curatedId / sourceId（去重、剔空）。供 content 的精选内容存储判定 created/uncreated，
   * 让它经本接口要、而非直连 automation 库。
   */
  async triggeredPublishRefs(
    accountId: string,
    executionTarget: string,
  ): Promise<{ curatedIds: string[]; sourceIds: string[] }> {
    const { rows } = await this.pool.query<{ cid: string | null; sid: string | null }>(
      `SELECT DISTINCT source_constraints->>'curatedId' AS cid, source_constraints->>'sourceId' AS sid
         FROM delegated_tasks
        WHERE execution_target = $1 AND account_id = $2 AND action = 'publish_post'`,
      [executionTarget, accountId],
    );
    const curatedIds = [...new Set(rows.map((r) => r.cid).filter((v): v is string => v != null && v !== ''))];
    const sourceIds = [...new Set(rows.map((r) => r.sid).filter((v): v is string => v != null && v !== ''))];
    return { curatedIds, sourceIds };
  }

  async recoverInterruptedClaims(now = Date.now()): Promise<InterruptedClaimRecovery[]> {
    const recoveredAt = new Date(now);
    const { rows } = await this.pool.query<InterruptedTaskRow>(
      `WITH interrupted AS (
         SELECT id, status AS recovered_from, claim_expires_at AS previous_claim_expires_at
         FROM delegated_tasks
         WHERE execution_target=$2 AND status IN ('planning','executing')
         FOR UPDATE
       ), recovered AS (
         UPDATE delegated_tasks t SET
           status=CASE
             WHEN t.cancel_requested AND t.success_count > 0 THEN 'partially_completed'
             WHEN t.cancel_requested THEN 'cancelled'
             WHEN t.pause_requested THEN 'deferred'
             ELSE 'queued'
           END,
           terminal_outcome=CASE WHEN t.cancel_requested THEN jsonb_build_object(
             'code','remaining_cancelled_by_user',
             'message','Cloud 重启时任务已请求取消；已取消剩余部分。',
             'remainingCount',GREATEST(t.target_success_count-t.success_count,0)
           ) ELSE t.terminal_outcome END,
           claim_token=NULL,
           claim_expires_at=NULL,
           next_eligible_at=CASE
             WHEN t.pause_requested OR t.cancel_requested THEN NULL
             ELSE $1::timestamptz
           END,
           current_step=CASE
             WHEN t.cancel_requested THEN NULL
             WHEN t.pause_requested THEN 'paused_by_user'
             ELSE 'reconcile_interrupted_attempt'
           END,
           completed_at=CASE WHEN t.cancel_requested THEN $1::timestamptz ELSE t.completed_at END,
           updated_at=$1::timestamptz,
           version=t.version+1
         FROM interrupted i
         WHERE t.id=i.id
         RETURNING t.*, i.recovered_from, i.previous_claim_expires_at
       ), logged AS (
         INSERT INTO delegated_task_events(task_id,event_type,from_status,to_status,detail)
         SELECT id,'interrupted_claim_recovered',recovered_from,status,
                jsonb_build_object(
                  'reason','worker_restart',
                  'previousClaimExpiresAt',previous_claim_expires_at,
                  'recoveredAt',$1::timestamptz
                )
         FROM recovered
         RETURNING task_id
       )
       SELECT recovered.* FROM recovered`,
      [recoveredAt, this.executionTarget],
    );
    return rows.map((row) => ({
      task: mapTask(row),
      fromStatus: row.recovered_from,
      previousClaimExpiresAt: epoch(row.previous_claim_expires_at),
    }));
  }

  async confirm(id: string, version: number): Promise<DelegatedTask | null> {
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE delegated_tasks SET status='queued', confirmed_at=now(), updated_at=now(), version=version+1
       WHERE id=$1 AND status='awaiting_confirmation' AND version=$2 AND execution_target=$3 RETURNING *`,
      [id, version, this.executionTarget],
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
         WHERE execution_target=$4 AND status IN ('queued','deferred','waiting_approval')
           AND pause_requested=false AND cancel_requested=false
           AND not_before <= $1 AND (next_eligible_at IS NULL OR next_eligible_at <= $1)
           AND deadline_at > $1 AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
           -- 账号存在性守卫（change automation-accounts-projection）：改读**本域**的账号投影表，
           -- 不再内联 api 属主的 accounts。守卫因此回到同库、留在这条认领语句内，
           -- 下面那句行锁（SKIP LOCKED）锁的本来也只有 delegated_tasks 自己（从无跨属主行锁）。
           -- 缺行 / 投影陈旧 / 投影从未刷过 → 断言判否 → 任务不被 claim（fail-closed，
           -- 绝不替一个我们已经说不准还在不在的账号动手）。
           AND EXISTS (
             SELECT 1 FROM automation_account_projection a
             WHERE a.account_id = delegated_tasks.account_id
           )
           AND EXISTS (
             SELECT 1 FROM automation_account_projection_state apj_state
             WHERE apj_state.fresh_until > now()
           )
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
      [now, token, expires, this.executionTarget],
    );
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async markExecuting(id: string, claimToken: string, step: string): Promise<DelegatedTask | null> {
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE delegated_tasks SET status='executing', current_step=$3, updated_at=now(), version=version+1
       WHERE id=$1 AND claim_token=$2 AND status='planning' AND execution_target=$4 RETURNING *`,
      [id, claimToken, step, this.executionTarget],
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
       WHERE id=$1 AND claim_token=$2 AND execution_target=$6 RETURNING *`,
      [id, claimToken, nextStatus, opts.nextEligibleAt ? new Date(opts.nextEligibleAt) : null, opts.step ?? null, this.executionTarget],
    );
    if (rows[0]) await this.event(id, 'claim_released', before.status, nextStatus, { reason: opts.reason ?? null });
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async releaseWaitingApprovalClaim(id: string, claimToken: string, nextEligibleAt: number): Promise<DelegatedTask | null> {
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE delegated_tasks SET claim_token=NULL, claim_expires_at=NULL,
         next_eligible_at=$3, current_step='waiting_approval', updated_at=now()
       WHERE id=$1 AND claim_token=$2 AND status='waiting_approval' AND execution_target=$4 RETURNING *`,
      [id, claimToken, new Date(nextEligibleAt), this.executionTarget],
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
         UPDATE delegated_task_attempts a SET status='dispatched', dispatched_at=now()
         FROM delegated_tasks scoped
         WHERE a.id=$1 AND a.status='prepared' AND scoped.id=a.task_id
           AND scoped.execution_target=$2
         RETURNING a.task_id
       )
       UPDATE delegated_tasks t SET attempt_count=attempt_count+1, updated_at=now(), version=version+1
       FROM marked WHERE t.id=marked.task_id AND t.execution_target=$2`,
      [attemptId, this.executionTarget],
    );
  }

  async discardAttemptBeforeStart(attemptId: string, reason: string): Promise<DelegatedTask> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const attemptRows = await client.query<AttemptRow>(
        `DELETE FROM delegated_task_attempts a USING delegated_tasks scoped
         WHERE a.id=$1 AND a.status IN ('prepared','dispatched') AND scoped.id=a.task_id
           AND scoped.execution_target=$2
         RETURNING a.*`,
        [attemptId, this.executionTarget],
      );
      const attempt = attemptRows.rows[0];
      if (!attempt) throw new Error('attempt_already_finished_or_missing');
      const dispatched = attempt.status === 'dispatched';
      const taskRows = await client.query<TaskRow>(
        `UPDATE delegated_tasks SET attempt_count=GREATEST(attempt_count-$2,0), updated_at=now(), version=version+1
         WHERE id=$1 AND execution_target=$3 RETURNING *`,
        [attempt.task_id, dispatched ? 1 : 0, this.executionTarget],
      );
      if (!taskRows.rows[0]) throw new Error('attempt_task_missing');
      await client.query(
        `INSERT INTO delegated_task_events(task_id,event_type,detail) VALUES($1,'attempt_discarded_before_start',$2)`,
        [attempt.task_id, JSON.stringify({ attemptId, reason, dispatched })],
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

  async annotateAttempt(attemptId: string, verificationKind: DelegatedVerificationKind, evidenceRef: string, reason?: string): Promise<void> {
    await this.pool.query(
      `UPDATE delegated_task_attempts a SET verification_kind=$2, evidence_ref=$3, reason=$4
       FROM delegated_tasks scoped
       WHERE a.id=$1 AND a.status IN ('prepared','dispatched') AND scoped.id=a.task_id
         AND scoped.execution_target=$5`,
      [attemptId, verificationKind, evidenceRef, reason ?? null, this.executionTarget],
    );
  }

  async finishAttempt(attemptId: string, result: AttemptFinish): Promise<DelegatedTask> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const attemptRows = await client.query<AttemptRow>(
        `UPDATE delegated_task_attempts a SET status=$2, verification_kind=$3, evidence_ref=$4,
           reason=$5, finished_at=now() FROM delegated_tasks scoped
         WHERE a.id=$1 AND a.status IN ('prepared','dispatched') AND scoped.id=a.task_id
           AND scoped.execution_target=$6 RETURNING a.*`,
        [attemptId, result.status, result.verificationKind, result.evidenceRef ?? null, result.reason ?? null, this.executionTarget],
      );
      const attempt = attemptRows.rows[0];
      if (!attempt) throw new Error('attempt_already_finished_or_missing');
      const currentTask = await client.query<Pick<TaskRow, 'action'>>(
        'SELECT action FROM delegated_tasks WHERE id=$1 AND execution_target=$2 FOR UPDATE',
        [attempt.task_id, this.executionTarget],
      );
      if (!currentTask.rows[0]) throw new Error('attempt_task_missing');
      const success = result.status === 'succeeded' && verificationCountsAsSuccess(currentTask.rows[0].action, result.verificationKind) ? 1 : 0;
      const skipped = result.status === 'skipped' ? 1 : 0;
      const failure = result.status === 'failed' || result.status === 'submitted_unknown' ? 1 : 0;
      const taskRows = await client.query<TaskRow>(
        `UPDATE delegated_tasks SET success_count=success_count+$2,
           skipped_count=skipped_count+$3, failure_count=failure_count+$4, updated_at=now(), version=version+1
         WHERE id=$1 AND execution_target=$5 RETURNING *`,
        [attempt.task_id, success, skipped, failure, this.executionTarget],
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
      `SELECT a.* FROM delegated_task_attempts a
       JOIN delegated_tasks scoped ON scoped.id=a.task_id AND scoped.execution_target=$2
       WHERE a.task_id=$1 AND a.status IN ('prepared','dispatched') ORDER BY a.ordinal`,
      [taskId, this.executionTarget],
    );
    return rows.map(mapAttempt);
  }

  async listAttempts(taskId: string): Promise<DelegatedTaskAttempt[]> {
    const { rows } = await this.pool.query<AttemptRow>(
      `SELECT a.* FROM delegated_task_attempts a
       JOIN delegated_tasks scoped ON scoped.id=a.task_id AND scoped.execution_target=$2
       WHERE a.task_id=$1 ORDER BY a.ordinal`,
      [taskId, this.executionTarget],
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
         updated_at=now(), version=version+1 WHERE id=$1 AND execution_target=$5 RETURNING *`,
      [id, nextStatus, immediate ? 'paused_by_user' : task.currentStep, immediate, this.executionTarget],
    );
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async resume(id: string, version?: number): Promise<DelegatedTask | null> {
    const task = await this.get(id);
    if (!task || isTerminalTaskStatus(task.status) || (version !== undefined && task.version !== version)) return task;
    if (task.status !== 'deferred' || !task.pauseRequested) return task;
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE delegated_tasks SET pause_requested=false, status='queued', current_step=NULL,
         next_eligible_at=NULL, updated_at=now(), version=version+1
       WHERE id=$1 AND execution_target=$2 RETURNING *`,
      [id, this.executionTarget],
    );
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async requestCancel(id: string, version?: number): Promise<DelegatedTask | null> {
    const task = await this.get(id);
    if (!task || isTerminalTaskStatus(task.status) || (version !== undefined && task.version !== version)) return task;
    const inFlight = task.status === 'planning' || task.status === 'executing';
    if (inFlight) {
      const { rows } = await this.pool.query<TaskRow>(
        `UPDATE delegated_tasks SET cancel_requested=true, updated_at=now(), version=version+1
         WHERE id=$1 AND execution_target=$2 RETURNING *`,
        [id, this.executionTarget],
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
         updated_at=now(), version=version+1
       WHERE id=$1 AND execution_target=$5 RETURNING *`,
      [id, status, JSON.stringify(outcome), terminal, this.executionTarget],
    );
    if (rows[0]) await this.event(id, 'task_status', task.status, status, outcome as unknown as Record<string, unknown>);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async hasActiveOwnership(accountId: string, family: DelegatedActionFamily, excludingTaskId?: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ present: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM delegated_tasks WHERE execution_target=$1 AND account_id=$2 AND action_family=$3
           AND status IN ('planning','waiting_approval','executing')
           AND ($4::uuid IS NULL OR id <> $4::uuid)
       ) AS present`,
      [this.executionTarget, accountId, family, excludingTaskId ?? null],
    );
    return Boolean(rows[0]?.present);
  }

  async hasTaskOwnershipConflict(task: DelegatedTask): Promise<boolean> {
    const { rows } = await this.pool.query<TaskRow>(
      `SELECT * FROM delegated_tasks WHERE execution_target=$1 AND account_id=$2 AND action_family=$3
         AND status IN ('planning','waiting_approval','executing')
         AND id <> $4::uuid`,
      [this.executionTarget, task.accountId, task.actionFamily, task.id],
    );
    return rows.some((row) => delegatedTasksConflict(task, mapTask(row)));
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
  readonly interruptedClaimEvents: Array<{
    taskId: string;
    fromStatus: 'planning' | 'executing';
    toStatus: DelegatedTaskStatus;
    previousClaimExpiresAt: number | null;
    recoveredAt: number;
  }> = [];

  constructor(private readonly executionTarget: DelegatedExecutionTarget = 'dev') {}

  async init(): Promise<void> {}

  async createDraft(input: DelegatedTaskCreate): Promise<{ task: DelegatedTask; created: boolean }> {
    const existing = [...this.tasks.values()].find((t) => t.dedupeKey === input.dedupeKey && !isTerminalTaskStatus(t.status));
    if (existing) return { task: structuredClone(existing), created: false };
    const now = Date.now();
    const task: DelegatedTask = {
      id: randomUUID(), executionTarget: this.executionTarget,
      accountId: input.accountId, accountName: input.accountName, platform: input.platform,
      action: input.action, actionFamily: actionFamilyFor(input.action), targetSuccessCount: input.targetSuccessCount,
      maxAttempts: input.maxAttempts, deadlineAt: input.deadlineAt, notBefore: input.notBefore ?? now,
      executionWindow: input.executionWindow ?? { mode: 'immediate' },
      sourceConstraints: input.sourceConstraints ?? {}, targetConstraints: input.targetConstraints ?? {},
      approvalMode: input.approvalMode ?? (input.action === 'generate_candidates' ? 'draft_only' : 'review'),
      priority: input.priority ?? 'normal', source: input.source, sourceRef: input.sourceRef ?? null,
      originChatId: input.originChatId ?? null,
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

  async list(filter: DelegatedTaskListFilter = {}): Promise<DelegatedTask[]> {
    return [...this.tasks.values()]
      .filter((t) => !filter.accountId || t.accountId === filter.accountId)
      .filter((t) => !filter.actionFamily || t.actionFamily === filter.actionFamily)
      .filter((t) => !filter.statuses?.length || filter.statuses.includes(t.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, filter.limit ?? 50)
      .map((t) => structuredClone(t));
  }

  async recoverInterruptedClaims(now = Date.now()): Promise<InterruptedClaimRecovery[]> {
    const recovered: InterruptedClaimRecovery[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'planning' && task.status !== 'executing') continue;
      const fromStatus = task.status;
      const previousClaimExpiresAt = task.claimExpiresAt;
      const nextStatus: DelegatedTaskStatus = task.cancelRequested
        ? honestTerminalStatus(task.progress, 'cancelled')
        : task.pauseRequested
          ? 'deferred'
          : 'queued';
      Object.assign(task, {
        status: nextStatus,
        terminalOutcome: task.cancelRequested ? {
          code: 'remaining_cancelled_by_user',
          message: 'Cloud 重启时任务已请求取消；已取消剩余部分。',
          remainingCount: Math.max(0, task.targetSuccessCount - task.progress.successCount),
        } : task.terminalOutcome,
        claimToken: null,
        claimExpiresAt: null,
        nextEligibleAt: task.pauseRequested || task.cancelRequested ? null : now,
        currentStep: task.cancelRequested ? null : task.pauseRequested ? 'paused_by_user' : 'reconcile_interrupted_attempt',
        completedAt: task.cancelRequested ? now : task.completedAt,
        version: task.version + 1,
        updatedAt: now,
      });
      this.interruptedClaimEvents.push({ taskId: task.id, fromStatus, toStatus: nextStatus, previousClaimExpiresAt, recoveredAt: now });
      recovered.push({ task: structuredClone(task), fromStatus, previousClaimExpiresAt });
    }
    return recovered;
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

  async discardAttemptBeforeStart(id: string, _reason: string): Promise<DelegatedTask> {
    const attempt = this.attempts.get(id);
    if (!attempt || (attempt.status !== 'prepared' && attempt.status !== 'dispatched')) {
      throw new Error('attempt_already_finished_or_missing');
    }
    const task = this.tasks.get(attempt.taskId);
    if (!task) throw new Error('attempt_task_missing');
    this.attempts.delete(id);
    if (attempt.status === 'dispatched') task.progress.attemptCount = Math.max(0, task.progress.attemptCount - 1);
    this.mutate(task, {});
    return structuredClone(task);
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

  async listAttempts(taskId: string): Promise<DelegatedTaskAttempt[]> {
    return [...this.attempts.values()]
      .filter((a) => a.taskId === taskId)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((a) => structuredClone(a));
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

  async hasTaskOwnershipConflict(task: DelegatedTask): Promise<boolean> {
    return [...this.tasks.values()].some((active) => delegatedTasksConflict(task, active));
  }

  private mutate(task: DelegatedTask, patch: Partial<DelegatedTask>): void {
    Object.assign(task, patch, { version: task.version + 1, updatedAt: Date.now() });
  }
}
