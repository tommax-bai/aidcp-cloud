/**
 * 互动域 api 属主表的写入口（change offboard-saga）—— aidcp-api 侧的单写者。
 *
 * 拆分方案 §5.1 把回复配置面（reply_templates / reply_rules / account_reply_profiles /
 * interaction_reply_config*）与互动配置面审计（interaction_audit_events）定为 **aidcp-api 单写**。
 * automation 的 interaction-store 历史上在离场清理（purgeDueOffboards）与过期清理（purgeExpiredContent）
 * 里直删这些 api 属主表——那是跨 owner 单事务/跨层直写，违反单写。
 *
 * 收口范式（与 offboard-write-adapter 同构、方向相反）：接口 `InteractionApiPurgePort` 定义在**消费方**
 * automation 的 interaction-store 侧；**本文件只做结构匹配、绝不 import 那个接口或任何 automation 模块**，
 * 由组合根 server.ts 把本实例注入 InteractionStore。方法接调用方句柄，SQL 与改动前逐字一致。
 *
 * 离场 saga 里，本类的 reply 清理由 interaction-store 在**独立事务**（与 automation 表删除分步提交）中调用，
 * 故不再是一个跨 owner 的大事务；DELETE 天然幂等，中断重入照删剩余、不重复副作用。
 */
import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export class InteractionApiWrites {
  /** 离场清理：删账号维度的回复配置（api 属主）。仅按 account_id，与改动前 purgeDueOffboards 逐字一致。 */
  async purgeReplyConfigForAccount(client: Queryable, accountId: string): Promise<void> {
    await client.query(`DELETE FROM reply_templates WHERE account_id=$1`, [accountId]);
    await client.query(`DELETE FROM reply_rules WHERE account_id=$1`, [accountId]);
    await client.query(`DELETE FROM account_reply_profiles WHERE account_id=$1`, [accountId]);
    await client.query(`DELETE FROM interaction_reply_config_versions WHERE account_id=$1`, [accountId]);
    await client.query(`DELETE FROM interaction_reply_configs WHERE account_id=$1`, [accountId]);
  }

  /** 过期清理：删 365 天前的配置面审计（api 属主）。与改动前 purgeExpiredContent 逐字一致。 */
  async purgeExpiredAuditEvents(client: Queryable, now: number): Promise<number> {
    const result = await client.query(
      `DELETE FROM interaction_audit_events WHERE created_at < to_timestamp($1/1000.0)-interval '365 days'`,
      [now],
    );
    return result.rowCount ?? 0;
  }
}
