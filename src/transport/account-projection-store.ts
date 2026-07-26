/**
 * automation 域对 api 属主账号主数据的**去规范化守卫投影**（change automation-accounts-projection）。
 *
 * ## 为什么是投影，不是跨进程调用
 *
 * accounts 属 api 单写。automation 侧原本有 10 处在自己的查询里内联 accounts，绝大多数是守卫读
 * （「这个账号还在吗」「它属于这个分组吗」），其中三处夹在写路径 / 写事务内。把这类守卫改成一次
 * 跨进程 HTTP 调用会同时付两笔代价：拆掉「校验与写在同一事务里」的原子性，并给写路径加一跳网络。
 *
 * 正解是去规范化：把守卫真正需要的三列冷备进 automation 自己的库，守卫改读本域投影表。守卫因此
 * 回到同库、回到单条语句内，跨库行锁与跨库事务这两个话题在这批点位上直接消失。
 *
 * ## 同步通路：全量快照拉取（承重），而不是事件推送
 *
 * 刷新器周期性地经 kernel 端口 `AccountRosterSourcePort` 取**全量**花名册，幂等 upsert 进投影表，
 * 然后推进新鲜期。选全量快照而不是「属主域 outbox 入队 → 中继推送 → 消费方 inbox 去重」，有三条理由：
 *
 * 1. **本仓自己的结论就是「轮询才是承重通道」**。`src/transport/event-outbox.ts` 文件头写得很清楚：
 *    唯一承重的投递通道是轮询，通知只是加速器。既然承重面是轮询，对一张 37 行的表，直接轮询
 *    **快照**比轮询**增量事件**更强：快照天然自愈，不依赖「此前每一条事件都收到过」；漏一条事件的
 *    故障模式在快照模型里根本不存在。
 * 2. **事件推送这条路在本仓今天缺一半地基**。既有的 `event_outbox` 属 automation（见
 *    boundaries/table-ownership.json），api 往里写本身就是跨属主写；要走「本域 outbox」形态，得先给
 *    api 域另立一张 outbox 表 + 中继 + 消费方 inbox 去重表。为一张 37 行的花名册立这套机器，属过度设计。
 * 3. **换过去的成本很低，且不影响本文件的对外形状**。刷新的应用步骤本身就是幂等 upsert——正是事件
 *    消费方 inbox 该做的事。日后真要接事件推送，只需把「谁来触发 apply」从定时器换成消费者，
 *    投影表结构、守卫 SQL、fail-closed 语义都不用动。
 *
 * ## 陈旧窗口的上界与 fail-closed
 *
 * - 上界 = `maxStalenessMs`（默认 5 分钟）。它不是「刷新周期」，而是**硬截止**：每次成功刷新把
 *   `fresh_until` 推到 `now() + maxStalenessMs`；只要刷新连续失败到超过这个窗口，全部守卫立刻转为拒绝。
 *   正常态的实际陈旧度是刷新周期（默认 30 秒）。
 * - 守卫的 SQL 一律附带 `fresh_until > now()`。三种坏情况都落在拒绝一侧：
 *   投影**缺行** → EXISTS 假 → 拒绝；投影**陈旧** → 新鲜期过期 → 拒绝；投影**从未刷过** →
 *   状态表无行 → 新鲜期判定为假 → 拒绝。**绝不因为投影没跟上就放行**。
 * - 唯一需要额外小心的是**反向极性**那一处（按 scope 撤销 assigned 成员行的 DELETE）：那里「投影查不到」
 *   意味着删除，直接加新鲜期谓词反而会在陈旧时**放行**。该处改为在语句之前先问新鲜期，不新鲜就
 *   既不删也不放行，返回具名的拒绝态。见 facebook-group-store.ts 的 `revalidateScopedAssignment`。
 *
 * ## 只增不删
 *
 * 全仓零 `DELETE FROM accounts`、账号存储不暴露任何删除口 ⇒ 账号从不物理删除。因此刷新只做
 * 「新增 + 字段更新」，**MUST NOT 按快照做差集删除**。这条不只是省事：它同时挡住了「某次快照因为
 * 连错库 / 查询出错返回空集，于是把整张投影清空」这类会把全域守卫一次性打成拒绝的事故。
 * 同理，空花名册**不推进新鲜期**——「一个账号都没有」在本系统里从来不是稳态，把它当成一次成功刷新
 * 等于让一次静默的读失败冒充新鲜。
 */

