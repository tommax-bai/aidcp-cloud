/**
 * 存储能力探测的**纯契约段**（无 SQL、无 IO、可脱库单测）。
 *
 * 由 `src/schema/schema-capability.ts` 析出：那份文件把「三态判定 / 错误形状 / 回滚旋钮」这类
 * 纯契约与「连库探测 / 建表执行」这类 automation 行为混在一处，导致 api / content 两层的一堆存储
 * 只为拿判定契约就得跨边界导入 automation。本文件承载可进 kernel 的那一半（§4.7 kernel 准入：
 * 无 SQL 字面量 / 无 HTTP 路由 / 无 LLM 或供应商调用 / 无进程内活状态 / 不反向依赖业务层），
 * 连库的探测执行段（probeSchemaShape / ensureCapabilitySchema）留在 automation。
 *
 * 三态（与 interactions 那份同构）：
 *   ready    要求的表、列、索引都在 → 正常工作；
 *   degraded 表在、但缺列或缺索引  → 报 `schema_incomplete_*`，能力 fail-closed；
 *   missing  要求的表不在          → 报 `schema_missing_*`，能力 fail-closed。
 *
 * 为什么 degraded 也抛：缺列时存储的读写迟早会抛一条**原始 PG 错误**，那条错误既不带 version id、
 * 也不说该补哪条迁移。在 init 处一次性把话说清楚，比在业务路径上炸更有用。
 */

export type SchemaCapabilityStatus = 'ready' | 'degraded' | 'missing';

/**
 * 最小查询接口（生产传 pg.Pool / pg.Client，测试传桩）。
 *
 * 单一定义处：连库探测执行段（`src/schema/pg-catalog.ts` / `schema-capability.ts`）从本文件
 * 复用此形状。它是纯结构化契约（无 SQL、无活状态），随 `SchemaEnsurer` 端口一并进 kernel，
 * 让只需注入 schema 保障能力的存储从 kernel 取类型、靠注入拿函数，不再跨边界导入 automation。
 */
export interface SchemaQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * 存储 `init()` 期「探测 schema、不 ready 就 fail-closed」这一步的**注入端口**。
 *
 * 唯一实现是 automation 层 `src/schema/schema-capability.ts` 的 `ensureCapabilitySchema`（内部走
 * information_schema/pg_catalog 探测，含 SQL，MUST NOT 进 kernel）。存储 Options 声明本类型（必填），
 * 由组合根 `src/server.ts` 在构造点注入那一个同款函数、同一 pool、同一 spec、同一 init() 时机；
 * 运行时行为与直接 import 调用一字不变。存储因此只从 kernel 取**类型**，消除对 automation 的 import 边。
 */
export type SchemaEnsurer = (
  client: SchemaQueryable,
  spec: SchemaCapabilitySpec,
) => Promise<SchemaCapabilityStatus>;

/**
 * 连库读实测形状那一步的**注入端口**（change cloud-coupling-phase4-runtime-ports）。
 * 唯一实现是 automation 的 `probeSchemaShape`（含 SQL，MUST NOT 进 kernel）。它另有第三个
 * `schema = runtimeSchemaName()` 默认参——端口刻意只暴露两参，调用方一律走运行时默认 schema。
 */
export type SchemaProber = (client: SchemaQueryable, tables: string[]) => Promise<SchemaShape>;

export interface SchemaShape {
  /** 库里实际存在的表名 */
  tables: Set<string>;
  /** 库里实际存在的列，`表名.列名` */
  columns: Set<string>;
  /** 库里实际存在的索引名 */
  indexes: Set<string>;
}

export interface SchemaCapabilityVerdict {
  status: SchemaCapabilityStatus;
  missingTables: string[];
  missingColumns: string[];
  missingIndexes: string[];
}

export interface SchemaCapabilitySpec {
  /** 能力名，进错误码与日志，如 `model_config` */
  capability: string;
  /** 提供这些对象的迁移版本 id（缺对象时要能回答「补跑哪一条」） */
  sinceVersion: string;
  /** 该存储原本会自建的 DDL 段（要求的来源；旋钮打开时也是被执行的那几段） */
  ddl: string[];
  /**
   * migrations-only 新对象的显式能力要求。运行时 DDL 棘轮禁止为了新 schema 继续扩张
   * `src/` 下的自建语句；新对象在 migrations/ 创建，并在这里声明探测所需的表/列。
   */
  requiredObjects?: {
    tables?: Record<string, readonly string[]>;
    indexes?: Record<string, string>;
  };
}

/** 纯判定：给定「要求」与「实测」，返回三态与缺失清单。不连库、可脱库单测。 */
export function classifySchemaCapability(
  required: { tables: Map<string, Set<string>>; indexes: Map<string, string> },
  actual: SchemaShape,
): SchemaCapabilityVerdict {
  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  const missingIndexes: string[] = [];

  for (const [table, columns] of [...required.tables].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!actual.tables.has(table)) {
      missingTables.push(table);
      continue; // 表都不在，逐列再报一遍只是刷屏
    }
    for (const column of [...columns].sort()) {
      if (!actual.columns.has(`${table}.${column}`)) missingColumns.push(`${table}.${column}`);
    }
  }
  for (const [index, table] of [...required.indexes].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (missingTables.includes(table)) continue;
    if (!actual.indexes.has(index)) missingIndexes.push(index);
  }

  const status: SchemaCapabilityStatus = missingTables.length > 0
    ? 'missing'
    : missingColumns.length > 0 || missingIndexes.length > 0
      ? 'degraded'
      : 'ready';
  return { status, missingTables, missingColumns, missingIndexes };
}

export class SchemaCapabilityError extends Error {
  readonly code: string;
  readonly capability: string;
  readonly status: SchemaCapabilityStatus;
  readonly sinceVersion: string;
  readonly missing: string[];

  constructor(spec: SchemaCapabilitySpec, verdict: SchemaCapabilityVerdict) {
    const missing = [...verdict.missingTables, ...verdict.missingColumns, ...verdict.missingIndexes];
    const prefix = verdict.status === 'missing' ? 'schema_missing' : 'schema_incomplete';
    const code = `${prefix}_${spec.capability}_run_${spec.sinceVersion}`;
    super(
      `${code}：缺 ${missing.length} 个对象（${missing.join(', ')}）。`
      + `补跑迁移 npm run migrate up 后重启；本进程 MUST NOT 自建这些对象。`,
    );
    this.name = 'SchemaCapabilityError';
    this.code = code;
    this.capability = spec.capability;
    this.status = verdict.status;
    this.sinceVersion = spec.sinceVersion;
    this.missing = missing;
  }
}

export function isSchemaCapabilityError(err: unknown): err is SchemaCapabilityError {
  return err instanceof SchemaCapabilityError;
}

/** 过渡期回滚旋钮。默认 false —— 只有显式设成 true 才恢复自建。函数体内读 env，非模块级活状态。 */
export function schemaSelfCreateEnabled(): boolean {
  return (process.env.AIDCP_SCHEMA_SELF_CREATE ?? '').trim().toLowerCase() === 'true';
}
