/**
 * 离场台账的 **automation 属主写入者**（change offboard-saga → Block③ L3 最终一致改造）。
 *
 * 属主：automation。本类是 kernel 端口 `OffboardMaterializationOperations` 在单进程期的满足者：
 * **持组合根注入的 automation 池、自己开事务**，只写 automation 属主的四张离场表
 * （`interaction_offboards` / `interaction_offboard_audit` / `interaction_auth_state` /
 * `interaction_runtime_controls`）。
 *
 * ## 与改造前的关键差别（这就是本刀）
 *
 * 改造前本文件的方法**接调用方的事务句柄**：api 的 `client-user-store` `BEGIN` 出一条 **api 池**
 * 连接再递进来，于是「撤销归属（api 表）」与这里的四张 automation 表写在**同一笔跨属主事务**里。
 * 拆库后那条连接跑不了这些 SQL —— 要么 `42P01` 把客户解绑 / 停用客户 / 改派归属打成 500，
 * 要么（两库各拷一份表时）写进 api 那份副本、automation 侧派发器永远看不到 = **静默假成功**。
 * 而且这里的 `SELECT … FOR UPDATE` 当时是跑在 **api 的连接**上的跨库行锁：两侧连不同库时
 * 两边各自加锁都会成功、互斥消失且不报错（同一教训见 `src/db/environment-row-lock.ts` 文件头）。
 *
 * 改造后：api 只在自己的事务里写**准入事实**（`client_env_revocation_holds`，见 client-user-store
 * 文件头），提交后经本端口把**执行台账**交给属主物化；本类自开事务、自解析绑定，
 * 全程只碰 automation 的库。同目录 `offboard-cleanup-grant-ops.ts` 是同一形态的先例。
 *
 * ## 幂等（投递是 at-least-once）
 *
 * 幂等键是入参 `offboardId` 与属主侧 `(platform, env_key) WHERE state <> 'purged'` 唯一索引：
 * 重投落到同一条台账行、`RETURNING` 交回既有行，既不产生第二条离场，也不报错。
 * 收权与审计随之重放：收权是幂等的 `UPDATE`（同一目标态），审计行按 `event_id` 新增（追加式流水，
 * 重投多一条 `access_revoked` 记录 —— 审计流水允许重复条目，MUST NOT 为了去重去改写既有审计）。
 */
import crypto from 'node:crypto';
import pg from 'pg';
import type {
  MaterializeEnvironmentOffboardInput,
  MaterializeEnvironmentOffboardOutcome,
  OffboardMaterializationOperations,
} from '../kernel/offboard-materialization-types.js';
import type { OffboardProjection } from '../kernel/client-env-automation-types.js';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

interface OffboardRow {
  offboard_id: string;
  env_key: string;
  account_id: string;
  state: OffboardProjection['state'];
  reason: OffboardProjection['reason'];
  requested_at: Date;
  purge_due_at: Date;
}

function toProjection(row: OffboardRow): OffboardProjection {
  return {
    offboardId: row.offboard_id,
    envKey: row.env_key,
    accountId: row.account_id,
    state: row.state,
    reason: row.reason,
    requestedAt: row.requested_at.getTime(),
    purgeDueAt: row.purge_due_at.getTime(),
  };
}

const REVOKED_CAPABILITIES = JSON.stringify({
  commentsRead: false, commentsReply: false, dmRead: false, dmSendText: false, dmSendImage: false,
});

export interface PgOffboardMaterializationOpsOptions {
  /** automation 属主池（组合根注入）。 */
  pool: pg.Pool;
}

export class PgOffboardMaterializationOps implements OffboardMaterializationOperations {
  private readonly pool: pg.Pool;

  constructor(options: PgOffboardMaterializationOpsOptions) {
    this.pool = options.pool;
  }