import type pg from 'pg';
import type { DeploymentTarget } from '../deployment-target.js';
import type {
  AccountIdentityProjectionRow,
  AccountRosterSourcePort,
} from '../kernel/account-projection-types.js';
import {
  isSyncReadFactPayload,
  type AutomationAccountProjectionSnapshot,
} from '../kernel/sync-read-facts.js';
import {
  compareUnsignedSyncReadCursor,
  parseSyncReadSnapshotEnvelope,
  syncReadPayloadDigest,
  type SyncReadApplyResult,
} from '../kernel/sync-read-snapshot.js';
import {
  SchemaCapabilityError,
  classifySchemaCapability,
} from '../kernel/schema-capability-contract.js';
import { probeSchemaShape } from '../schema/schema-capability.js';

/** 投影表名。守卫 SQL 里刻意写字面量而不是插值这个常量——插值会让归属门禁扫不到表名。 */
export const ACCOUNT_PROJECTION_TABLE = 'automation_account_projection';
/** 投影新鲜期状态表名（单行）。 */
export const ACCOUNT_PROJECTION_STATE_TABLE = 'automation_account_projection_state';

/** 提供这两张表的迁移版本 id（探不到时要能回答「补跑哪一条」）。 */
export const ACCOUNT_PROJECTION_SINCE_VERSION = '0084_automation_account_projection_sync_read';
export const ACCOUNT_PROJECTION_SYNC_READ_SINCE_VERSION =
  '0087_automation_account_projection_shared_cursor';

/** 默认刷新周期：正常态的实际陈旧度。 */
export const DEFAULT_ACCOUNT_PROJECTION_REFRESH_MS = 30_000;
/** 默认陈旧硬截止：超过它，全部守卫 fail-closed。 */
export const DEFAULT_ACCOUNT_PROJECTION_MAX_STALE_MS = 5 * 60_000;

export type AccountProjectionRefreshResult =
  | { ok: true; rows: number }
  | { ok: false; reason: 'empty_roster' | 'source_failed' | 'apply_failed'; message?: string };

