/**
 * 单条迁移的施加动作（change restore-derived-migration-executability 任务 3.2）。
 *
 * 为什么单独成文件而不留在 `scripts/migrate.ts` 里：本机制最危险的两种失败都发生在这一小段
 * 十几行的代码里，而 CLI 脚本在模块层就 `main()`，**根本没法脱库单测**：
 *
 *   - **执行范围外却发了 SQL** —— 在一个没有那张表的库里跑 DDL，`relation … does not exist`，
 *     整批停。这正是本 change 要消灭的原缺陷。
 *   - **执行了却没记账** / **记账了却没执行但没留痕** —— 账本、契约门、状态三处都显示「已处置」，
 *     而库里少了对象。那是本仓第一红线禁止的静默假成功。
 *
 * 本文件不 import pg：客户端按最小接口注入，测试可以塞一个只记录调用的桩。
 * 三仓同源（并入共享包 `aidcp-transport`），零属主表 SQL —— 唯一写的表是每个库都有的账本表。
 */

import type { PlannedMigration } from './migration-plan.js';

/** 施加动作要用的最小客户端能力（`pg.Client` 天然满足）。 */
export interface MigrationApplyClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface MigrationApplyOptions {
  /**
   * 本库不在这条迁移的执行范围内 ⇒ **只写账本行、一条语句都不发**。
   *
   * MUST NOT 退化成「先跑一下、失败就跳过」：那既是静默假成功，也会把真实的 schema 缺失
   * 一起吞掉（任何一条 `relation does not exist` 都会被当成「本来就不该跑」）。
   */
  recordOnly: boolean;
  appliedBy: string;
  appliedFromTarget: string;
  /** 注入时钟只为测试可复现；生产不传 */
  now?: () => number;
}

export interface MigrationApplyReceipt {
  version: string;
  /** SQL 是否真的发出去了。`false` = 记账不执行 */
  executed: boolean;
  durationMs: number;
}

/**
 * `applied_by` 上的施加形态标记。账本表没有「是否执行」这一列，而加列要动 schema——
 * 本机制刻意做到零 DDL，故沿用既有的 `--allow-contract` 那条写法把形态记在这一列里，
 * 让账本自己就能回答「这一行是跑出来的还是记出来的」。
 */
export function applyMarker(migration: PlannedMigration, recordOnly: boolean, by: string): string {
  if (recordOnly) return `${by} (record-only)`;
  return migration.kind === 'contract' ? `${by} (--allow-contract)` : by;
}

/**
 * 施加一条迁移：单事务内 [执行 SQL] + 写账本行。失败即回滚并把原始错误抛给调用方
 * （调用方负责「停止整批、已成功的保留在账本里」这条整批语义）。
 */
export async function applyMigration(
  client: MigrationApplyClient,
  migration: PlannedMigration,
  options: MigrationApplyOptions,
): Promise<MigrationApplyReceipt> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  try {
    await client.query('BEGIN');
    if (!options.recordOnly) await client.query(migration.content);
    await client.query(
      `INSERT INTO schema_migrations (version, name, checksum, kind, applied_by, applied_from_target, duration_ms, baseline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
      [
        migration.version,
        migration.name,
        migration.checksum,
        migration.kind,
        applyMarker(migration, options.recordOnly, options.appliedBy),
        options.appliedFromTarget,
        now() - startedAt,
      ],
    );
    await client.query('COMMIT');
    return { version: migration.version, executed: !options.recordOnly, durationMs: now() - startedAt };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
