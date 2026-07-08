/**
 * 「引流待评候选队列」存储（change feed-hot-lead-group-comment，段一）。
 *
 * 浏览闭环发现的高热度速率帖沉淀于此——**只发现、不发布**。人审逐条消费（段二）从 pending 取用。
 * 按账号隔离。入队去重：队列内同 noteId 的 pending 不重复（本存储负责）；「本账号已评过」由角色在
 * 入队前用既有 risk_interactions 去重（存储不重复承担，避免双写风控数据）。
 *
 * 表随启动幂等自建、无迁移器（仿 group_comment_attempts）。红线：诚实——插入真实回读，不 seed 幽灵行。
 */
import pg from 'pg';

const { Pool } = pg;

export type HotLeadStatus = 'pending' | 'actioned' | 'dismissed';

/** 发现时的快照（速率是发现时刻的即时值，消费时可提示时效）。 */
export interface HotLeadSnapshot {
  title?: string;
  likeCount: number;
  velocity: number;
  ageHours: number;
}

export interface HotLeadInput {
  accountId: string;
  noteId: string;
  snapshot: HotLeadSnapshot;
}

export interface HotLeadRecord extends HotLeadInput {
  id: number;
  status: HotLeadStatus;
  discoveredAt: number;
}

export type EnqueueResult =
  | { ok: true; id: number }
  | { ok: false; reason: 'duplicate_pending' };

export interface HotLeadQueue {
  /** 入队一条候选；队列内同账号同 noteId 已有 pending → duplicate_pending，不重复。 */
  enqueue(input: HotLeadInput): Promise<EnqueueResult>;
  /** 列某账号的 pending 候选（新→旧）。 */
  listPending(accountId: string): Promise<HotLeadRecord[]>;
  /** 置为已处理（发出后）。 */
  markActioned(id: number): Promise<void>;
  /** 置为已弃用（人审拒/时效过期等）。 */
  markDismissed(id: number): Promise<void>;
}

export const HOT_LEAD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hot_lead_queue (
  id            BIGSERIAL PRIMARY KEY,
  account_id    TEXT NOT NULL,
  note_id       TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  velocity      DOUBLE PRECISION NOT NULL,
  age_hours     DOUBLE PRECISION NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hot_lead_queue_pending ON hot_lead_queue (account_id, status, discovered_at);
-- 队列内 pending 去重：同账号同 noteId 至多一条 pending（dismissed/actioned 后可再入队）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_hot_lead_queue_pending ON hot_lead_queue (account_id, note_id) WHERE status = 'pending';
`;

export interface HotLeadQueueOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

interface DbRow {
  id: number | string;
  account_id: string;
  note_id: string;
  snapshot_json: HotLeadSnapshot;
  velocity: number | string;
  age_hours: number | string;
  status: HotLeadStatus;
  discovered_at: Date | string;
}

function toRecord(r: DbRow): HotLeadRecord {
  return {
    id: Number(r.id),
    accountId: r.account_id,
    noteId: r.note_id,
    snapshot: r.snapshot_json,
    status: r.status,
    discoveredAt: new Date(r.discovered_at).getTime(),
  };
}

export class PgHotLeadQueue implements HotLeadQueue {
  private readonly pool: pg.Pool;

  constructor(options: HotLeadQueueOptions = {}) {
    this.pool =
      options.pool ??
      new Pool({
        host: options.host,
        port: options.port,
        database: options.database,
        user: options.user,
        password: options.password,
      });
  }

  async init(): Promise<void> {
    await this.pool.query(HOT_LEAD_SCHEMA_SQL);
  }

  async enqueue(input: HotLeadInput): Promise<EnqueueResult> {
    const { accountId, noteId, snapshot } = input;
    // 依赖 uq_hot_lead_queue_pending 部分唯一索引：同账号同 noteId 已有 pending → 冲突跳过。
    const res = await this.pool.query<{ id: number | string }>(
      `INSERT INTO hot_lead_queue (account_id, note_id, snapshot_json, velocity, age_hours)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, note_id) WHERE status = 'pending' DO NOTHING
       RETURNING id`,
      [accountId, noteId, JSON.stringify(snapshot), snapshot.velocity, snapshot.ageHours],
    );
    if (res.rows.length === 0) return { ok: false, reason: 'duplicate_pending' };
    return { ok: true, id: Number(res.rows[0].id) };
  }

  async listPending(accountId: string): Promise<HotLeadRecord[]> {
    const res = await this.pool.query<DbRow>(
      `SELECT * FROM hot_lead_queue WHERE account_id = $1 AND status = 'pending'
       ORDER BY discovered_at DESC`,
      [accountId],
    );
    return res.rows.map(toRecord);
  }

  async markActioned(id: number): Promise<void> {
    await this.pool.query(`UPDATE hot_lead_queue SET status = 'actioned' WHERE id = $1`, [id]);
  }

  async markDismissed(id: number): Promise<void> {
    await this.pool.query(`UPDATE hot_lead_queue SET status = 'dismissed' WHERE id = $1`, [id]);
  }
}

/** 内存实现：单测与无 PG 环境用；语义与 PG 实现一致（含 pending 去重）。 */
export class MemoryHotLeadQueue implements HotLeadQueue {
  private rows: HotLeadRecord[] = [];
  private seq = 0;
  private clock: number;

  constructor(startClock = 1) {
    this.clock = startClock;
  }

  async enqueue(input: HotLeadInput): Promise<EnqueueResult> {
    const dup = this.rows.some(
      (r) => r.accountId === input.accountId && r.noteId === input.noteId && r.status === 'pending',
    );
    if (dup) return { ok: false, reason: 'duplicate_pending' };
    const id = ++this.seq;
    this.rows.push({ ...input, id, status: 'pending', discoveredAt: this.clock++ });
    return { ok: true, id };
  }

  async listPending(accountId: string): Promise<HotLeadRecord[]> {
    return this.rows
      .filter((r) => r.accountId === accountId && r.status === 'pending')
      .sort((a, b) => b.discoveredAt - a.discoveredAt)
      .map((r) => ({ ...r }));
  }

  async markActioned(id: number): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.status = 'actioned';
  }

  async markDismissed(id: number): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.status = 'dismissed';
  }
}