export interface AccountProjectionStoreOptions {
  pool: pg.Pool;
  /** 账号花名册来源（api 属主域实现）。MUST NOT 换成把 api 的连接池递进来。 */
  source: AccountRosterSourcePort;
  /** 独立 automation 进程应用 B4 snapshot 时必填；monolith legacy refresh 不读取它。 */
  executionTarget?: DeploymentTarget;
  refreshIntervalMs?: number;
  maxStalenessMs?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** 注入定时器（测试用）。 */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * 守卫 SQL 用的新鲜期谓词。别名 `apj_state` 刻意取得难撞——消费方的查询里 `a` / `s` / `t` / `m`
 * 都已被占用。
 */
export const ACCOUNT_PROJECTION_FRESH_SQL =
  `EXISTS (SELECT 1 FROM automation_account_projection_state apj_state WHERE apj_state.fresh_until > now())`;

export function accountProjectionTargetFreshSql(
  executionTargetParameter: string,
): string {
  if (!/^\$[1-9][0-9]*$/.test(executionTargetParameter)) {
    throw new Error('account_projection_target_parameter_invalid');
  }
  return `EXISTS (
    SELECT 1
      FROM automation_sync_read_consumer_checkpoint apj_checkpoint
     WHERE apj_checkpoint.execution_target = ${executionTargetParameter}
       AND apj_checkpoint.consumer = 'automation'
       AND apj_checkpoint.stream = 'automation_account_projection'
       AND apj_checkpoint.state = 'ready'
       AND apj_checkpoint.fresh_until_ms > floor(extract(epoch FROM now()) * 1000)
  )`;
}

export class PgAccountProjectionStore {
  private readonly pool: pg.Pool;
  private readonly source: AccountRosterSourcePort;
  private readonly executionTarget: DeploymentTarget | null;
  private readonly refreshIntervalMs: number;
  private readonly maxStalenessMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private running = false;
  private refreshing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AccountProjectionStoreOptions) {
    this.pool = options.pool;
    this.source = options.source;
    this.executionTarget = options.executionTarget ?? null;
    this.refreshIntervalMs = Math.max(1_000, Math.trunc(options.refreshIntervalMs ?? DEFAULT_ACCOUNT_PROJECTION_REFRESH_MS));
    this.maxStalenessMs = Math.max(
      this.refreshIntervalMs,
      Math.trunc(options.maxStalenessMs ?? DEFAULT_ACCOUNT_PROJECTION_MAX_STALE_MS),
    );
    this.logger = options.logger ?? console;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  /**
   * schema 探测（只探不建，照 §5.x 的存储纪律）。探不到即带 version id 报错并 fail-closed：
   * 调用方接住这条错误后 MUST NOT 继续把守卫当成通过——投影不在，守卫的 SQL 本身也会失败，
   * 这正是我们要的方向。
   */
  async init(): Promise<void> {
    const tables = [
      ACCOUNT_PROJECTION_TABLE,
      ACCOUNT_PROJECTION_STATE_TABLE,
      ...(this.executionTarget
        ? ['automation_sync_read_consumer_checkpoint']
        : []),
    ];
    const shape = await probeSchemaShape(this.pool, tables);
    const stateColumns = [
      'singleton',
      'refreshed_at',
      'fresh_until',
      'source_rows',
      ...(this.executionTarget
        ? [
            'sync_read_cursor',
            'sync_read_payload_digest',
            'sync_read_source_as_of_ms',
          ]
        : []),
    ];
    const verdict = classifySchemaCapability(
      {
        tables: new Map([
          [ACCOUNT_PROJECTION_TABLE, new Set([
            'account_id',
            'platform',
            'group_label',
            'created_at',
            'status',
            'projected_at',
          ])],
          [ACCOUNT_PROJECTION_STATE_TABLE, new Set(stateColumns)],
          ...(this.executionTarget
            ? [[
                'automation_sync_read_consumer_checkpoint',
                new Set([
                  'execution_target',
                  'consumer',
                  'stream',
                  'applied_cursor',
                  'payload_digest',
                  'source_as_of_ms',
                  'last_observed_at_ms',
                  'fresh_until_ms',
                  'last_applied_at_ms',
                  'state',
                  'last_error',
                  'updated_at',
                ]),
              ] as const]
            : []),
        ]),
        indexes: new Map([
          ['idx_automation_account_projection_platform_label', ACCOUNT_PROJECTION_TABLE],
        ]),
      },
      shape,
    );
    if (verdict.status !== 'ready') {
      throw new SchemaCapabilityError(
        {
          capability: 'automation_account_projection',
          sinceVersion: this.executionTarget
            ? ACCOUNT_PROJECTION_SYNC_READ_SINCE_VERSION
            : ACCOUNT_PROJECTION_SINCE_VERSION,
          // 建表语句的唯一所有者是 migrations/；本存储只探测，故这里刻意为空。
          ddl: [],
        },
        verdict,
      );
    }
  }

  /** 当前投影是否仍在新鲜期内。任何读失败一律按「不新鲜」处理（fail-closed）。 */
  async isFresh(): Promise<boolean> {
    try {
      if (this.executionTarget) {
        const { rows } = await this.pool.query<{ fresh: boolean }>(
          `SELECT ${accountProjectionTargetFreshSql('$1')} AS fresh`,
          [this.executionTarget],
        );
        return rows[0]?.fresh === true;
      }
      const { rows } = await this.pool.query<{ fresh: boolean }>(
        `SELECT (fresh_until > now()) AS fresh FROM automation_account_projection_state`,
      );
      return rows[0]?.fresh === true;
    } catch (err: unknown) {
      this.logger.warn(
        `[account-projection] 新鲜期读取失败，按不新鲜处理（守卫 fail-closed）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  /**
   * 拉一次全量快照并应用。幂等：同一份快照重复应用结果相同（正是事件消费方 inbox 该有的性质）。
   *
   * 三条不变量：
   * - **只增不删**（账号从不物理删除；也顺带挡住「空快照清空投影」这类事故）；
   * - **空花名册不推进新鲜期**（不让一次静默的读失败冒充新鲜）；
   * - 投影行与新鲜期**同事务**推进（不会出现「新鲜期推了、行没落」的裂缝）。
   */
  async refresh(): Promise<AccountProjectionRefreshResult> {
    let roster: readonly AccountIdentityProjectionRow[];
    try {
      roster = await this.source.listAccountIdentities();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[account-projection] 花名册来源读取失败（新鲜期不推进，到期后守卫 fail-closed）: ${message}`);
      return { ok: false, reason: 'source_failed', message };
    }
    if (roster.length === 0) {
      this.logger.warn(
        '[account-projection] 花名册来源返回 0 个账号：**不**推进新鲜期。'
        + '「一个账号都没有」在本系统里不是稳态，把它当成功刷新等于让静默的读失败冒充新鲜。',
      );
      return { ok: false, reason: 'empty_roster' };
    }

    const accountIds = roster.map((row) => row.accountId);
    const platforms = roster.map((row) => row.platform);
    const groupLabels = roster.map((row) => row.groupLabel);
    const createdAts = roster.map((row) =>
      row.createdAt === null ? null : new Date(row.createdAt));
    const statuses = roster.map((row) => row.status);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO automation_account_projection
           (account_id, platform, group_label, created_at, status, projected_at)
         SELECT t.account_id, t.platform, t.group_label, t.created_at, t.status, now()
           FROM unnest(
             $1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::text[]
           ) AS t(account_id, platform, group_label, created_at, status)
         ON CONFLICT (account_id) DO UPDATE
           SET platform = EXCLUDED.platform,
               group_label = EXCLUDED.group_label,
               created_at = EXCLUDED.created_at,
               status = EXCLUDED.status,
               projected_at = EXCLUDED.projected_at`,
        [accountIds, platforms, groupLabels, createdAts, statuses],
      );
      await client.query(
        `INSERT INTO automation_account_projection_state (singleton, refreshed_at, fresh_until, source_rows)
         VALUES (true, now(), now() + ($1::double precision * interval '1 millisecond'), $2)
         ON CONFLICT (singleton) DO UPDATE
           SET refreshed_at = EXCLUDED.refreshed_at,
               fresh_until  = EXCLUDED.fresh_until,
               source_rows  = EXCLUDED.source_rows`,
        [this.maxStalenessMs, roster.length],
      );
      await client.query('COMMIT');
      return { ok: true, rows: roster.length };
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[account-projection] 投影写入失败（新鲜期不推进，到期后守卫 fail-closed）: ${message}`);
      return { ok: false, reason: 'apply_failed', message };
    } finally {
      client.release();
    }
  }

  /**
   * Apply the B4 owner snapshot and its automation consumer checkpoint in one
   * automation-DB transaction. Independent mode uses this path exclusively;
   * it MUST NOT also start the legacy AccountRosterSourcePort refresher.
   */
  async applyOwnerSnapshot(
    input: unknown,
    observedAt = Date.now(),
  ): Promise<SyncReadApplyResult> {
    if (!this.executionTarget) {
      return {
        outcome: 'rejected',
        reason: 'invalid_envelope',
        currentCursor: null,
        message: 'account_projection_execution_target_not_configured',
      };
    }
    let envelope;
    try {
      envelope = parseSyncReadSnapshotEnvelope<AutomationAccountProjectionSnapshot>(
        input,
        {
          executionTarget: this.executionTarget,
          stream: 'automation_account_projection',
          factScope: 'shared',
          validateValue: (value): value is AutomationAccountProjectionSnapshot =>
            isSyncReadFactPayload('automation_account_projection', value),
        },
      );
    } catch (error) {
      return {
        outcome: 'rejected',
        reason: 'invalid_envelope',
        currentCursor: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const digest = syncReadPayloadDigest(envelope.value);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The projection payload is shared by dev/ol even though delivery
      // checkpoints are target-scoped. Materialize and row-lock the existing
      // shared projection-state singleton before consulting the global maximum
      // cursor; otherwise ol cursor 4 could overwrite dev cursor 5.
      await client.query(
        `INSERT INTO automation_account_projection_state (
           singleton, refreshed_at, fresh_until, source_rows
         )
         VALUES (true, to_timestamp(0), to_timestamp(0), 0)
         ON CONFLICT (singleton) DO NOTHING`,
      );
      const shared = await client.query<{
        sync_read_cursor: string | number | null;
        sync_read_payload_digest: string | null;
        sync_read_source_as_of_ms: string | number | null;
      }>(
        `SELECT singleton
                , sync_read_cursor
                , sync_read_payload_digest
                , sync_read_source_as_of_ms
           FROM automation_account_projection_state
          WHERE singleton = true
          FOR UPDATE`,
      );
      // Locking a missing checkpoint row locks nothing. Materialize this
      // target's delivery row before locking all B4 checkpoints.
      await client.query(
        `INSERT INTO automation_sync_read_consumer_checkpoint (
           execution_target, consumer, stream, state
         )
         VALUES (
           $1, 'automation', 'automation_account_projection', 'uninitialized'
         )
         ON CONFLICT (execution_target, consumer, stream) DO NOTHING`,
        [this.executionTarget],
      );
      const { rows } = await client.query<{
        applied_cursor: string | number | null;
        payload_digest: string | null;
        source_as_of_ms: string | number | null;
        last_applied_at_ms: string | number | null;
      }>(
        `SELECT applied_cursor, payload_digest, source_as_of_ms,
                last_applied_at_ms
           FROM automation_sync_read_consumer_checkpoint
          WHERE execution_target = $1
            AND consumer = 'automation'
            AND stream = 'automation_account_projection'
          FOR UPDATE`,
        [this.executionTarget],
      );
      const globalCurrent = shared.rows[0];
      const targetCurrent = rows[0];
      const globalCursor =
        globalCurrent?.sync_read_cursor === null ||
        globalCurrent?.sync_read_cursor === undefined
          ? null
          : String(globalCurrent.sync_read_cursor);
      const targetCursor =
        targetCurrent?.applied_cursor === null ||
        targetCurrent?.applied_cursor === undefined
          ? null
          : String(targetCurrent.applied_cursor);
      let outcome: 'applied' | 'freshness_renewed' = 'applied';
      if (globalCursor !== null) {
        const comparison = compareUnsignedSyncReadCursor(
          envelope.cursor,
          globalCursor,
        );
        if (comparison < 0) {
          await client.query('ROLLBACK');
          return {
            outcome: 'rejected',
            reason: 'old_cursor',
            currentCursor: globalCursor,
            message: `out_of_order cursor=${envelope.cursor} current=${globalCursor}`,
          };
        }
        if (
          comparison === 0 &&
          globalCurrent?.sync_read_payload_digest !== digest
        ) {
          await client.query('ROLLBACK');
          return {
            outcome: 'rejected',
            reason: 'same_cursor_payload_drift',
            currentCursor: globalCursor,
            message: `same cursor ${envelope.cursor} carried a different payload digest`,
          };
        }
      }
      if (targetCursor !== null) {
        const targetComparison = compareUnsignedSyncReadCursor(
          envelope.cursor,
          targetCursor,
        );
        if (
          targetComparison === 0 &&
          envelope.asOf <= Number(targetCurrent?.source_as_of_ms)
        ) {
          await client.query('ROLLBACK');
          return {
            outcome: 'already_applied',
            cursor: envelope.cursor,
            payloadDigest: digest,
          };
        }
        if (targetComparison === 0) outcome = 'freshness_renewed';
      }

      await replaceProjectionRows(
        client,
        envelope.value.accounts,
      );
      await client.query(
        `UPDATE automation_account_projection_state
            SET sync_read_cursor = $1::numeric,
                sync_read_payload_digest = $2,
                sync_read_source_as_of_ms = GREATEST(
                  COALESCE(sync_read_source_as_of_ms, 0),
                  $3::bigint
                )
          WHERE singleton = true`,
        [envelope.cursor, digest, envelope.asOf],
      );
      const priorAppliedAt = Number(targetCurrent?.last_applied_at_ms);
      const lastAppliedAt =
        outcome === 'freshness_renewed' &&
        Number.isSafeInteger(priorAppliedAt) &&
        priorAppliedAt >= 0
          ? priorAppliedAt
          : observedAt;
      const checkpointWrite = await client.query(
        `UPDATE automation_sync_read_consumer_checkpoint
            SET applied_cursor = $2::numeric,
                payload_digest = $3,
                source_as_of_ms = $4,
                last_observed_at_ms = $5,
                fresh_until_ms = $6,
                last_applied_at_ms = $7,
                state = $8,
                last_error = NULL,
                updated_at = now()
          WHERE execution_target = $1
            AND consumer = 'automation'
            AND stream = 'automation_account_projection'`,
        [
          this.executionTarget,
          envelope.cursor,
          digest,
          envelope.asOf,
          observedAt,
          envelope.freshUntil,
          lastAppliedAt,
          envelope.freshUntil > observedAt ? 'ready' : 'stale',
        ],
      );
      if (
        checkpointWrite.rowCount !== undefined &&
        checkpointWrite.rowCount !== null &&
        checkpointWrite.rowCount !== 1
      ) {
        throw new Error('automation_account_projection_checkpoint_update_failed');
      }
      await client.query('COMMIT');
      return { outcome, cursor: envelope.cursor, payloadDigest: digest };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 启动周期刷新。幂等；`start()` 自身不 await 首刷，首刷由调用方在 init 之后显式 await。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, this.refreshIntervalMs);
  }

  private async tick(): Promise<void> {
    if (this.refreshing) {
      this.scheduleNext();
      return;
    }
    this.refreshing = true;
    try {
      await this.refresh();
    } finally {
      this.refreshing = false;
    }
    this.scheduleNext();
  }
}

