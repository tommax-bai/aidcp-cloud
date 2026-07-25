/**
 * 离场清理授权（cleanup grant）跨域操作端口的 **automation 属主实现**（Block③ 物理拆库 L3）。
 *
 * 属主：automation。本类**持有 automation 池、自己开事务**，是 kernel 端口
 * `OffboardCleanupGrantOperations` 在单进程期的满足者。api 侧（`client-auth/client-user-store.ts`）
 * 只经该 kernel 接口转调，**不再由 api 的连接跑 automation 的 SQL**。
 *
 * 与同目录 `offboard-write-adapter.ts` 的分工：
 *   - 那个适配器的方法**接调用方的事务句柄** —— 因为那些离场写确实与 api 侧的归属收权共提交
 *     （真跨域事务，须最终一致重设计，仍属「须监督」批）；
 *   - **本类不接句柄**：这两个操作碰的表全是 automation 属主（`interaction_offboards` /
 *     `interaction_offboard_audit`），一张 api 表都没有，故可以整体收回属主域、自成一笔事务。
 *
 * 三条 SQL 从 `offboard-write-adapter.ts` 的 `markCleanupGrantIssued` / `markCleanupGrantConsumed` /
 * `insertOffboardAudit` **逐字迁来**（那三个方法在全仓只被本次搬走的两个方法调用过，故随本刀内化、
 * 从当时那个接调用方句柄的写端口移除）。判定顺序、提交/回滚时机、审计写入条件亦逐字保留 ——
 * 逐条依据见 kernel 端口文件头「MUST 逐字保留的不变量」。
 */

import crypto from 'node:crypto';
import pg from 'pg';
import type {
  ConsumeOffboardCleanupGrantFailure,
  ConsumeOffboardCleanupGrantInput,
  ConsumeOffboardCleanupGrantOutcome,
  IssueOffboardCleanupGrantInput,
  OffboardCleanupGrantOperations,
  OffboardGrantReason,
  OffboardGrantState,
} from '../kernel/offboard-cleanup-grant-types.js';

const PLATFORM = 'wechat_channels';

interface GrantRow {
  offboard_id: string;
  env_key: string;
  account_id: string;
  state: OffboardGrantState;
  reason: OffboardGrantReason;
  requested_at: Date;
  purge_due_at: Date;
  user_id: string | null;
  cleanup_grant_jti_hash: string | null;
  cleanup_grant_edge_id: string | null;
  cleanup_grant_expires_at: Date | null;
  cleanup_grant_used_at: Date | null;
}

export interface PgOffboardCleanupGrantOpsOptions {
  /** automation 属主池（组合根注入）。 */
  pool: pg.Pool;
}

export class PgOffboardCleanupGrantOps implements OffboardCleanupGrantOperations {
  private readonly pool: pg.Pool;

  constructor(options: PgOffboardCleanupGrantOpsOptions) {
    this.pool = options.pool;
  }

  /** 审计行（原 adapter.insertOffboardAudit 的 SQL，逐字迁移）。 */
  private async insertAudit(
    client: pg.PoolClient,
    input: { offboardId: string; accountId: string; envKey: string; userId: string | null; event: string; status: string },
  ): Promise<void> {
    await client.query(
      `INSERT INTO interaction_offboard_audit
         (event_id,offboard_id,platform,account_id,env_key,user_id,event,status)
       VALUES ($1,$2,'${PLATFORM}',$3,$4,$5,$6,$7)`,
      [crypto.randomUUID(), input.offboardId, input.accountId, input.envKey, input.userId, input.event, input.status],
    );
  }

  /**
   * 条件签发（原 adapter.markCleanupGrantIssued + 调用方的审计写，合成一笔自有事务）。
   * 未命中（不归属 / 状态不符 / 行不存在）→ ROLLBACK + false，**不写审计**，与改动前逐字同。
   */
  async issueCleanupGrant(input: IssueOffboardCleanupGrantInput): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query<{ account_id: string; env_key: string }>(
        `UPDATE interaction_offboards
            SET cleanup_grant_jti_hash=$4,cleanup_grant_edge_id=$3,
                cleanup_grant_expires_at=to_timestamp($5 / 1000.0),cleanup_grant_used_at=NULL,updated_at=now()
          WHERE offboard_id=$1 AND user_id=$2 AND state IN ('pending_edge','dispatched')
          RETURNING account_id,env_key`,
        [input.offboardId, input.userId, input.edgeId, input.jtiHash, input.expiresAt],
      );
      const row = updated.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return false;
      }
      await this.insertAudit(client, {
        offboardId: input.offboardId, accountId: row.account_id, envKey: row.env_key,
        userId: input.userId, event: 'cleanup_grant_issued', status: 'issued',
      });
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 原子核验并烧票。**取行的 FOR UPDATE 与烧票、写审计在同一笔事务同一连接** —— 烧票那条 UPDATE
   * 不查影响行数，其正确性完全依赖同事务内已持有的行锁（拆开即静默假成功，见 kernel 端口不变量 3）。
   * 五档失败判定的顺序即优先级；**失败也 COMMIT**（拒绝审计要留痕），仅行不存在时不写审计。
   */
  async consumeCleanupGrant(input: ConsumeOffboardCleanupGrantInput): Promise<ConsumeOffboardCleanupGrantOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<GrantRow>(
        `SELECT offboard_id,env_key,account_id,state,reason,requested_at,purge_due_at,user_id,
                cleanup_grant_jti_hash,cleanup_grant_edge_id,cleanup_grant_expires_at,cleanup_grant_used_at
           FROM interaction_offboards WHERE offboard_id=$1 FOR UPDATE`,
        [input.offboardId],
      );
      const row = selected.rows[0];
      let failure: ConsumeOffboardCleanupGrantFailure | null = null;
      if (!row) failure = 'not_found';
      else if (row.user_id !== input.userId || row.env_key !== input.envKey || row.account_id !== input.accountId
        || row.cleanup_grant_edge_id !== input.edgeId || row.cleanup_grant_jti_hash !== input.jtiHash) failure = 'scope_mismatch';
      else if (row.cleanup_grant_used_at) failure = 'already_used';
      else if (!row.cleanup_grant_expires_at || row.cleanup_grant_expires_at.getTime() <= input.now) failure = 'expired';
      else if (row.state !== 'pending_edge' && row.state !== 'dispatched') failure = 'not_pending';

      if (failure) {
        if (row) {
          await this.insertAudit(client, {
            offboardId: row.offboard_id, accountId: row.account_id, envKey: row.env_key,
            userId: input.userId, event: 'cleanup_grant_rejected', status: failure,
          });
        }
        await client.query('COMMIT');
        return { ok: false, reason: failure };
      }

      await client.query(
        `UPDATE interaction_offboards SET cleanup_grant_used_at=now(),updated_at=now() WHERE offboard_id=$1`,
        [row!.offboard_id],
      );
      await this.insertAudit(client, {
        offboardId: row!.offboard_id, accountId: row!.account_id, envKey: row!.env_key,
        userId: input.userId, event: 'cleanup_grant_consumed', status: 'consumed',
      });
      await client.query('COMMIT');
      return {
        ok: true,
        offboard: {
          offboardId: row!.offboard_id,
          envKey: row!.env_key,
          accountId: row!.account_id,
          state: row!.state,
          reason: row!.reason,
          requestedAt: row!.requested_at.getTime(),
          purgeDueAt: row!.purge_due_at.getTime(),
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