  /**
   * 收权：停掉互动运行控制 + 把授权态打成 disabled。SQL 与改造前逐字一致，
   * 唯一差别是跑在**属主自己的连接**上（改造前跑在 api 递来的句柄上）。
   *
   * 「UPDATE 影响 0 行时再取一次行确认」这一步保留：它防的是「行在、却被 WHERE 漏掉」这种
   * 静默漏写；行确实不存在才是正常的「该环境没有运行控制身份」。
   */
  private async revokeInteractionAccess(
    client: Queryable,
    input: { accountId: string; actor: string | null; requireAuthState: boolean },
  ): Promise<void> {
    const controls = await client.query(
      `UPDATE interaction_runtime_controls SET comments_read_enabled=false,comments_reply_enabled=false,
          dm_read_enabled=false,dm_send_text_enabled=false,dm_send_image_enabled=false,write_paused=true,
          version=version+1,updated_at=now(),updated_by=$2
        WHERE platform='wechat_channels' AND account_id=$1
        RETURNING account_id`,
      [input.accountId, input.actor ?? 'offboarding'],
    );
    if ((controls.rowCount ?? 0) === 0) {
      const existing = await client.query(
        `SELECT 1 FROM interaction_runtime_controls
          WHERE platform='wechat_channels' AND account_id=$1 FOR UPDATE`,
        [input.accountId],
      );
      if (existing.rows[0]) throw new Error('interaction_runtime_controls_revoke_missed');
    }

    const auth = await client.query(
      `UPDATE interaction_auth_state SET status='disabled',capabilities=$2::jsonb,
          reason_code='INTERACTION_FEATURE_DISABLED',checked_at=now(),updated_at=now()
        WHERE platform='wechat_channels' AND account_id=$1
        RETURNING account_id`,
      [input.accountId, REVOKED_CAPABILITIES],
    );
    if ((auth.rowCount ?? 0) === 0 && input.requireAuthState) {
      throw new Error('interaction_auth_state_revoke_missed');
    }
  }

  /**
   * 无绑定时的可行收权（原 api 侧 `enqueueCleanupHold` 的后半段，连同它那条**跨库**
   * `SELECT … FOR UPDATE` 一起搬进属主域）：该环境**恰好一个**运行控制身份时才收权。
   * 两个及以上无法判定是哪一个 ⇒ 不动（宁可不做，绝不误收别人的权）。
   */
  private async revokeSingleRuntimeIdentity(
    client: pg.PoolClient,
    input: { envKey: string; actor: string | null },
  ): Promise<void> {
    const identities = await client.query<{ account_id: string }>(
      `SELECT account_id FROM interaction_runtime_controls
        WHERE platform='wechat_channels' AND env_key=$1
        ORDER BY account_id LIMIT 2 FOR UPDATE`,
      [input.envKey],
    );
    if (identities.rows.length !== 1) return;
    await this.revokeInteractionAccess(client, {
      accountId: identities.rows[0].account_id,
      actor: input.actor,
      requireAuthState: false,
    });
  }

  /** 审计行（追加式流水）。 */
  private async insertAudit(
    client: Queryable,
    input: { eventId: string; offboardId: string; accountId: string; envKey: string; userId: string;
      event: string; status: string },
  ): Promise<void> {
    await client.query(
      `INSERT INTO interaction_offboard_audit
         (event_id,offboard_id,platform,account_id,env_key,user_id,event,status)
       VALUES ($1,$2,'wechat_channels',$3,$4,$5,$6,$7)`,
      [input.eventId, input.offboardId, input.accountId, input.envKey, input.userId, input.event, input.status],
    );
  }

  /**
   * 把一条 api 侧准入物化成离场台账（幂等，自成一笔事务）。
   *
   * 顺序即语义：**先在属主事务里解析绑定**（不变量 2：绝不接调用方传来的 accountId），再按三分支落地。
   * 任一步抛错整笔回滚 —— 台账、收权、审计要么都在要么都不在，投递侧会重放。
   */
  async materializeEnvironmentOffboard(
    input: MaterializeEnvironmentOffboardInput,
  ): Promise<MaterializeEnvironmentOffboardOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const binding = await client.query<{ account_id: string }>(
        `SELECT account_id FROM interaction_auth_state
          WHERE platform='wechat_channels' AND env_key=$1 FOR UPDATE`,
        [input.envKey],
      );
      const boundAccountId = binding.rows[0]?.account_id ?? null;

      if (!boundAccountId && !input.unboundTerminalAllowed) {
        // 尚无互动绑定、又不许写终态：在可行范围内收权，但**不产生台账行**，如实回报。
        await this.revokeSingleRuntimeIdentity(client, { envKey: input.envKey, actor: input.actor });
        await client.query('COMMIT');
        return { materialized: false, reason: 'binding_missing' };
      }