async function replaceProjectionRows(
  client: pg.PoolClient,
  roster: readonly AccountIdentityProjectionRow[],
): Promise<void> {
  await client.query(
    `INSERT INTO automation_account_projection
       (account_id, platform, group_label, created_at, status, projected_at)
     SELECT t.account_id, t.platform, t.group_label, t.created_at, t.status, now()
       FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::text[]
       ) AS t(account_id, platform, group_label, created_at, status)
     ON CONFLICT (account_id) DO UPDATE
       SET platform = EXCLUDED.platform,
           group_label = EXCLUDED.group_label,
           created_at = EXCLUDED.created_at,
           status = EXCLUDED.status,
           projected_at = EXCLUDED.projected_at`,
    [
      roster.map((row) => row.accountId),
      roster.map((row) => row.platform),
      roster.map((row) => row.groupLabel),
      roster.map((row) =>
        row.createdAt === null ? null : new Date(row.createdAt)),
      roster.map((row) => row.status),
    ],
  );
  // B4 is a validated complete snapshot. Unlike the legacy defensive poller,
  // absence is authoritative here: remove projection rows that no longer
  // exist at the API owner. Empty is valid and clears the projection.
  await client.query(
    `DELETE FROM automation_account_projection
      WHERE NOT (account_id = ANY($1::text[]))`,
    [roster.map((row) => row.accountId)],
  );
}
