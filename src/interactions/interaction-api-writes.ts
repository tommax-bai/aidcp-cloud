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
 *
 * Block③ L3 追加 `insertAuditEvent`：配置面审计的**写**侧也收口到本类。它与两个 DELETE 的关键差别是
 * **调用方不是 interaction-store 而是 outbox 中继** —— 那笔 INSERT 在 automation 侧与业务写同事务
 * （拆库后即跨库事务，端口解决不了），故改最终一致：automation 入队 → 中继在 api 池上调本方法幂等落地。
 */
import type pg from 'pg';
import type { InteractionAuditEventRecord } from '../kernel/interaction-audit-outbox.js';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export class InteractionApiWrites {
  /**
   * 配置面审计的落地（Block③ L3）。automation 侧不再直插本表，改为把同一行内容入队到本域 outbox，
   * 由中继调用本方法在 **api 池**上落地。
   *
   * **幂等**：outbox 是 at-least-once，同一条可能被投递多次；`event_id` 是本表 TEXT 主键、
   * 且由 automation 侧在**入队时**生成随载荷带来，故 `ON CONFLICT DO NOTHING` 即天然幂等。
   * 事件 id MUST NOT 由中继现生成——那样重放就变成重复插入。
   *
   * **`created_at` 用业务发生时刻**（载荷里的 `createdAt`），不是本次落地时刻：用落地时刻会让审计
   * 时间线随中继延迟漂移，365 天保留期也跟着漂。
   *
   * 返回「本次是否真的插入了新行」：false = 该 event_id 已在（重放）。MUST NOT 只回 void ——
   * 「插了几行」是这条链路唯一能自证没有静默丢事件的地方。
   */
  async insertAuditEvent(client: Queryable, record: InteractionAuditEventRecord): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO interaction_audit_events
        (event_id,platform,account_id,env_key,actor,action,config_version,entity_type,entity_id,summary,labels,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,to_timestamp($12/1000.0))
       ON CONFLICT (event_id) DO NOTHING`,
      [record.eventId, record.platform, record.accountId, record.envKey, record.actor, record.action,
        record.configVersion, record.entityType, record.entityId, record.summary,
        JSON.stringify(record.labels), record.createdAt],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * 离场清理：删账号维度的回复配置（api 属主）。仅按 account_id —— 这五张表没有 env_key 列，
   * 天然只能按账号删，**故调用方（离场 saga）有责任先核验该账号确实仍绑在被清理的那个环境上**；
   * 账号已改派 / 从未绑定时 MUST NOT 调本方法（见 interaction-store.purgeDueOffboards 的归属核验）。
   *
   * 返回真实删除的总行数：离场清理要能事后回答「删了几行」，MUST NOT 只回 void（0 行也当成功是本仓红线）。
   */
  async purgeReplyConfigForAccount(client: Queryable, accountId: string): Promise<number> {
    let removed = 0;
    for (const sql of [
      `DELETE FROM reply_templates WHERE account_id=$1`,
      `DELETE FROM reply_rules WHERE account_id=$1`,
      `DELETE FROM account_reply_profiles WHERE account_id=$1`,
      `DELETE FROM interaction_reply_config_versions WHERE account_id=$1`,
      `DELETE FROM interaction_reply_configs WHERE account_id=$1`,
    ]) {
      const result = await client.query(sql, [accountId]);
      removed += result.rowCount ?? 0;
    }
    return removed;
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
