import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/index.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';
import { SHANGHAI_DAY_START_SQL } from '../time/shanghai-day.js';
import { parseDeploymentTarget, type DeploymentTarget } from '../deployment-target.js';
import { RiskStateNotOwnedError, type OwnershipMode } from './ownership.js';
import { RISK_ACTIONS } from './types.js';
import type {
  ActionQuota,
  CounterEvent,
  InteractionAction,
  InteractionStore,
  RiskAction,
  RiskQuotaLevel,
  RiskState,
  RiskStatus,
  RiskStore,
} from './types.js';

const { Pool } = pg;

export interface PgRiskStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /**
   * 属主池（Block③ 物理拆库 L3）。`risk_state` / `risk_counters` / `risk_interactions` 都是
   * automation 属主表 ⇒ 组合根 MUST 注入 automationPool。不注入则自建私池、按下面的 env 回落
   * 连**共享库**：一旦设了 `AIDCP_PG_AUTOMATION_URL`，写就留在旧库、而已解耦的读端口读新库
   * ⇒ 面板永远看到空/陈旧风控态且零报错。注入的池由组合根掌控生命周期（见 `close()`）。
   */
  pool?: pg.Pool;
  /** schema 保障能力注入端口（必填、无默认）：组合根传 automation 的 ensureCapabilitySchema。 */
  schemaEnsurer: SchemaEnsurer;
  /**
   * 本进程的部署目标（change risk-state-cross-process-integrity）：risk_state 条件写的属主谓词。
   * 缺省（不注入）→ ownershipMode 恒为 'off'，saveState 走历史无谓词 upsert（逐位零回归）。
   */
  executionTarget?: DeploymentTarget;
  /** 条件写模式。有 target 时缺省 'enforce'（条件写生效、并发接管即作废先写方）；无 target 恒 'off'。 */
  ownershipMode?: OwnershipMode;
}

export const RISK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS risk_counters (
  id          BIGSERIAL PRIMARY KEY,
  account_id  TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('like','collect','comment','follow','publish','view','search','comment_like','join_group','dm_reply')),
  count       INTEGER NOT NULL DEFAULT 1,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risk_counters_account_time ON risk_counters (account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_counters_account_action_time ON risk_counters (account_id, action, occurred_at DESC);
-- 面板今日聚合（todayTotals / todayTotalsByAccount / likeRate）不带 account 前缀、只按 occurred_at 过滤；
-- 上面两个 account 打头的复合索引服务不了纯时间范围扫描 → 补 occurred_at 打头索引消灭全表扫描（change console-cloud-panel-hardening #21）。
CREATE INDEX IF NOT EXISTS idx_risk_counters_time ON risk_counters (occurred_at DESC);

CREATE TABLE IF NOT EXISTS risk_state (
  account_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL CHECK (status IN ('normal','warned','restricted','frozen')),
  quota_level    TEXT NOT NULL CHECK (quota_level IN ('conservative','normal','aggressive')),
  signal_count   INTEGER NOT NULL DEFAULT 0,
  last_signal_at TIMESTAMPTZ,
  status_since   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_interactions (
  account_id    TEXT NOT NULL,
  note_id       TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('like','collect','comment')),
  interacted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, note_id, action)
);

CREATE INDEX IF NOT EXISTS idx_risk_interactions_account_time ON risk_interactions (account_id, interacted_at DESC);

-- 幂等迁移：已存在的 risk_counters 表（CREATE TABLE IF NOT EXISTS 不会改其旧 CHECK）需放行
-- comment_like / join_group。只动 risk_counters（配额计数）；risk_interactions（每笔记去重）
-- 刻意不含二者。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'risk_counters'::regclass
      AND conname = 'risk_counters_action_check'
      AND pg_get_constraintdef(oid) LIKE '%comment_like%'
      AND pg_get_constraintdef(oid) LIKE '%join_group%'
      AND pg_get_constraintdef(oid) LIKE '%dm_reply%'
      AND pg_get_constraintdef(oid) LIKE '%search%'
  ) THEN
    ALTER TABLE risk_counters DROP CONSTRAINT IF EXISTS risk_counters_action_check;
    ALTER TABLE risk_counters ADD CONSTRAINT risk_counters_action_check
      CHECK (action IN ('like','collect','comment','follow','publish','view','search','comment_like','join_group','dm_reply'));
  END IF;
