/**
 * 记账 outbox（change risk-state-cross-process-integrity，design D5）。
 *
 * 改动前，「边缘确认的真实动作 → 风控记账」是进程内事件总线上的一句 fire-and-forget，异常只
 * `console.warn`。进程崩在「回执已到、计数未提交」之间，这次**真实发生过**的平台动作就此从账本上
 * 消失；后续 canDo 据此误以为尚有余量而放行更多真实动作。这张表把那段真空填成持久中间态。
 *
 * 形状照抄委托任务 worker 的认领范式（`delegated-task/store.ts`）：
 * 认领令牌 + 租约 + `FOR UPDATE SKIP LOCKED` + `execution_target` 过滤 + 启动回收。
 *
 * **exactly-once 交给数据库**：`risk_counters.outbox_id` 上的部分唯一索引 + 单事务内
 * 「写计数 + 标 applied」，MUST NOT 用进程内 Set 去重（进程重启即失忆，而这条链路的存在理由
 * 恰恰就是「重启也不丢账」）。
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/index.js';
import type { DeploymentTarget } from '../deployment-target.js';
import type { RiskAction } from './types.js';

const { Pool } = pg;

export interface RiskCounterOutboxEnqueueInput {
  accountId: string;
  action: RiskAction;
  occurredAt: number;
  /** 去重键：边缘回执路径用 `${envelopeId}:${action}`，重发同一信封天然去重。 */
  dedupeKey: string;
}

export interface RiskCounterOutboxClaim {
  id: number;
  accountId: string;
  action: RiskAction;
  occurredAt: number;
  dedupeKey: string;
  attempts: number;
  claimToken: string;
}

export interface RiskCounterOutboxBacklog {
  pending: number;
  dead: number;
  /** 已被认领但租约已过期的在途行数（>0 表示有 worker 崩了或卡住）。 */
  staleClaims: number;
}

/** 记账 outbox 的最小接口（便于内存打桩、不依赖真 PG）。 */
export interface RiskCounterOutbox {
  init(): Promise<void>;
  /** 入队既成事实。同 dedupeKey 重复入队只产生一行（inserted=false 表示这次是重复投递）。 */
  enqueue(input: RiskCounterOutboxEnqueueInput): Promise<{ id: number; inserted: boolean }>;
  claimBatch(opts: { workerId: string; leaseMs: number; limit: number; now?: number }): Promise<RiskCounterOutboxClaim[]>;
  /** 逐行在单事务内应用；返回真正落账的行（调用方据此、且只据此递增内存计数）。 */
  applyClaimed(rows: RiskCounterOutboxClaim[]): Promise<RiskCounterOutboxClaim[]>;
  /** 应用失败：attempts+1、释放认领；超限转 dead。返回该行是否已进死信。 */
  failClaimed(row: RiskCounterOutboxClaim, error: string, maxAttempts: number): Promise<{ dead: boolean }>;
  /** 启动回收：把本 target 下租约已过期的在途行放回可认领态，返回回收条数。 */
  recoverExpiredClaims(now?: number): Promise<number>;
  backlogCounts(now?: number): Promise<RiskCounterOutboxBacklog>;
  close?(): Promise<void>;
}

