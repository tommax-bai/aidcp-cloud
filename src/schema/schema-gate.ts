/**
 * 启动期 schema 契约门的运行时接线（change cloud-schema-migration-executor 任务 6.2–6.5；
 * Block③ 物理拆库：改成**逐属主库各读各的账本**）。
 *
 * 该门 MUST 跑在任何存储 init() 之前，MUST NOT 被 try/catch 吞掉。
 * 读账本本身失败（账本表不存在或连不上库）同样判为不通过 —— 理由是无法证明 schema 正确，
 * 这是 fail-closed，不是可用性折衷。
 *
 * ## 为什么必须逐属主
 *
 * 组合根已经按属主建了三个池（api / automation / content），业务表随之分散到三个库。
 * 本门原来自建一条**与任何属主池都无关**的一次性连接（`DATABASE_URL` / `PGHOST…`），
 * 翻转之后它校验的是旧共享库的账本，而被校验的表根本不在那儿 —— enforce 模式下会得到一次
 * 「校验通过但其实什么都没校验到」的假绿。现在每个属主用 `resolveOwnerPgConfig(owner)`
 * 连自己的库、读自己的账本、按自己那批迁移判定。
 *
 * ## 今天（三个 owner URL 都未设）的等价性
 *
 * `resolveOwnerPgConfig` 三家逐字回落到同一份共享配置 ⇒ 三家落在**同一个连接目标**。
 * 本门按连接目标分组：同组只建一条连接、只读一次账本，再把同一批行喂给组内每个属主判定。
 * 因此今天仍然是「一条连接、一次 `SELECT version FROM schema_migrations`」，与改动前的库侧
 * 动作逐字节一致；变的只是判定跑三遍（纯内存）。
 *
 * ## 判定口径的收窄
 *
 * 每个属主用自己的版本集合（判据见 `migration-owners.ts`）收窄 required / knownMax，
 * 并把账本行裁剪成「属于本属主的」∪「本构建根本不认识的」。后半截 MUST 保留：
 * 账本里有、磁盘上没有的版本正是回滚场景的信号，按属主裁掉它就等于把 ahead 检测关掉。
 *
 * 模式（env AIDCP_SCHEMA_GATE）：
 *   warn（默认）  判定照做、结论照打，允许继续启动；
 *   enforce      任一属主判定不通过即抛错，进程退出。
 * 两种模式的结论文本与版本清单逐字一致，warn 模式 MUST NOT 只打一句模糊提示。
 */

import { createHash } from 'node:crypto';
import pg from 'pg';

import {
  PG_OWNERS,
  pgOwnerUrlEnvVar,
  resolveOwnerPgConfig,
  type PgOwner,
} from '../kernel/pg-owner-connection-resolver.js';
import { loadMigrationFiles } from './migration-files.js';
import {
  loadMigrationOwnerScopes,
  versionsForOwner,
  type MigrationOwnerIndex,
  type MigrationOwnerScopes,
} from './migration-owners.js';
import { versionOf } from './migration-plan.js';
import {
  KNOWN_MAX_SCHEMA_VERSION,
  REQUIRED_SCHEMA_VERSION,
  evaluateSchemaGate,
  formatGateConclusion,
  narrowSchemaContract,
  parseSchemaGateMode,
  type SchemaGateDecision,
  type SchemaGateMode,
} from './schema-contract.js';

const { Client } = pg;

const UNDEFINED_TABLE = '42P01';

export interface LedgerQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** 单个属主的判定结果。 */
export interface SchemaGateOwnerResult {
  owner: PgOwner;
  decision: SchemaGateDecision;
  conclusion: string;
}