      if (!boundAccountId) {
        // 客户自助建号且从未拿到互动绑定：没有可排空的凭据面，直接落终态 tombstone。
        // accountId 用环境自身的保留命名空间——**不创建账号、不建授权绑定**，tombstoned 行永不派发。
        const row = await this.insertTerminalOffboard(client, input);
        await client.query('COMMIT');
        return { materialized: true, offboard: toProjection(row) };
      }

      const row = await this.insertPendingOffboard(client, input, boundAccountId);
      await this.revokeInteractionAccess(client, {
        accountId: row.account_id, actor: input.actor, requireAuthState: true,
      });
      await this.insertAudit(client, {
        eventId: crypto.randomUUID(), offboardId: row.offboard_id, accountId: row.account_id,
        envKey: input.envKey, userId: input.userId, event: 'access_revoked', status: 'pending_edge',
      });
      await client.query('COMMIT');
      return { materialized: true, offboard: toProjection(row) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 有绑定：写 `pending_edge` 台账行。`ON CONFLICT … DO UPDATE SET updated_at=（原值）` 是**幂等命中**——
   * 重投交回既有行而非新建（SQL 与改造前逐字一致）。
   * 既有行的账号与本次解析出的账号不一致 = 台账与绑定分叉，MUST 抛，MUST NOT 覆盖。
   */
  private async insertPendingOffboard(
    client: pg.PoolClient,
    input: MaterializeEnvironmentOffboardInput,
    accountId: string,
  ): Promise<OffboardRow> {
    const inserted = await client.query<OffboardRow>(
      `INSERT INTO interaction_offboards
         (offboard_id,platform,account_id,env_key,user_id,reason,state,requested_at,purge_due_at,updated_at)
       VALUES ($1,'wechat_channels',$2,$3,$4,$5,'pending_edge',now(),now()+interval '29 days',now())
       ON CONFLICT (platform,env_key) WHERE state <> 'purged' DO UPDATE
         SET updated_at=interaction_offboards.updated_at
       RETURNING offboard_id,env_key,account_id,state,reason,requested_at,purge_due_at`,
      [input.offboardId, accountId, input.envKey, input.userId, input.reason],
    );
    const row = inserted.rows[0];
    if (!row || row.account_id !== accountId) throw new Error('offboard_scope_conflict');
    return row;
  }

  /**
   * 无绑定且允许终态：写 `tombstoned` 台账行 + 两条审计。
   * 同样按 `(platform, env_key)` 幂等命中——重投绝不产生第二条。
   */
  private async insertTerminalOffboard(
    client: pg.PoolClient,
    input: MaterializeEnvironmentOffboardInput,
  ): Promise<OffboardRow> {
    const accountId = input.envKey;
    const inserted = await client.query<OffboardRow>(
      `INSERT INTO interaction_offboards
       (offboard_id,platform,account_id,env_key,user_id,reason,state,requested_at,
          tombstoned_at,purge_due_at,updated_at)
       VALUES ($1,'wechat_channels',$2,$3,$4,$5,'tombstoned',now(),now(),now()+interval '29 days',now())
       ON CONFLICT (platform,env_key) WHERE state <> 'purged' DO UPDATE
         SET updated_at=interaction_offboards.updated_at
       RETURNING offboard_id,env_key,account_id,state,reason,requested_at,purge_due_at`,
      [input.offboardId, accountId, input.envKey, input.userId, input.reason],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('offboard_terminal_insert_failed');
    // 幂等命中了一条**别的账号**的既有离场 = 台账与本次准入分叉，MUST 抛，MUST NOT 当成功。
    if (row.account_id !== accountId) throw new Error('offboard_scope_conflict');
    await client.query(
      `INSERT INTO interaction_offboard_audit
         (event_id,offboard_id,platform,account_id,env_key,user_id,event,status)
       VALUES
         ($1,$3,'wechat_channels',$4,$5,$6,'access_revoked','tombstoned'),
         ($2,$3,'wechat_channels',$4,$5,$6,'unbound_cleanup_not_required','tombstoned')`,
      [crypto.randomUUID(), crypto.randomUUID(), row.offboard_id, row.account_id, input.envKey, input.userId],
    );
    return row;
  }
}
