/**
 * 真库集成测试的**连接守卫**。
 *
 * 背景（这是本文件存在的唯一理由）：`test/**\/*.integration.test.ts` 会对客户身份 / 环境归属 /
 * 离场台账做 `TRUNCATE ... RESTART IDENTITY CASCADE`，而本项目的 dev 与 ol **连同一台物理
 * PostgreSQL，那台就是生产库**；更糟的是 `src/kernel/pg-config.ts` 的内置默认会在
 * `DATABASE_URL` / `PG*` 全缺省时**兜底到本机 `aidcp` 库**，而 dev 机上的生产库正是走 `127.0.0.1`。
 * 也就是说「什么都不配」不等于「连不上任何东西」，恰恰等于「连上生产库」。
 *
 * 三条守卫（缺一不可）：
 *   1. **拒绝已知生产 host**：dev / ol 两台 ECS 的地址硬拒；
 *   2. **强制专用库名前缀 `aidcp_test`**：不符即**抛错**。这条同时兜住第 1 条漏掉的任何生产入口——
 *      生产库名就叫 `aidcp`，前缀不符；也兜住 `127.0.0.1` 上的那个 `aidcp`；
 *   3. **仅在显式测试通道生效**：没有 `AIDCP_PG_INTEGRATION=1` 时**一律不连库**（照旧 skip），
 *      常规 `npm test` 因此绝无可能连上真库。
 *
 * 红线：守卫不合格 MUST **抛错**，MUST NOT 「跳过」。跳过等于把守卫写成静默失败——
 * 操作员会以为集成测试跑过了，实际上一条都没跑。唯一允许 skip 的情形是「不在测试通道里」，
 * 那不是守卫判定失败，是根本没打算连库。
 *
 * 连接串**只从环境变量读**，本文件与其测试里不出现任何真实口令 / token（示例一律用占位符）。
 */
import { DEFAULT_PG_CONFIG } from '../../src/kernel/pg-config.js';

/** 显式测试通道开关。由 `npm run test:pg` 设置；不设即整组 skip。 */
export const PG_CHANNEL_ENV = 'AIDCP_PG_INTEGRATION';
/** 互动域真库集成测试的连接串（`test/interactions/*.integration.test.ts`）。 */
export const INTERACTION_URL_ENV = 'AIDCP_INTERACTION_TEST_DATABASE_URL';
/** 传输原语真库集成测试的连接串（`test/transport/*.integration.test.ts`，历史上直接吃 DATABASE_URL）。 */
export const OUTBOX_URL_ENV = 'DATABASE_URL';

/** 专用测试库名前缀。库名不以它开头即拒绝。 */
export const REQUIRED_DATABASE_PREFIX = 'aidcp_test';

/** 已知生产 host（dev / ol 两台 ECS 共用同一台物理 PG）。 */
export const FORBIDDEN_HOSTS: readonly string[] = ['121.89.85.150', '123.56.253.183'];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

/** 守卫拒绝。**永远抛出**，不降级为 skip。 */
export class PgTestGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgTestGuardError';
  }
}

export interface PgTarget {
  host: string;
  database: string;
}

type Env = Record<string, string | undefined>;

function readEnv(env: Env, name: string): string | undefined {
  const value = env[name];
  return value && value.trim() ? value.trim() : undefined;
}

/** 解析 `postgres://…` 连接串。解析不了 MUST 抛错，MUST NOT 当作「无法判断所以放行」。 */
export function parsePgUrl(label: string, raw: string): PgTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PgTestGuardError(
      `${label} 不是可解析的连接串。守卫判不了它指向哪个库，故拒绝运行（格式：postgres://<user>:<password>@<host>:<port>/<database>）。`,
    );
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new PgTestGuardError(`${label} 的协议是 ${url.protocol}，只接受 postgres:// 或 postgresql://。`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) {
    throw new PgTestGuardError(
      `${label} 没有写库名。缺省库名会由 libpq 回落到连接用户的默认库，那正是「以为连的是测试库、其实连的是别的库」的入口。`,
    );
  }
  return { host: url.hostname, database };
}

