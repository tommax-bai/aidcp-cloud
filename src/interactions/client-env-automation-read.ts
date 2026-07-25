/**
 * 客户环境生命周期对 automation 域只读投影端口的**本地实现**（Block③ 物理拆库 L3）。
 *
 * 属主：automation。本类跑在 **automation 自己的连接池** 上（组合根注入 automationPool），
 * 是 kernel 端口 `ClientEnvAutomationReader` 在单进程期的满足者：客户↔环境归属存储（api 属主
 * `client-auth/client-user-store.ts`）只依赖该 kernel 接口、经本实现取 automation 域投影，
 * **读方绝不直连 automation 的库、也不知道其表结构**。拆进程后（Block②）同一端口换 HTTP 客户端，
 * 本类留在 automation 服务侧。
 *
 * 读到的表全属 automation：`interaction_offboards`（离场记录）、`interaction_auth_state`
 * （微信互动授权绑定）、`risk_state`（风控态）。这些 SQL 从 client-user-store 逐字迁来，
 * 只把「api 的连接」换成「automation 的连接」，过滤 / 投影语义逐字保持。
 *
 * 与同目录 `offboard-write-adapter.ts`（离场表的单写者）同域配对：那边是写、这边是读。
 * 差别在于写适配器接**调用方的事务句柄**（故仍与 api 侧共提交，是拆库时要单独解的跨库事务），
 * 本读实现**只用自己的池、不接事务句柄** —— 读侧因此已经是 flip-ready 的。
 *
 * 缺表（`42P01`）不在此吞：如实抛出，由读方按其历史降级策略处理。
 */

import pg from 'pg';
import type {
  ClientEnvAutomationReader,
  EnvRiskStateProjection,
  OffboardProjection,
  OffboardProjectionReason,
  OffboardProjectionState,
} from '../kernel/client-env-automation-types.js';

/** 离场记录的裸行形状（属主表列名口径）。 */
interface OffboardDbRow {
  offboard_id: string;
  env_key: string;
  account_id: string;
  state: OffboardProjectionState;
  reason: OffboardProjectionReason;
  requested_at: Date;
  purge_due_at: Date;
}

function toOffboardProjection(row: OffboardDbRow): OffboardProjection {
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

export interface PgClientEnvAutomationReadOptions {
  /** automation 属主池（组合根注入）。 */
  pool: pg.Pool;
}

export class PgClientEnvAutomationRead implements ClientEnvAutomationReader {
  private readonly pool: pg.Pool;

  constructor(options: PgClientEnvAutomationReadOptions) {
    this.pool = options.pool;
  }

  /** 单条离场记录（原 client-user-store.getOffboard 的 SQL，逐字迁移；归属过滤留在 SQL 里）。 */
  async offboardForUser(offboardId: string, userId: string): Promise<OffboardProjection | null> {
    const { rows } = await this.pool.query<OffboardDbRow>(
      `SELECT offboard_id,env_key,account_id,state,reason,requested_at,purge_due_at
         FROM interaction_offboards WHERE offboard_id=$1 AND user_id=$2`,
      [offboardId, userId],
    );
    const row = rows[0];
    return row ? toOffboardProjection(row) : null;
  }

  /**
   * 全部未清除的微信离场记录（原 listAllEnvironments 里 keys CTE 的 UNION 分支
   * 与 `LEFT JOIN interaction_offboards` 分支的**同一谓词**，一次取出供读方两处共用）。
   */
  async activeWechatOffboards(): Promise<OffboardProjection[]> {
    const { rows } = await this.pool.query<OffboardDbRow>(
      `SELECT offboard_id,env_key,account_id,state,reason,requested_at,purge_due_at
         FROM interaction_offboards
        WHERE platform='wechat_channels' AND state <> 'purged'`,
    );
    return rows.map(toOffboardProjection);
  }

  /** 给定环境键中已有微信互动授权绑定的那些（原 `JOIN interaction_auth_state` 的存在性侧）。 */
  async wechatBoundEnvKeys(envKeys: string[]): Promise<string[]> {
    if (!envKeys.length) return [];
    const { rows } = await this.pool.query<{ env_key: string }>(
      `SELECT env_key FROM interaction_auth_state
        WHERE platform='wechat_channels' AND env_key = ANY($1::text[])`,
      [envKeys],
    );
    return rows.map((row) => row.env_key);
  }

  /** 某账号绑定的微信互动环境键（表上 (platform, account_id) 为主键 ⇒ 至多一条）。 */
  async wechatEnvKeysForAccount(accountId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ env_key: string }>(
      `SELECT env_key FROM interaction_auth_state
        WHERE platform='wechat_channels' AND account_id=$1`,
      [accountId],
    );
    return rows.map((row) => row.env_key);
  }

  /**
   * 某环境在给定平台上的互动授权绑定账号（原 client-user-store 事务内那几条
   * `SELECT account_id … WHERE env_key=$1 AND platform=$2` 的读侧，**去掉了跨库行锁**——
   * 锁不能跨库，互斥改由 api 侧本域准入表的条件写承担，见 kernel 端口说明）。
   * 表上 (platform, env_key) 唯一 ⇒ 至多一条。
   *
   * 缺表 / 连接故障**如实抛**：读方把 null 当作「确无绑定」的业务事实，降级会变成静默假成功。
   */
  async boundAccountForEnv(envKey: string, platform: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ account_id: string }>(
      `SELECT account_id FROM interaction_auth_state
        WHERE platform=$2 AND env_key=$1`,
      [envKey, platform],
    );
    return rows[0]?.account_id ?? null;
  }

  /** 批量风控态投影（原 listAllEnvironments 的 `LEFT JOIN risk_state` 侧）；只返回有风控行的账号。 */
  async riskStateProjection(accountIds: string[]): Promise<EnvRiskStateProjection[]> {
    if (!accountIds.length) return [];
    const { rows } = await this.pool.query<{
      account_id: string;
      status: string | null;
      quota_level: string | null;
    }>(
      `SELECT account_id, status, quota_level FROM risk_state WHERE account_id = ANY($1::text[])`,
      [accountIds],
    );
    return rows.map((row) => ({
      accountId: row.account_id,
      status: row.status,
      quotaLevel: row.quota_level,
    }));
  }
}