export interface SchemaGateResult {
  /** 最严重的一条（PG_OWNERS 序里第一个不通过的属主；全通过时取第一个属主） */
  decision: SchemaGateDecision;
  mode: SchemaGateMode;
  /** 与 `decision` 对应的结论文本 */
  conclusion: string;
  /** 逐属主判定，PG_OWNERS 序 */
  owners: SchemaGateOwnerResult[];
  /** 全部属主都通过才为 true */
  pass: boolean;
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

/** 本构建认识的版本清单（全构建口径，供 `evaluateSchemaGateWithLedger` 的兼容入口用）。 */
async function knownVersions(): Promise<string[]> {
  const files = await loadMigrationFiles();
  return files.map((f) => versionOf(f.name));
}

/**
 * 用已有连接跑一次**全构建口径**判定（不负责建连、不负责退出、不做属主收窄）。
 * 测试直接注入桩即可断言「本次判定除了读账本没有执行任何别的语句」。
 *
 * 判据（迁移目录）读不出来时 MUST NOT 退化放行：旧实现在这里 `catch` 成「只认最高版本」，
 * 于是任何账本只要最高版本够高就通过 —— 那是一条假绿路径，现在改成显式的判据不可用失败。
 */
export async function evaluateSchemaGateWithLedger(
  client: LedgerQueryable,
  overrides?: { required?: string; knownMax?: string; allowAheadRaw?: string; known?: string[] },
): Promise<SchemaGateDecision> {
  let known = overrides?.known;
  if (!known) {
    try {
      known = await knownVersions();
    } catch (err) {
      return evaluateSchemaGate({
        ledgerVersions: [],
        ledgerError: `本构建的迁移清单不可读（${err instanceof Error ? err.message : String(err)}），无判据可用`,
        ledgerErrorCode: 'schema_owner_attribution_unavailable',
        knownVersions: [],
        required: overrides?.required ?? REQUIRED_SCHEMA_VERSION,
        knownMax: overrides?.knownMax ?? KNOWN_MAX_SCHEMA_VERSION,
        allowAheadRaw: overrides?.allowAheadRaw ?? readEnvString('AIDCP_ALLOW_SCHEMA_AHEAD'),
      });
    }
  }
  const ledger = await readLedgerVersions(client);
  return evaluateSchemaGate({
    ledgerVersions: ledger.versions,
    ledgerError: ledger.error,
    knownVersions: known,
    required: overrides?.required ?? REQUIRED_SCHEMA_VERSION,
    knownMax: overrides?.knownMax ?? KNOWN_MAX_SCHEMA_VERSION,
    allowAheadRaw: overrides?.allowAheadRaw ?? readEnvString('AIDCP_ALLOW_SCHEMA_AHEAD'),
  });
}

interface OwnerScope {
  known: string[];
  required: string;
  knownMax: string;
}

/** 属主 → 版本窗口。判据不可用时抛错（调用方 MUST 判失败，MUST NOT 放行）。 */
export function buildOwnerScopes(index: MigrationOwnerIndex): Record<PgOwner, OwnerScope> {
  const out = {} as Record<PgOwner, OwnerScope>;
  for (const owner of PG_OWNERS) {
    const known = versionsForOwner(index, owner);
    out[owner] = { known, ...narrowSchemaContract(known) };
  }
  return out;
}

/**
 * 账本行按属主裁剪：保留「属于本属主的版本」与「本构建根本不认识的版本」。
 * 后者是回滚信号（库比代码新），按属主裁掉它等于把 ahead 检测悄悄关掉。
 */
function ledgerForOwner(rows: string[], scope: OwnerScope, allVersions: Set<string>): string[] {
  const mine = new Set(scope.known);
  return rows.filter((v) => mine.has(v) || !allVersions.has(v));
}

/** 连接目标指纹：只作进程内分组键，绝不落日志（连接串里可能带口令）。 */
function connectionFingerprint(config: pg.ClientConfig): string {
  const raw = config.connectionString
    ? `url:${config.connectionString}`
    : `host:${config.host}|${config.port}|${config.database}|${config.user}`;
  return createHash('sha256').update(raw).digest('hex');
}

interface LedgerGroup {
  owners: PgOwner[];
  config?: pg.ClientConfig;
  injected?: LedgerQueryable;
}

function buildGroups(
  owners: readonly PgOwner[],
  options?: { client?: LedgerQueryable; clients?: Partial<Record<PgOwner, LedgerQueryable>> },
): LedgerGroup[] {
  if (options?.clients) {
    return owners.map((owner) => ({ owners: [owner], injected: options.clients?.[owner] }));
  }
  if (options?.client) {
    // 注入单一账本 = 显式声明「这些属主共用这一个账本」：只读一次，喂给组内每个属主判定。
    return [{ owners: [...owners], injected: options.client }];
  }
  const byFingerprint = new Map<string, LedgerGroup>();
  for (const owner of owners) {
    const config = resolveOwnerPgConfig(owner) as pg.ClientConfig;
    const key = connectionFingerprint(config);
    const existing = byFingerprint.get(key);
    if (existing) existing.owners.push(owner);
    else byFingerprint.set(key, { owners: [owner], config });
  }
  return [...byFingerprint.values()];
}

/** 该组的账本行；连不上库时返回 error（与「账本表不存在」走同一条 fail-closed 判定）。 */
async function readGroupLedger(group: LedgerGroup): Promise<{ versions: string[]; error?: string }> {
  if (group.injected) return readLedgerVersions(group.injected);
  if (!group.config) return { versions: [], error: '该属主组没有连接配置' };
  const client = new Client(group.config);
  try {
    await client.connect();
  } catch (err) {
    return { versions: [], error: err instanceof Error ? err.message : String(err) };
  }
  try {
    return await readLedgerVersions(client as unknown as LedgerQueryable);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function describeTargets(groups: LedgerGroup[], owners: readonly PgOwner[]): string {
  if (groups.length === 1 && groups[0].owners.length === PG_OWNERS.length) {
    const vars = PG_OWNERS.map(pgOwnerUrlEnvVar).join(' / ');
    return `三属主账本回落同一连接目标（${vars} 均未设）：读一次账本、判三次`;
  }
  const scoped = owners.length === PG_OWNERS.length ? '' : `（本进程只连 ${owners.join('+')}）`;
  return `账本连接目标 ${groups.length} 个：${groups.map((g) => g.owners.join('+')).join('，')}${scoped}`;
}

/**
 * 启动期入口：按属主库各读各的账本，打逐属主结论，enforce 模式下任一不通过即抛。
 * 调用点 MUST NOT 包 try/catch。
 */
export async function runSchemaContractGate(options?: {
  /** 注入单一账本（三属主共用），只读一次 */
  client?: LedgerQueryable;
  /** 按属主注入账本（拆库后的形态） */
  clients?: Partial<Record<PgOwner, LedgerQueryable>>;
  mode?: SchemaGateMode;
  /** 属主判据来源（测试可注入一个失败的加载器，验证「判据没了 MUST NOT 放行」） */
  loadScopes?: () => Promise<MigrationOwnerScopes>;
  /**
   * 本进程**真正打开了哪些属主库连接**（Block④ 三仓提取 · 批次 0）。缺省＝全部三个。
   *
   * **判据必须是「开了哪些池」，不是「跑的是哪个服务模式」。** 今天组合根在基础段
   * `server.ts:957-959` **无条件建三个池、零模式门控** ⇒ 任何模式都连三个库，按模式收窄会让门
   * 校验得比进程实际用的少 —— 那正是本门存在的意义（enforce 假绿）的反面。等池按属主收窄之后，
   * 调用方传的集合自然跟着变小，门无需再改。
   *
   * 传入集合外的属主**不读账本、不判定、不出现在结论里**：本进程既然不连那个库，
   * 就没有立场声称它的 schema 对或不对。
   */
  owners?: readonly PgOwner[];
  /**
   * 日志前缀里的服务名。缺省 `aidcp-cloud`（单体，也是本文件的事实源所在）。
   *
   * **这不是装饰**：同一份实现会被派生进 `aidcp-automation/src/` 与打包进 `aidcp-transport`，
   * 由三个各自独立的 systemd 单元调用。写死 `[aidcp-cloud]` 的后果是——自动化进程因 schema
   * 落后而拒绝启动时，`journalctl -u aidcp-automation` 里打出来的是**别的服务的名字**，
   * 而这条日志恰好是排查那次启动失败的唯一线索（门刻意跑在任何存储 init 之前、无 try/catch，
   * 之后什么都不会再打）。派生方 MUST 传自己的名字。
   */
  serviceLabel?: string;
}): Promise<SchemaGateResult> {
  const mode = options?.mode ?? parseSchemaGateMode(readEnvString('AIDCP_SCHEMA_GATE'));
  // 本进程连了哪些属主库就判哪些（缺省全部三个 ⇒ 与改动前逐字节一致）。空集合视为未指定：
  // 「一个库都不判」永远不该是默认结果，那等于把门关掉。
  const owners: readonly PgOwner[] =
    options?.owners && options.owners.length > 0 ? options.owners : PG_OWNERS;
  const service = options?.serviceLabel ?? 'aidcp-cloud';
  const prefix = (owner: PgOwner) => `[${service}] schema 契约门（${mode}/${owner}）`;
  const allowAheadRaw = readEnvString('AIDCP_ALLOW_SCHEMA_AHEAD');

  let scopes: Record<PgOwner, OwnerScope> | undefined;
  let index: MigrationOwnerIndex | undefined;
  let scopeError: string | undefined;
  try {
    const loaded = await (options?.loadScopes?.() ?? loadMigrationOwnerScopes(() => loadMigrationFiles()));
    index = loaded.index;
    scopes = buildOwnerScopes(loaded.index);
  } catch (err) {
    scopeError = err instanceof Error ? err.message : String(err);
  }

  const results: SchemaGateOwnerResult[] = [];

  if (!scopes || !index) {
    // 判据不可用 = 无法证明任何属主的 schema 正确。MUST NOT 连库「试一下」再放行。
    for (const owner of owners) {
      const decision = evaluateSchemaGate({
        ledgerVersions: [],
        ledgerError: `属主判据不可用（${scopeError}）`,
        ledgerErrorCode: 'schema_owner_attribution_unavailable',
        knownVersions: [],
        required: REQUIRED_SCHEMA_VERSION,
        knownMax: KNOWN_MAX_SCHEMA_VERSION,
        allowAheadRaw,
      });
      results.push({ owner, decision, conclusion: formatGateConclusion(decision) });
    }
  } else {
    const groups = buildGroups(owners, options);
    console.log(`[${service}] schema 契约门（${mode}） ${describeTargets(groups, owners)}`);
    if (index.residue.length > 0) {
      // 残留 = 头声明为空、判不出属主、按安全方向计入全部属主的那批（见 migration-owners.ts 文件头第 2 点）。
      // 启动日志只报数（逐条清单由 `npm run migrate status` 打），但绝不省略这一行。
      console.log(
        `[${service}] schema 契约门（${mode}） 残留迁移（头声明为空、计入全部属主）${index.residue.length} 条，逐条见 npm run migrate status`,
      );
    }

    const byOwner = new Map<PgOwner, { versions: string[]; error?: string }>();
    for (const group of groups) {
      const ledger = await readGroupLedger(group);
      for (const owner of group.owners) byOwner.set(owner, ledger);
    }

    for (const owner of owners) {
      const scope = scopes[owner];
      const ledger = byOwner.get(owner) ?? { versions: [], error: '本属主没有账本连接' };
      const decision = evaluateSchemaGate({
        ledgerVersions: ledger.error ? [] : ledgerForOwner(ledger.versions, scope, index.allVersions),
        ledgerError: ledger.error,
        knownVersions: scope.known,
        required: scope.required,
        knownMax: scope.knownMax,
        allowAheadRaw,
      });
      results.push({ owner, decision, conclusion: formatGateConclusion(decision) });
    }
  }

  const failed = results.filter((r) => !r.decision.pass);
  for (const result of results) {
    if (result.decision.pass) console.log(`${prefix(result.owner)} ${result.conclusion}`);
    else if (mode === 'enforce') console.error(`${prefix(result.owner)} 拒绝启动：${result.conclusion}`);
    else console.warn(`${prefix(result.owner)} 未通过（warn 模式暂不拒绝启动，enforce 下将拒绝）：${result.conclusion}`);
  }

  const waived = results.filter((r) => r.decision.waived && r.decision.waivedUpTo);
  if (waived.length > 0) {
    const operator = readEnvString('AIDCP_MIGRATE_BY') ?? readEnvString('USER') ?? 'unknown';
    const detail = `${waived.map((r) => `[${r.owner}] ${r.conclusion}`).join(' | ')}；放行者 applied_by=${operator}`;
    console.warn(`[${service}] schema 契约门（${mode}） 超前放行已生效：${detail}`);
    pendingWaiverAlert = { title: 'schema 契约门超前放行生效', detail };
  }

  const primary = failed[0] ?? results[0];
  const result: SchemaGateResult = {
    decision: primary.decision,
    mode,
    conclusion: primary.conclusion,
    owners: results,
    pass: failed.length === 0,
  };

  if (failed.length > 0 && mode === 'enforce') {
    const codes = [...new Set(failed.map((r) => r.decision.code).filter(Boolean))].join(', ');
    throw new Error(`${codes}: ${failed.map((r) => `[${r.owner}] ${r.conclusion}`).join(' | ')}`);
  }
  return result;
}
