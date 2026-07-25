import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import type { DeploymentTarget } from '../deployment-target.js';

const { Pool } = pg;

// 作业形状单写在 kernel（change cloud-coupling-phase4-runtime-ports）：api 的客户端鉴权服务按端口引，
// 不再 import 本实现文件。此处等值再导出，content 同层消费方逐字无感。
export type {
  DraftRefinementScope,
  DraftRefinementStatus,
  DraftRefinementStage,
  DraftRefinementSelection,
  DraftRefinementProgress,
  DraftRefinementJob,
} from '../kernel/publish-draft-contract.js';
import type {
  DraftRefinementJob,
  DraftRefinementProgress,
  DraftRefinementScope,
  DraftRefinementSelection,
  DraftRefinementStatus,
} from '../kernel/publish-draft-contract.js';

export const DRAFT_REFINEMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS publish_draft_refinement_jobs (
  id                 UUID PRIMARY KEY,
  execution_target   TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  account_id         TEXT NOT NULL,
  -- 跨 owner 外键已降级（Block③ 物理拆库前置）：publish_log 属 api，本表属 content，拆库后两者不同物理库，
  -- PostgreSQL 外键不能跨库 —— 带着它建表会在空的 content 库里当场失败（publish_log 不存在）。本表由
  -- init() 无条件 CREATE TABLE 自建（本文件 :160），故这条是 owner-URL 一翻转就必炸的硬阻断。
  -- 原约束的两个作用各有去处，**不是静默拿掉**：
  --   ① 插入期引用完整性：等价守卫在唯一创建入口的上游 —— create() 只被
  --      src/client-auth/client-auth-server.ts:981 调用，而它先在 :938 经
  --      pendingPublishPreviewForAccountRecord 读一次 publish_log（同账号 + pending_approval），
  --      读不到当场 404 返回、走不到 create()。故「record_id 指向不存在的 publish_log」构造不出来。
  --   ② ON DELETE CASCADE：publish_log 全仓零 DELETE（grep 零命中）→ 今天从不触发。
  --      若日后引入删稿，须在 api 池补一条存在性预检 + 本表孤儿清理，MUST NOT 指望本约束。
  record_id          INT NOT NULL,
  expected_version   INT NOT NULL CHECK (expected_version >= 0),
  scope              TEXT NOT NULL CHECK (scope IN ('whole','body','images','selected_image','selected_text')),
  instruction        TEXT NOT NULL,
  selection          JSONB,
  status             TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  progress           JSONB NOT NULL DEFAULT '[]'::jsonb,
  claim_token        UUID,
  claim_expires_at   TIMESTAMPTZ,
  result_version     INT,
  error_code         TEXT,
  error_message      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_publish_draft_refinement_target_claim
  ON publish_draft_refinement_jobs(execution_target, status, created_at);
CREATE INDEX IF NOT EXISTS idx_publish_draft_refinement_account_record
  ON publish_draft_refinement_jobs(execution_target, account_id, record_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_draft_refinement_one_active
  ON publish_draft_refinement_jobs(execution_target, record_id)
  WHERE status IN ('queued','running');
`;

interface RefinementRow {
  id: string;
  execution_target: string;
  account_id: string;
  record_id: number | string;
  expected_version: number | string;
  scope: string;
  instruction: string;
  selection: unknown;
  status: string;
  progress: unknown;
  claim_token: string | null;
  result_version: number | string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
  } catch {
    return fallback;
  }
}

function toJob(row: RefinementRow): DraftRefinementJob {
  return {
    id: row.id,
    executionTarget: row.execution_target as DeploymentTarget,
    accountId: row.account_id,
    recordId: Number(row.record_id),
    expectedVersion: Number(row.expected_version),
    scope: row.scope as DraftRefinementScope,
    instruction: row.instruction,
    selection: parseJson<DraftRefinementSelection>(row.selection, null),
    status: row.status as DraftRefinementStatus,
    progress: parseJson<DraftRefinementProgress[]>(row.progress, []),
    claimToken: row.claim_token,
    resultVersion: row.result_version == null ? null : Number(row.result_version),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    completedAt: row.completed_at?.getTime() ?? null,
  };
}

export interface DraftRefinementStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
  executionTarget: DeploymentTarget;
}

export class DraftRefinementStore {
  private readonly pool: pg.Pool;

  constructor(private readonly options: DraftRefinementStoreOptions) {
    this.pool = options.pool ?? new Pool({
      host: options.host ?? DEFAULT_PG_CONFIG.host,
      port: options.port ?? DEFAULT_PG_CONFIG.port,
      database: options.database ?? DEFAULT_PG_CONFIG.database,
      user: options.user ?? DEFAULT_PG_CONFIG.user,
      password: options.password ?? DEFAULT_PG_CONFIG.password,
    });
  }

  async init(): Promise<void> {
    await this.pool.query(DRAFT_REFINEMENT_SCHEMA_SQL);
  }

  async create(input: {
    accountId: string;
    recordId: number;
    expectedVersion: number;
    scope: DraftRefinementScope;
    instruction: string;
    selection: DraftRefinementSelection;
  }): Promise<DraftRefinementJob> {
    const id = randomUUID();
    const { rows } = await this.pool.query<RefinementRow>(
      `INSERT INTO publish_draft_refinement_jobs
         (id, execution_target, account_id, record_id, expected_version, scope, instruction, selection)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       RETURNING *`,
      [
        id,
        this.options.executionTarget,
        input.accountId,
        input.recordId,
        input.expectedVersion,
        input.scope,
        input.instruction,
        input.selection == null ? null : JSON.stringify(input.selection),
      ],
    );
    return toJob(rows[0]);
  }

  async getForAccount(accountId: string, recordId: number, jobId: string): Promise<DraftRefinementJob | null> {
    const { rows } = await this.pool.query<RefinementRow>(
      `SELECT * FROM publish_draft_refinement_jobs
       WHERE id=$1 AND execution_target=$2 AND account_id=$3 AND record_id=$4`,
      [jobId, this.options.executionTarget, accountId, recordId],
    );
    return rows[0] ? toJob(rows[0]) : null;
  }

  async latestForAccountRecord(accountId: string, recordId: number): Promise<DraftRefinementJob | null> {
    const { rows } = await this.pool.query<RefinementRow>(
      `SELECT * FROM publish_draft_refinement_jobs
       WHERE execution_target=$1 AND account_id=$2 AND record_id=$3
       ORDER BY created_at DESC LIMIT 1`,
      [this.options.executionTarget, accountId, recordId],
    );
    return rows[0] ? toJob(rows[0]) : null;
  }

  async latestForAccountRecords(accountId: string, recordIds: number[]): Promise<Map<number, DraftRefinementJob>> {
    const ids = [...new Set(recordIds.filter((id) => Number.isInteger(id) && id > 0))];
    if (ids.length === 0) return new Map();
    const { rows } = await this.pool.query<RefinementRow>(
      `SELECT DISTINCT ON (record_id) * FROM publish_draft_refinement_jobs
       WHERE execution_target=$1 AND account_id=$2 AND record_id = ANY($3::int[])
       ORDER BY record_id, created_at DESC`,
      [this.options.executionTarget, accountId, ids],
    );
    return new Map(rows.map((row) => {
      const job = toJob(row);
      return [job.recordId, job] as const;
    }));
  }

  async claimNext(_workerId: string, leaseMs: number, now = Date.now()): Promise<DraftRefinementJob | null> {
    const token = randomUUID();
    const expiresAt = new Date(now + leaseMs);
    const { rows } = await this.pool.query<RefinementRow>(
      `WITH candidate AS (
         SELECT id FROM publish_draft_refinement_jobs
          WHERE execution_target=$1 AND status='queued'
          -- Block③ 拆库（owner-URL 翻转）：publish_log 属 api，跨 owner 池不能与本 content 表同语句关联。
          -- 原「EXISTS publish_log」是拆库后防悬空 record_id 的读侧守卫，但 publish_log **全仓从不 DELETE**
          -- （grep 零命中）、且洗稿任务的 record_id 建时即为合法 publish_log.id（FK），故悬空场景不存在、该断言恒真
          -- ——移除它逐字节等价（never excluded any row）。若日后引入删稿功能，须在 api 池另做存在性预检。
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE publish_draft_refinement_jobs j
          SET status='running', claim_token=$2, claim_expires_at=$3,
              updated_at=now(), error_code=NULL, error_message=NULL
         FROM candidate
        WHERE j.id=candidate.id AND j.execution_target=$1
       RETURNING j.*`,
      [this.options.executionTarget, token, expiresAt],
    );
    return rows[0] ? toJob(rows[0]) : null;
  }

  async replaceProgress(jobId: string, claimToken: string, progress: DraftRefinementProgress[]): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE publish_draft_refinement_jobs
          SET progress=$3::jsonb, updated_at=now()
        WHERE id=$1 AND execution_target=$4 AND status='running' AND claim_token=$2`,
      [jobId, claimToken, JSON.stringify(progress), this.options.executionTarget],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async complete(jobId: string, claimToken: string, resultVersion: number, progress: DraftRefinementProgress[]): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE publish_draft_refinement_jobs
          SET status='completed', result_version=$3, progress=$4::jsonb,
              claim_token=NULL, claim_expires_at=NULL, completed_at=now(), updated_at=now()
        WHERE id=$1 AND execution_target=$5 AND status='running' AND claim_token=$2`,
      [jobId, claimToken, resultVersion, JSON.stringify(progress), this.options.executionTarget],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async fail(jobId: string, claimToken: string, code: string, message: string, progress: DraftRefinementProgress[]): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE publish_draft_refinement_jobs
          SET status='failed', error_code=$3, error_message=$4, progress=$5::jsonb,
              claim_token=NULL, claim_expires_at=NULL, completed_at=now(), updated_at=now()
        WHERE id=$1 AND execution_target=$6 AND status='running' AND claim_token=$2`,
      [jobId, claimToken, code, message, JSON.stringify(progress), this.options.executionTarget],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** One-shot startup recovery. A new process has no surviving local generation calls. */
  async recoverInterruptedClaims(now = Date.now()): Promise<number> {
    const result = await this.pool.query(
      `UPDATE publish_draft_refinement_jobs
          SET status='failed', error_code='worker_interrupted',
              error_message='系统重启中断了本次调整，原稿未变化，请重新发起。',
              claim_token=NULL, claim_expires_at=NULL, completed_at=$1::timestamptz, updated_at=$1::timestamptz
        WHERE execution_target=$2 AND status='running'`,
      [new Date(now), this.options.executionTarget],
    );
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
