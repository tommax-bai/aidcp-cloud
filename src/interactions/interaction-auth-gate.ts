/**
 * 互动域环境授权闸的 **api 属主实现**（Block③ 物理拆库 L3，反方向跨属主互斥收口）。
 *
 * 属主：api。本类**持有 api 池、自己开事务**，是 kernel 端口 `InteractionAuthGate` 在单进程期的满足者。
 * automation 侧（`interaction-store.ts` 的 `upsertAuthStatus` / `ingestBatch`）只经该 kernel 接口转调，
 * **不再由 automation 的连接跑 api 的 SQL、也不再在 automation 事务里锁 api 属主表**。
 *
 * 与同目录 `offboard-cleanup-grant-ops.ts` 的关系：那一条是 api→automation 方向的同类收口
 * （automation 属主实现、持 automation 池、自开事务）；本文件是**反方向**的镜像，可对照阅读。
 *
 * 四条 SQL 全部从 `interaction-store.ts` 与 `db/environment-row-lock.ts` **逐字迁来 / 直接复用**：
 *   - 环境级行锁与其归属行回落锁：直接 import `db/environment-row-lock.ts`（同属 api，不复制 SQL）；
 *   - `client_env_revocation_holds` 的 `FOR SHARE`：逐字取自 `assertAccountScope`；
 *   - `accounts` 的 `FOR SHARE`：逐字取自 `assertAccountScope`。
 * 判定顺序、错误优先级、告警文案亦逐字保留，逐条依据见 kernel 端口文件头「MUST 逐字保留的不变量」。
 *
 * ## 为什么闸和写落不进同一笔事务（以及那意味着什么）
 * 闸读的四张表全属 api，被写的 `interaction_auth_state` 属 automation。属主不同 ⇒ 无法同事务。
 * 故闸只发**带有效期的条件写回执**，由 automation 拿着回执落地；回执覆盖不了「签发提交 → 落地提交」
 * 之间才发生的撤销，这一条已在 kernel 端口文件头如实登记，MUST NOT 在别处宣称成「已互斥」。
 */

import pg from 'pg';
import { lockEnvironmentRow, lockEnvironmentScopeRows } from '../db/environment-row-lock.js';
import type {
  InteractionAuthGate,
  InteractionAuthWriteAuthorization,
  InteractionAuthWriteAuthorizationInput,
  InteractionEnvironmentSerialization,
  InteractionScopeCheck,
  InteractionScopeCheckInput,
} from '../kernel/interaction-auth-gate-types.js';

export interface PgInteractionAuthGateOptions {
  /** api 属主池（组合根注入）。 */
  pool: pg.Pool;
  logger?: Pick<Console, 'warn'>;
}

export class PgInteractionAuthGate implements InteractionAuthGate {
  private readonly pool: pg.Pool;
  private readonly logger: Pick<Console, 'warn'>;

  constructor(options: PgInteractionAuthGateOptions) {
    this.pool = options.pool;
    this.logger = options.logger ?? console;
  }

  /**
   * 账号主数据校验（逐字取自改动前的 `assertAccountScope`）：查不到 ⇒ `account_not_found`（对应 404），
   * 平台不符 ⇒ `account_platform_mismatch`（对应 409）。`FOR SHARE` 保留：现在它锁的是**本域本库**的行。
   */
  private async checkAccount(
    client: pg.PoolClient,
    accountId: string,
    platform: string,
  ): Promise<'ok' | 'account_not_found' | 'account_platform_mismatch'> {
    const account = await client.query<{ platform: string }>(
      `SELECT platform FROM accounts WHERE account_id=$1 FOR SHARE`, [accountId],
    );
    if (!account.rows[0]) return 'account_not_found';
    return account.rows[0].platform === platform ? 'ok' : 'account_platform_mismatch';
  }

  /**
   * 登录态首写闸。一笔 api 本地事务里做完：环境级串行 → 账号主数据校验 → 发回执。
   *
   * **不查撤销 hold**：改动前该路径就是带 `allowRevocationHold=true` 调用 `assertAccountScope` 的
   * （撤销进行中仍允许边缘把登录态报上来，落不落由 automation 侧的离场检查决定）。MUST NOT 顺手改。
   */
  async authorizeAuthStateWrite(
    input: InteractionAuthWriteAuthorizationInput,
  ): Promise<InteractionAuthWriteAuthorization> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 与客户解绑 / 停用清理 / 管理员改派共用**同一把锁**：某环境的首次授权与归属变更必须观察到
      // 同一串行顺序。改动前这把锁由 automation 的连接去取（跨属主、拆库即无声失效）；现在它回到
      // api 自己的库、自己的事务里，拆库后照样互斥。
      //
      // 注册表没有这个环境时行锁不成立（命中 0 行、既不加锁也不报错），故回落去锁该环境的客户归属行：
      // 解绑 / 停用侧正是遍历 `client_env_scope` 找环境的（对注册表只 LEFT JOIN），锁住归属行即可与之串行。
      // 两者皆无行 ⇒ 解绑侧遍历不到这个环境 ⇒ 确无对手，此时不加锁是**有依据的**，且照样留痕。
      let serialization: InteractionEnvironmentSerialization = 'registered';
      if ((await lockEnvironmentRow(client, input.envKey, this.logger)) === 'unregistered') {
        const scoped = await lockEnvironmentScopeRows(client, input.envKey);
        serialization = scoped > 0 ? 'customer_scoped' : 'unclaimed';
        if (scoped === 0) {
          this.logger.warn(
            `[interaction] 环境 ${input.envKey} 既未注册也未归属任何客户：本次授权首写无环境级锁可取`
            + '（解绑侧遍历不到该环境 ⇒ 无并发对手）。',
          );
        }
      }
      const account = await this.checkAccount(client, input.accountId, input.platform);
      if (account !== 'ok') {
        await client.query('ROLLBACK');
        return { ok: false, reason: account };
      }
      await client.query('COMMIT');
      return {
        ok: true,
        receipt: {
          platform: input.platform,
          accountId: input.accountId,
          envKey: input.envKey,
          issuedAt: input.now,
          expiresAt: input.now + input.ttlMs,
          environmentSerialization: serialization,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 同步批次入库闸：撤销 hold → 账号主数据，一次判定、无回执、**不取环境级行锁**
   * （改动前 `assertAccountScope` 在这条路径上也不取，只 `FOR SHARE` 两张 api 表）。
   */
  async checkAccountScope(input: InteractionScopeCheckInput): Promise<InteractionScopeCheck> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const hold = await client.query(
        `SELECT 1 FROM client_env_revocation_holds WHERE env_key=$1 FOR SHARE`, [input.envKey],
      );
      if (hold.rows[0]) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'environment_revoked' };
      }
      const account = await this.checkAccount(client, input.accountId, input.platform);
      await client.query(account === 'ok' ? 'COMMIT' : 'ROLLBACK');
      return account === 'ok' ? { ok: true } : { ok: false, reason: account };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