END $$;

-- 记账 outbox（change risk-state-cross-process-integrity，迁移 0061）：边缘确认的真实动作先落这里，
-- 再由 worker 认领并在单事务里写 risk_counters + 标记 applied。形状照抄 delegated_tasks 的认领范式。
-- 默认运行时只用本常量探测对象形状；仅 AIDCP_SCHEMA_SELF_CREATE=true 的回滚态会执行它。
-- 对象定义 MUST 与 migrations/0061 及此前 risk migrations 同源。
CREATE TABLE IF NOT EXISTS risk_counter_outbox (
  id               BIGSERIAL PRIMARY KEY,
  account_id       TEXT NOT NULL,
  action           TEXT NOT NULL CHECK (action IN ('like','collect','comment','follow','publish','view','search','comment_like','join_group','dm_reply')),
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  dedupe_key       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  claim_token      TEXT,
  claim_expires_at TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_counter_outbox_target_dedupe
  ON risk_counter_outbox (execution_target, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_risk_counter_outbox_claim
  ON risk_counter_outbox (execution_target, status, claim_expires_at, id);

-- exactly-once 交给数据库：一条 outbox 行最多产生一行计数（MUST NOT 用内存 Set 去重）。
ALTER TABLE risk_counters ADD COLUMN IF NOT EXISTS outbox_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_counters_outbox
  ON risk_counters (outbox_id) WHERE outbox_id IS NOT NULL;
`;

type PgConnectionConfig = Required<Pick<PgRiskStoreOptions, 'host' | 'port' | 'database' | 'user' | 'password'>>;

export function pgRiskConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PgConnectionConfig {
  return {
    host: env.AIDCP_PG_HOST ?? DEFAULT_PG_CONFIG.host,
    port: Number(env.AIDCP_PG_PORT ?? DEFAULT_PG_CONFIG.port),
    database: env.AIDCP_PG_DATABASE ?? env.AIDCP_PG_DB ?? DEFAULT_PG_CONFIG.database,
    user: env.AIDCP_PG_USER ?? DEFAULT_PG_CONFIG.user,
    password: env.AIDCP_PG_PASSWORD ?? DEFAULT_PG_CONFIG.password,
  };
}

function emptyActionQuota(): ActionQuota {
  return Object.fromEntries(RISK_ACTIONS.map((action) => [action, 0])) as ActionQuota;
}

function rowsToActionQuota(rows: { action: string; total: number }[]): ActionQuota {
  const totals = emptyActionQuota();
  for (const row of rows) {
    if ((RISK_ACTIONS as readonly string[]).includes(row.action)) {
      totals[row.action as RiskAction] = row.total;
    }
  }
  return totals;
}

export class PgRiskStore implements RiskStore, InteractionStore {
  private readonly pool: pg.Pool;
  private readonly ownsPool: boolean;
  private readonly executionTarget?: DeploymentTarget;
  private readonly ownershipMode: OwnershipMode;
  private readonly schemaEnsurer: SchemaEnsurer;
  private initPromise?: Promise<void>;
  private retentionTimer?: ReturnType<typeof setInterval>;

  constructor(options: PgRiskStoreOptions) {
    const config = pgRiskConfigFromEnv();
    this.schemaEnsurer = options.schemaEnsurer;
    this.ownsPool = options.pool === undefined;
    this.pool =
      options.pool ??
      new Pool({
        host: options.host ?? config.host,
        port: options.port ?? config.port,
        database: options.database ?? config.database,
        user: options.user ?? config.user,
        password: options.password ?? config.password,
      });
    this.executionTarget = options.executionTarget;
    // 无 target ⇒ 无属主谓词可用 ⇒ 只能是 'off'；有 target 缺省 'enforce'（安全默认：并发接管即作废先写方）。
    // 绝不让「配置缺失」偷偷变成「强制生效」或反过来。
    this.ownershipMode = options.executionTarget ? options.ownershipMode ?? 'enforce' : 'off';
  }

  /** 当前生效的归属强制模式（供装配自证与面板呈现）。 */
  ownership(): { mode: OwnershipMode; target: DeploymentTarget | null } {
    return { mode: this.ownershipMode, target: this.executionTarget ?? null };
  }

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((err) => {
        // schema/连接恢复后，下一次真实解析可以重新探测；MUST NOT 永久缓存一次失败。
        this.initPromise = undefined;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.7）：默认只探测、不建表。
    // 多账号并发物化共用上面的 single-flight；探不到则带 version id fail-closed。
    await this.schemaEnsurer(this.pool, {
      capability: 'risk_control',
      sinceVersion: '0061_risk_writer_ownership_and_outbox',
      ddl: [RISK_SCHEMA_SQL],
    });
    // 本地保留清理（change retention-local-purge）：risk_counters 配额计数流水由本属主**自驱**日频 purge
    // ——不再由面板层 retention-sweeper 跨域伸手进来调（本 change 只搬「谁来触发」，purge 语义/阈值不动）。
    // 只调既有的 purgeCountersOlderThan（DELETE 走 occurred_at 索引、只删 risk_counters 过期行、不碰
    // risk_interactions 去重台账、不碰风控单写状态/归属逻辑）。默认保留 7 天（风控只回读 1 天），
    // env AIDCP_RETENTION_RISK_DAYS 覆盖。阈值/周期与被取代的 sweeper 逐位一致，删的数据不变。
    if (!this.retentionTimer) {
      this.retentionTimer = this.startRetentionTimer();
    }
  }

  /** 本地保留清理定时器（change retention-local-purge）。unref、runOnStart、每轮 try/catch、绝不逃逸。 */
  private startRetentionTimer(): ReturnType<typeof setInterval> {
    const d = Number(process.env.AIDCP_RETENTION_RISK_DAYS);
    const days = Number.isFinite(d) && d > 0 ? d : 7;
    const ei = Number(process.env.AIDCP_RETENTION_INTERVAL_MS);
    const intervalMs = Number.isFinite(ei) && ei > 0 ? ei : 24 * 60 * 60 * 1000;
    const runOnce = async (): Promise<void> => {
      try {
        const deleted = await this.purgeCountersOlderThan(days);
        if (deleted > 0) console.log(`[retention] risk_counters 保留清理完成：-${deleted}`);
      } catch (err) {
        console.warn(`[retention] risk_counters 清理失败（跳过本轮，不拖累其它表）：${(err as Error).message}`);
      }
    };
    void runOnce();
    const timer = setInterval(() => {
      void runOnce();
    }, intervalMs);
    timer.unref?.();
    console.log(`[retention] risk_counters 保留清理已启动（周期 ${Math.round(intervalMs / 3_600_000)}h；保留 ${days}d）`);
    return timer;
  }

  async loadCounters(accountId: string, since: number): Promise<CounterEvent[]> {
    const { rows } = await this.pool.query<{ action: RiskAction; occurred_at: Date; count: number }>(
      `SELECT action, occurred_at, count FROM risk_counters
       WHERE account_id = $1 AND occurred_at > to_timestamp($2 / 1000.0)
       ORDER BY occurred_at ASC`,
      [accountId, since],
    );
    return rows.map((row) => ({ action: row.action, occurredAt: row.occurred_at.getTime(), count: row.count }));
  }

  async todayTotalsForAccount(accountId: string): Promise<ActionQuota> {
    const { rows } = await this.pool.query<{ action: string; total: number }>(
      `SELECT action, COALESCE(SUM(count), 0)::int AS total
       FROM risk_counters
       WHERE account_id = $1 AND occurred_at >= ${SHANGHAI_DAY_START_SQL}
       GROUP BY action`,
      [accountId],
    );
    return rowsToActionQuota(rows);
  }

  async totalsForAccountSince(accountId: string, since: number): Promise<ActionQuota> {
    const { rows } = await this.pool.query<{ action: string; total: number }>(
      `SELECT action, COALESCE(SUM(count), 0)::int AS total
       FROM risk_counters
       WHERE account_id = $1 AND occurred_at >= to_timestamp($2 / 1000.0)
       GROUP BY action`,
      [accountId, since],
    );
    return rowsToActionQuota(rows);
  }

  async appendCounter(accountId: string, action: RiskAction, occurredAt: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO risk_counters (account_id, action, count, occurred_at)
       VALUES ($1, $2, 1, to_timestamp($3 / 1000.0))`,
      [accountId, action, occurredAt],
    );
  }

  async loadState(accountId: string): Promise<RiskState | null> {
    const { rows } = await this.pool.query<{
      account_id: string;
      status: RiskStatus;
      quota_level: RiskQuotaLevel;
      signal_count: number;
      last_signal_at: Date | null;
      status_since: Date;
      updated_at: Date;
    }>('SELECT * FROM risk_state WHERE account_id = $1', [accountId]);
    const row = rows[0];
    if (!row) return null;
    return {
      accountId: row.account_id,
      status: row.status,
      quotaLevel: row.quota_level,
      signalCount: row.signal_count,
      lastSignalAt: row.last_signal_at?.getTime() ?? null,
      statusSince: row.status_since.getTime(),
      updatedAt: row.updated_at.getTime(),
    };
  }

  /**
   * 写风控最终状态（change risk-target-follows-active-session）。
   *
   * **带属主谓词的单语句**：谓词 `accounts.execution_target = <本进程 target>`。归属已改为「跟随当次连接」——
   * 握手刚把它设成本 target，故正常运行时谓词**总是命中**。影响行数为 0 只发生在写入前一瞬另一个
   * 连接抢先接管了同一账号：此时**先写方的这次写作废**，抛 `RiskStateNotOwnedError`（附接管方 target），
   * MUST NOT 返回成功、MUST NOT 重试、MUST NOT 换个宽松谓词把它盖回去——盖回正是本 change 要消灭的
   * 「后写方被先写方陈旧态覆盖」。抛出后由 controller 的 onStateWriteRejected 驱逐本地缓存、下次从库重读。
   *
   * 顺带收掉一个既有隐患：历史裸 upsert 能为**不存在的账号**造幽灵 risk_state 行（面板靠应用层
   * assertAccountExists 挡着）。条件写把这道保护变成结构性的。
   *
   * - `off`（无 target / `AIDCP_RISK_OWNERSHIP_ENFORCE=false` 回滚）→ 历史无谓词 upsert，逐位零回归。
   * - `enforce`（有 target 时的默认）→ 条件写；0 行即作废先写方并抛。
   */
  async saveState(state: RiskState): Promise<void> {
    if (this.ownershipMode === 'off' || !this.executionTarget) {
      await this.upsertStateUnconditional(state);
      return;
    }
    const { rowCount } = await this.pool.query(
      `WITH owner AS (
         SELECT 1 FROM accounts WHERE account_id = $1 AND execution_target = $8
       )
       INSERT INTO risk_state (account_id, status, quota_level, signal_count, last_signal_at, status_since, updated_at)
       SELECT $1, $2, $3, $4,
              CASE WHEN $5::bigint IS NULL THEN NULL ELSE to_timestamp($5 / 1000.0) END,
              to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0)
        WHERE EXISTS (SELECT 1 FROM owner)
       ON CONFLICT (account_id) DO UPDATE SET
         status = EXCLUDED.status,
         quota_level = EXCLUDED.quota_level,
         signal_count = EXCLUDED.signal_count,
         last_signal_at = EXCLUDED.last_signal_at,
         status_since = EXCLUDED.status_since,
         updated_at = EXCLUDED.updated_at
       RETURNING account_id`,
      [
        state.accountId,
        state.status,
        state.quotaLevel,
        state.signalCount,
        state.lastSignalAt,
        state.statusSince,
        state.updatedAt,
        this.executionTarget,
      ],
    );
    if ((rowCount ?? 0) > 0) return;

    // 0 行 = 写入前一瞬账号已被另一连接接管。作废先写方，绝不回落无谓词 upsert 把接管方状态盖回去。
    const { owner, cause } = await this.resolveOwnership(state.accountId);
    throw new RiskStateNotOwnedError(state.accountId, this.executionTarget, owner, cause);
  }

  /** 历史无谓词 upsert（`off` 模式的落地写）。 */
  private async upsertStateUnconditional(state: RiskState): Promise<void> {
    await this.pool.query(
      `INSERT INTO risk_state (account_id, status, quota_level, signal_count, last_signal_at, status_since, updated_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::bigint IS NULL THEN NULL ELSE to_timestamp($5 / 1000.0) END, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0))
       ON CONFLICT (account_id) DO UPDATE SET
         status = EXCLUDED.status,
         quota_level = EXCLUDED.quota_level,
         signal_count = EXCLUDED.signal_count,
         last_signal_at = EXCLUDED.last_signal_at,
         status_since = EXCLUDED.status_since,
         updated_at = EXCLUDED.updated_at`,
      [state.accountId, state.status, state.quotaLevel, state.signalCount, state.lastSignalAt, state.statusSince, state.updatedAt],
    );
  }

  /** 0 行的三种原因必须可区分：账号不存在 / 归属为空 / 归属是别人。 */
  private async resolveOwnership(
    accountId: string,
  ): Promise<{ owner: DeploymentTarget | null | undefined; cause: 'account_not_found' | 'unowned' | 'owned_by_other' }> {
    const { rows } = await this.pool.query<{ execution_target: string | null }>(
      `SELECT execution_target FROM accounts WHERE account_id = $1`,
      [accountId],
    );
    if (rows.length === 0) return { owner: undefined, cause: 'account_not_found' };
    const owner = parseDeploymentTarget(rows[0].execution_target);
    if (!owner) return { owner: null, cause: 'unowned' };
    return { owner, cause: 'owned_by_other' };
  }

  async hasInteraction(accountId: string, noteId: string, action: InteractionAction): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM risk_interactions
       WHERE account_id = $1 AND note_id = $2 AND action = $3
       LIMIT 1`,
      [accountId, noteId, action],
    );
    return (rowCount ?? 0) > 0;
  }

  async recordInteraction(accountId: string, noteId: string, action: InteractionAction, interactedAt: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO risk_interactions (account_id, note_id, action, interacted_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
       ON CONFLICT (account_id, note_id, action) DO NOTHING`,
      [accountId, noteId, action, interactedAt],
    );
  }

  /**
   * 该账号今日（Asia/Shanghai 自然日 00:00 起）某动作的互动计数（change content-schedule-comments）。
   * 供内容排期评论日上限判定——持久已发历史（重启不清零），与「任务在跑?1:0」相加做原子上限。
   * 显式 Asia/Shanghai 下界，对齐 publish 侧 countPublishedTodayForAccount 与风控 day quota 口径。
   */
  async countInteractionsTodayForAccount(accountId: string, action: InteractionAction): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM risk_interactions
        WHERE account_id = $1 AND action = $2 AND interacted_at >= ${SHANGHAI_DAY_START_SQL}`,
      [accountId, action],
    );
    return Number(rows[0]?.n ?? '0');
  }

  /**
   * 数据保留：删早于 N 天的配额计数流水（change console-cloud-panel-hardening #21）。
   * 风控只回读最近 1 天（见 loadCounters 的 since），更早的行是永不再被业务读到的死数据。
   * DELETE 走 idx_risk_counters_time（occurred_at），不全表扫描。
   * risk_interactions（每笔记去重台账）刻意不在此清理——去重语义依赖历史留存。
   */
  async purgeCountersOlderThan(days: number): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM risk_counters WHERE occurred_at < now() - ($1::int * interval '1 day')`,
      [days],
    );
    return res.rowCount ?? 0;
  }

  /**
   * 只 end **自己建的**池；注入的属主池由组合根掌控生命周期（见 ownsPool）。
   * 注入共享池后还照 end，一次局部失败就会打死全域共用的池、升级成进程级瘫痪
   * （aidcp-cloud 7f5232a 修过一次同形 bug）。
   */
  async close(): Promise<void> {
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = undefined;
    }
    if (this.ownsPool) await this.pool.end();
  }
}