/**
 * 三条守卫里的第 1、2 条。**任何一条不过即抛错**。
 * `label` 说明这个目标是从哪读来的，出错信息里要能直接看出该改哪个环境变量。
 */
export function assertPgTargetIsTestOnly(label: string, target: PgTarget): void {
  if (FORBIDDEN_HOSTS.includes(target.host)) {
    throw new PgTestGuardError(
      `${label} 指向已知生产 host ${target.host}。dev 与 ol 连的是同一台物理 PostgreSQL，` +
        '集成测试会 TRUNCATE 客户身份 / 环境归属 / 离场台账，绝不允许对它执行。',
    );
  }
  if (LOOPBACK_HOSTS.has(target.host) && target.database === DEFAULT_PG_CONFIG.database) {
    throw new PgTestGuardError(
      `${label} 指向本机的 ${target.database} 库。dev 机上的生产库正是走 ${DEFAULT_PG_CONFIG.host} 的同名库，` +
        '这条路径与「连上生产库」不可区分，故一律拒绝。',
    );
  }
  if (!target.database.startsWith(REQUIRED_DATABASE_PREFIX)) {
    throw new PgTestGuardError(
      `${label} 的库名是 ${target.database}，MUST 以 ${REQUIRED_DATABASE_PREFIX} 开头。` +
        '真库集成测试只允许跑在专用测试库上：请先建一个（例：createdb aidcp_test_local）再指过去。',
    );
  }
}

/**
 * 复刻 `src/kernel/pg-config.ts` 的**缺省解析顺序**，用来核实「什么都不配会落到哪里」。
 *
 * 为什么要单独查这一条：集成测试自己用注入的 pool，但被测代码里凡是没注入 pool 的 store 都会走
 * `resolveEnvPgConfig()` → `DEFAULT_PG_CONFIG`，也就是**本机 `aidcp` 库**。只守住显式连接串、
 * 不守住这条兜底，等于在测试通道里留了一扇直通生产库的后门。
 */
export function resolveAmbientTarget(env: Env): { target: PgTarget; label: string } {
  const url = readEnv(env, 'DATABASE_URL');
  if (url) return { target: parsePgUrl('环境变量 DATABASE_URL', url), label: '环境变量 DATABASE_URL' };
  const host = readEnv(env, 'PGHOST') ?? DEFAULT_PG_CONFIG.host;
  const database = readEnv(env, 'PGDATABASE') ?? DEFAULT_PG_CONFIG.database;
  return {
    target: { host, database },
    label: '缺省连接（PGHOST/PGDATABASE 未设时回落到 kernel 内置 DEFAULT_PG_CONFIG）',
  };
}

export type IntegrationDatabase =
  | { enabled: false; skipReason: string }
  | { enabled: true; connectionString: string };

/**
 * 真库集成测试的唯一入口。
 *
 *   - 不在测试通道里 → `{ enabled: false }`，调用方据此 skip（**不连库**，与改造前行为一致）；
 *   - 在测试通道里 → 连接串必填、且必须过三条守卫，任何一条不过**抛 `PgTestGuardError`**。
 */
export function resolveIntegrationDatabase(urlEnvName: string, env: Env = process.env): IntegrationDatabase {
  if (readEnv(env, PG_CHANNEL_ENV) !== '1') {
    return {
      enabled: false,
      skipReason: `真库集成测试只在显式通道里跑：npm run test:pg（需 ${PG_CHANNEL_ENV}=1 且 ${urlEnvName} 指向 ${REQUIRED_DATABASE_PREFIX}* 库）`,
    };
  }
  const raw = readEnv(env, urlEnvName);
  if (!raw) {
    throw new PgTestGuardError(
      `已进入真库测试通道（${PG_CHANNEL_ENV}=1）却没有 ${urlEnvName}。` +
        '此时 MUST 报错而不是 skip：静默跳过会让人以为集成测试跑过了，实际一条都没跑。',
    );
  }
  assertPgTargetIsTestOnly(`${urlEnvName}`, parsePgUrl(urlEnvName, raw));
  const ambient = resolveAmbientTarget(env);
  assertPgTargetIsTestOnly(ambient.label, ambient.target);
  return { enabled: true, connectionString: raw };
}
