/**
 * 托管自动化 typed stores 的共享基座（期1-2）。
 *
 * 模式沿用 src/orchestrator/facebook-rule-mode-runtime-store.ts（DDL 冻结后的新 store 形态）：
 *   - 不携带任何 DDL；表由 migrations/0106–0109 唯一创建；
 *   - init() 用**注入的** SchemaProber 探测精确形状，不 ready 即抛 SchemaCapabilityError
 *     （fail-closed，错误里带该补哪条迁移）；
 *   - 只从 kernel 取类型与纯判定，不 import 业务模块。
 *
 * 与该先例的一个刻意差异：executionTarget **不**绑在构造器上，而是每个方法显式收参
 * （任务要求「所有接口显式收 executionTarget 并过滤」），杜绝「拿错实例写错 target」。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../../kernel/pg-config.js';
import {
  SchemaCapabilityError,
  classifySchemaCapability,
  type SchemaProber,
} from '../../kernel/schema-capability-contract.js';

const { Pool } = pg;

export interface ManagedAutomationStoreOptions {
  pool?: pg.Pool;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  schemaProber: SchemaProber;
}

/** 每个 store 声明自己那批表/索引的精确要求（探测失败时能回答「补跑哪条迁移」）。 */
export interface ManagedSchemaRequirement {
  capability: string;
  sinceVersion: string;
  tables: Map<string, Set<string>>;
  indexes: Map<string, string>;
}

/**
 * store 层不变式违规（如 waitReason 非空但 status≠'waiting'）。
 * 先于 SQL 抛出——绝不把非法状态送进库里再靠 23514 弹回来；库侧 CHECK 只是兜底。
 */
export class ManagedAutomationInvariantError extends Error {
  readonly code = 'managed_automation_invariant_violation';

  constructor(detail: string) {
    super(`managed_automation_invariant_violation: ${detail}`);
    this.name = 'ManagedAutomationInvariantError';
  }
}

export abstract class ManagedAutomationStoreBase {
  protected readonly pool: pg.Pool;
  private readonly schemaProber: SchemaProber;
  private readonly requirement: ManagedSchemaRequirement;
  private readonly ownedPool?: pg.Pool;

  constructor(requirement: ManagedSchemaRequirement, options: ManagedAutomationStoreOptions) {
    this.requirement = requirement;
    this.schemaProber = options.schemaProber;
    let pool = options.pool;
    if (!pool) {
      pool = new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
      this.ownedPool = pool;
    }
    this.pool = pool;
  }

  async init(): Promise<void> {
    const shape = await this.schemaProber(this.pool, [...this.requirement.tables.keys()]);
    const verdict = classifySchemaCapability(
      { tables: this.requirement.tables, indexes: this.requirement.indexes },
      shape,
    );
    if (verdict.status !== 'ready') {
      throw new SchemaCapabilityError(
        {
          capability: this.requirement.capability,
          sinceVersion: this.requirement.sinceVersion,
          ddl: [],
        },
        verdict,
      );
    }
  }

  async close(): Promise<void> {
    if (this.ownedPool) await this.ownedPool.end();
  }
}

export function toEpochMillis(value: Date | string): number {
  return new Date(value).getTime();
}

export function toNullableEpochMillis(value: Date | string | null): number | null {
  return value === null ? null : new Date(value).getTime();
}