export interface PgRiskCounterOutboxStoreOptions {
  executionTarget: DeploymentTarget;
  pool?: pg.Pool;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export class PgRiskCounterOutboxStore implements RiskCounterOutbox {
  private readonly pool: pg.Pool;
  private readonly executionTarget: DeploymentTarget;

  constructor(options: PgRiskCounterOutboxStoreOptions) {
    this.executionTarget = options.executionTarget;
    this.pool =
      options.pool ??
      new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
  }

  /** schema 由 PgRiskStore.init() 的 RISK_SCHEMA_SQL 统一建立（与 migrations/0061 同源）。 */
  async init(): Promise<void> {
    // 只做一次存在性自证：表缺失时诚实抛错，绝不静默降级为「记不上账照跑」。
    await this.pool.query('SELECT 1 FROM risk_counter_outbox LIMIT 1');
  }

  async enqueue(input: RiskCounterOutboxEnqueueInput): Promise<{ id: number; inserted: boolean }> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO risk_counter_outbox (account_id, action, occurred_at, execution_target, dedupe_key)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5)
       ON CONFLICT (execution_target, dedupe_key) DO NOTHING
       RETURNING id`,
      [input.accountId, input.action, input.occurredAt, this.executionTarget, input.dedupeKey],
    );
    if (rows.length > 0) return { id: Number(rows[0].id), inserted: true };
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM risk_counter_outbox WHERE execution_target = $1 AND dedupe_key = $2`,
      [this.executionTarget, input.dedupeKey],
    );
    return { id: Number(existing.rows[0]?.id ?? 0), inserted: false };
  }

  async claimBatch(opts: {
    workerId: string;
    leaseMs: number;
    limit: number;
    now?: number;
  }): Promise<RiskCounterOutboxClaim[]> {
    const now = new Date(opts.now ?? Date.now());
    const token = `${opts.workerId}:${randomUUID()}`;
    const expires = new Date(now.getTime() + Math.max(1_000, opts.leaseMs));
    const { rows } = await this.pool.query<{
      id: string;
      account_id: string;
      action: RiskAction;
      occurred_at: Date;
      dedupe_key: string;
      attempts: number;
    }>(
      `WITH candidate AS (
         SELECT id FROM risk_counter_outbox
          WHERE execution_target = $4 AND status = 'pending'
            AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
          ORDER BY id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $5
       )
       UPDATE risk_counter_outbox o
          SET claim_token = $2, claim_expires_at = $3, updated_at = $1
         FROM candidate WHERE o.id = candidate.id
       RETURNING o.id, o.account_id, o.action, o.occurred_at, o.dedupe_key, o.attempts`,
      [now, token, expires, this.executionTarget, Math.max(1, opts.limit)],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      accountId: r.account_id,
      action: r.action,
      occurredAt: r.occurred_at.getTime(),
      dedupeKey: r.dedupe_key,
      attempts: r.attempts,
      claimToken: token,
    }));
  }

  /**
   * 单事务内完成两件事：写 risk_counters（带 outbox_id）+ 标 outbox 行 applied。
   *
   * `ON CONFLICT (outbox_id) DO NOTHING` 让重复 apply 不产生第二行计数；
   * `UPDATE ... AND claim_token = $` 让**租约已被别人回收**的行不会被我们误标已应用
   * （那一行会被真正的持有者再 apply 一次，而唯一索引保证计数仍只有一行）。
   */
  async applyClaimed(rows: RiskCounterOutboxClaim[]): Promise<RiskCounterOutboxClaim[]> {
    const applied: RiskCounterOutboxClaim[] = [];
    for (const row of rows) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO risk_counters (account_id, action, count, occurred_at, outbox_id)
           VALUES ($1, $2, 1, to_timestamp($3 / 1000.0), $4)
           ON CONFLICT (outbox_id) DO NOTHING`,
          [row.accountId, row.action, row.occurredAt, row.id],
        );
        const marked = await client.query(
          `UPDATE risk_counter_outbox
              SET status = 'applied', claim_token = NULL, claim_expires_at = NULL,
                  last_error = NULL, updated_at = now()
            WHERE id = $1 AND claim_token = $2 AND status = 'pending' AND execution_target = $3`,
          [row.id, row.claimToken, this.executionTarget],
        );
        if ((marked.rowCount ?? 0) === 0) {
          // 认领已失效（租约过期被回收 / 别人已应用）：整笔回滚，绝不把它算进本进程内存计数。
          await client.query('ROLLBACK');
          continue;
        }
        await client.query('COMMIT');
        applied.push(row);
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // 回滚失败说明连接已废，交由 pool 处理。
        }
        throw err;
      } finally {
        client.release();
      }
    }
    return applied;
  }

  /**
   * 记一次失败尝试；attempts 超限即转死信。
   *
   * ⚠️ **`status = 'pending'` 这道守卫不可省**（与 applyClaimed 的守卫同源）：apply 是「先 COMMIT
   * 落账、再解析 controller」两步，第二步失败时会走到这里，而那一行**已经 applied**。没有守卫的话
   * 它会被从 'applied' 改回 'pending'（重复认领）或直接标 'dead'，并发出一条「该动作真实发生过但
   * 没进账本」的 P1——那条告警是假的，它就在账本里；死信数还会因此非零，污染上线判据。
   */
  async failClaimed(row: RiskCounterOutboxClaim, error: string, maxAttempts: number): Promise<{ dead: boolean }> {
    const nextAttempts = row.attempts + 1;
    const dead = nextAttempts >= Math.max(1, maxAttempts);
    const { rowCount } = await this.pool.query(
      `UPDATE risk_counter_outbox
          SET attempts = $2, last_error = $3, status = $4,
              claim_token = NULL, claim_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND execution_target = $5 AND status = 'pending'`,
      [row.id, nextAttempts, error.slice(0, 500), dead ? 'dead' : 'pending', this.executionTarget],
    );
    // 没改到行 ⇒ 这一行不再是 pending（多半已 applied）⇒ 它没有进死信，MUST NOT 报 dead。
    return { dead: dead && (rowCount ?? 0) > 0 };
  }

  async recoverExpiredClaims(now = Date.now()): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE risk_counter_outbox
          SET claim_token = NULL, claim_expires_at = NULL, updated_at = $1
        WHERE execution_target = $2 AND status = 'pending'
          AND claim_token IS NOT NULL AND claim_expires_at <= $1`,
      [new Date(now), this.executionTarget],
    );
    return rowCount ?? 0;
  }

  async backlogCounts(now = Date.now()): Promise<RiskCounterOutboxBacklog> {
    const { rows } = await this.pool.query<{ pending: string; dead: string; stale: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
         COUNT(*) FILTER (WHERE status = 'dead')::text AS dead,
         COUNT(*) FILTER (WHERE status = 'pending' AND claim_expires_at IS NOT NULL AND claim_expires_at <= $2)::text AS stale
        FROM risk_counter_outbox WHERE execution_target = $1`,
      [this.executionTarget, new Date(now)],
    );
    return {
      pending: Number(rows[0]?.pending ?? '0'),
      dead: Number(rows[0]?.dead ?? '0'),
      staleClaims: Number(rows[0]?.stale ?? '0'),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
