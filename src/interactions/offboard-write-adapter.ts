/**
 * 离场写入适配器（change offboard-saga）—— automation 侧的**离场表单写者**。
 *
 * 拆分方案 §5.1：interaction_offboards / interaction_offboard_audit / interaction_auth_state /
 * interaction_runtime_controls 归 aidcp-automation 单写。本文件是这四张表在离场路径上的唯一写入点，
 * 供 aidcp-api 的 client-user-store 经 `OffboardWritePort`（定义在 api 侧 offboard-write-port.ts）注入调用。
 *
 * **本文件绝不 import 那个接口**（那是 automation→api 的跨层依赖）：只做结构匹配，
 * 由组合根 server.ts 把本实例作为 `OffboardWritePort` 注入。SQL 与改动前 client-user-store 逐字一致，
 * 方法接调用方事务句柄，故行为逐位等价。
 *
 * **Block③ L3 更新**：cleanup-grant 的三条 SQL（签票 / 烧票 / 审计行）已从本文件迁往同目录
 * `offboard-cleanup-grant-ops.ts` —— 那两个操作与任何 api 写都不共事务，故收成**自开事务、
 * 跑 automation 池**的属主操作；本文件只留仍需接调用方句柄的那三个写（它们与 api 侧归属收权共提交）。
 */
import crypto from 'node:crypto';
import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

interface OffboardRow {
  offboard_id: string;
  env_key: string;
  account_id: string;
  state: 'pending_edge' | 'dispatched' | 'tombstoned' | 'purged';
  reason: 'environment_unbind' | 'customer_terminated' | 'admin_revoked';
  requested_at: Date;
  purge_due_at: Date;
}

const REVOKED_CAPABILITIES = JSON.stringify({
  commentsRead: false, commentsReply: false, dmRead: false, dmSendText: false, dmSendImage: false,
});

export class OffboardWriteAdapter {
  async revokeInteractionAccess(
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

  async enqueueOffboard(
    client: Queryable,
    input: { userId: string; envKey: string; accountId: string; reason: OffboardRow['reason']; actor: string | null },
  ): Promise<OffboardRow> {
    const offboardId = crypto.randomUUID();
    const inserted = await client.query<OffboardRow>(
      `INSERT INTO interaction_offboards
         (offboard_id,platform,account_id,env_key,user_id,reason,state,requested_at,purge_due_at,updated_at)
       VALUES ($1,'wechat_channels',$2,$3,$4,$5,'pending_edge',now(),now()+interval '29 days',now())
       ON CONFLICT (platform,env_key) WHERE state <> 'purged' DO UPDATE
         SET updated_at=interaction_offboards.updated_at
       RETURNING offboard_id,env_key,account_id,state,reason,requested_at,purge_due_at`,
      [offboardId, input.accountId, input.envKey, input.userId, input.reason],
    );
    const row = inserted.rows[0];
    if (!row || row.account_id !== input.accountId) throw new Error('offboard_scope_conflict');
    await this.revokeInteractionAccess(client, {
      accountId: input.accountId,
      actor: input.actor,
      requireAuthState: true,
    });
    await client.query(
      `INSERT INTO interaction_offboard_audit
         (event_id,offboard_id,platform,account_id,env_key,user_id,event,status)
       VALUES ($1,$2,'wechat_channels',$3,$4,$5,'access_revoked','pending_edge')`,
      [crypto.randomUUID(), row.offboard_id, input.accountId, input.envKey, input.userId],
    );
    return row;
  }

  async enqueueProvisionedUnboundOffboard(
    client: Queryable,
    input: { userId: string; envKey: string },
  ): Promise<OffboardRow> {
    const offboardId = crypto.randomUUID();
    const accountId = input.envKey;
    const inserted = await client.query<OffboardRow>(
      `INSERT INTO interaction_offboards
       (offboard_id,platform,account_id,env_key,user_id,reason,state,requested_at,
          tombstoned_at,purge_due_at,updated_at)
       VALUES ($1,'wechat_channels',$2,$3,$4,'environment_unbind','tombstoned',now(),now(),now()+interval '29 days',now())
       RETURNING offboard_id,env_key,account_id,state,reason,requested_at,purge_due_at`,
      [offboardId, accountId, input.envKey, input.userId],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('offboard_terminal_insert_failed');
    await client.query(
      `INSERT INTO interaction_offboard_audit
         (event_id,offboard_id,platform,account_id,env_key,user_id,event,status)
       VALUES
         ($1,$3,'wechat_channels',$4,$5,$6,'access_revoked','tombstoned'),
         ($2,$3,'wechat_channels',$4,$5,$6,'unbound_cleanup_not_required','tombstoned')`,
      [crypto.randomUUID(), crypto.randomUUID(), row.offboard_id, accountId, input.envKey, input.userId],
    );
    return row;
  }

}
