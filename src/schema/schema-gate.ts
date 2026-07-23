/**
 * 启动期 schema 契约门的运行时接线（change cloud-schema-migration-executor 任务 6.2–6.5）。
 *
 * 该门 MUST 跑在任何存储 init() 之前，MUST NOT 被 try/catch 吞掉。
 * 读账本本身失败（账本表不存在或连不上库）同样判为不通过 —— 理由是无法证明 schema 正确，
 * 这是 fail-closed，不是可用性折衷。
 *
 * 模式（env AIDCP_SCHEMA_GATE）：
 *   warn（默认）  判定照做、结论照打，允许继续启动；
 *   enforce      判定不通过即抛错，进程退出。
 * 两种模式的结论文本与版本清单逐字一致，warn 模式 MUST NOT 只打一句模糊提示。
 */

import pg from 'pg';

import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import { loadMigrationFiles } from './migration-files.js';
import { versionOf } from './migration-plan.js';
import {
  KNOWN_MAX_SCHEMA_VERSION,
  REQUIRED_SCHEMA_VERSION,
  evaluateSchemaGate,
  formatGateConclusion,
  parseSchemaGateMode,
  type SchemaGateDecision,
  type SchemaGateMode,
} from './schema-contract.js';

const { Client } = pg;

const UNDEFINED_TABLE = '42P01';

export interface LedgerQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface SchemaGateResult {
  decision: SchemaGateDecision;
  mode: SchemaGateMode;
  conclusion: string;
}

/** 放行生效时的告警载荷；启动期 alertStore 尚未构造，故先缓存、由 server 在 alertStore 就绪后 flush。 */
export interface SchemaGateWaiverAlert {
  title: string;
  detail: string;
}

let pendingWaiverAlert: SchemaGateWaiverAlert | undefined;

export function takePendingSchemaGateAlert(): SchemaGateWaiverAlert | undefined {
  const alert = pendingWaiverAlert;
  pendingWaiverAlert = undefined;
  return alert;
}

function readEnvString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

function readEnvPort(): number {
  const value = readEnvString('PGPORT');
  if (!value) return DEFAULT_PG_CONFIG.port;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PG_CONFIG.port;
}

async function readLedgerVersions(
  client: LedgerQueryable,
): Promise<{ versions: string[]; error?: string }> {
  try {
    const res = await client.query('SELECT version FROM schema_migrations');
    return { versions: res.rows.map((r) => String(r.version)) };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === UNDEFINED_TABLE) return { versions: [], error: '账本表 schema_migrations 不存在' };
    return { versions: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** 本构建认识的版本清单。读不到 migrations/ 时退化为只认 KNOWN_MAX（清单会不全，但结论方向不变）。 */
async function knownVersions(): Promise<string[]> {
  try {
    const files = await loadMigrationFiles();
    return files.map((f) => versionOf(f.name));
  } catch {
    return [KNOWN_MAX_SCHEMA_VERSION];
  }
}

/**
 * 用已有连接跑一次判定（不负责建连、不负责退出）。测试直接注入桩即可断言
 * 「本次判定除了读账本没有执行任何别的语句」。
 */
export async function evaluateSchemaGateWithLedger(
  client: LedgerQueryable,
  overrides?: { required?: string; knownMax?: string; allowAheadRaw?: string; known?: string[] },
): Promise<SchemaGateDecision> {
  const ledger = await readLedgerVersions(client);
  const known = overrides?.known ?? (await knownVersions());
  return evaluateSchemaGate({
    ledgerVersions: ledger.versions,
    ledgerError: ledger.error,
    knownVersions: known,
    required: overrides?.required ?? REQUIRED_SCHEMA_VERSION,
    knownMax: overrides?.knownMax ?? KNOWN_MAX_SCHEMA_VERSION,
    allowAheadRaw: overrides?.allowAheadRaw ?? readEnvString('AIDCP_ALLOW_SCHEMA_AHEAD'),
  });
}

/**
 * 启动期入口：自建一次性连接读账本，打结论，enforce 模式下不通过即抛。
 * 调用点 MUST NOT 包 try/catch。
 */
export async function runSchemaContractGate(options?: {
  client?: LedgerQueryable;
  mode?: SchemaGateMode;
}): Promise<SchemaGateResult> {
  const mode = options?.mode ?? parseSchemaGateMode(readEnvString('AIDCP_SCHEMA_GATE'));
  let client = options?.client;
  let ownClient: pg.Client | undefined;
  if (!client) {
    const connectionString = readEnvString('DATABASE_URL');
    ownClient = new Client(
      connectionString
        ? { connectionString }
        : {
            host: readEnvString('PGHOST') ?? DEFAULT_PG_CONFIG.host,
            port: readEnvPort(),
            database: readEnvString('PGDATABASE') ?? DEFAULT_PG_CONFIG.database,
            user: readEnvString('PGUSER') ?? DEFAULT_PG_CONFIG.user,
            password: readEnvString('PGPASSWORD') ?? DEFAULT_PG_CONFIG.password,
          },
    );
    try {
      await ownClient.connect();
      client = ownClient as unknown as LedgerQueryable;
    } catch (err) {
      // 连不上库 = 无法证明 schema 正确，与「账本表不存在」走同一条 fail-closed 判定。
      client = {
        async query() {
          throw err;
        },
      };
    }
  }

  try {
    const decision = await evaluateSchemaGateWithLedger(client);
    const conclusion = formatGateConclusion(decision);
    const prefix = `[aidcp-cloud] schema 契约门（${mode}）`;
    if (decision.pass) {
      console.log(`${prefix} ${conclusion}`);
    } else if (mode === 'enforce') {
      console.error(`${prefix} 拒绝启动：${conclusion}`);
    } else {
      console.warn(`${prefix} 未通过（warn 模式暂不拒绝启动，enforce 下将拒绝）：${conclusion}`);
    }

    if (decision.waived && decision.waivedUpTo) {
      const operator = readEnvString('AIDCP_MIGRATE_BY') ?? readEnvString('USER') ?? 'unknown';
      const detail = `${conclusion}；放行者 applied_by=${operator}`;
      console.warn(`${prefix} 超前放行已生效：${detail}`);
      pendingWaiverAlert = { title: 'schema 契约门超前放行生效', detail };
    }

    if (!decision.pass && mode === 'enforce') {
      throw new Error(`${decision.code}: ${conclusion}`);
    }
    return { decision, mode, conclusion };
  } finally {
    if (ownClient) await ownClient.end().catch(() => undefined);
  }
}
