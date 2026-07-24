/**
 * 「按 owner 取 PG 连接配置」的解析器（Block③ 物理拆库 L2 前置脚手架）。
 *
 * ⚠️ 这是**未接线的 L2 脚手架**：已落地入库，但尚未被任何组合根消费、未替换任何现有取连
 * 逻辑。等到各属主专属库上线（per-owner DB）时再接线；在那之前，默认回落保持单库逐字节等价，
 * 引入本模块对现网零变更。归位在 `aidcp-cloud/src/kernel/`，与 `pg-config.ts` 同层
 * （kernel 准入：只 `import type pg`，无 SQL 字面量、无业务依赖、无进程内活状态、无副作用）。
 *
 * ## 它解决什么
 *
 * 物理拆库后，三个属主服务各连**各自的库**（`aidcp_content` / `aidcp_automation` /
 * `aidcp_api`）。本模块把「owner → PoolConfig」这一步收成**唯一解析口**：调用方拿 owner，
 * 拿回一份 `pg.PoolConfig`，不关心底层是单库还是三库。
 *
 * ## 默认回落 = 单库、逐字节等价（不变量）
 *
 * 任一 owner 的 `AIDCP_PG_<OWNER>_URL` 未配（缺失 / 空串 / 全空白），该 owner 就**逐字回落**
 * 到今天的共享 PG 配置（`DATABASE_URL`，否则 `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD`，
 * 再否则 `DEFAULT_PG_CONFIG` 内置默认）。
 *
 * 因此**三个 owner URL 都不配（今天的状态）时，三个 owner 解析出的 PoolConfig 完全相同、且
 * 与既有 `resolveEnvPgConfig()` 逐字节一致** —— 引入本模块对现网是零变更：同一个单库，三个别名。
 * 拆库是「逐个 owner 把它的 URL 指到新库」的渐进切换，不是一次性开关。
 *
 * 回落分支刻意复刻 `pg-config.ts` 的 `resolveEnvPgConfig()`（同一套 env 名、同一 `DEFAULT_PG_CONFIG`
 * 兜底、同一 `readEnvString` 语义 —— 非空白即返回原值不裁剪、全空白视为未设），只多接了一个
 * 可注入的 `env` 形参用于单测。`DEFAULT_PG_CONFIG` 里含明文口令兜底属既存事实（见 `pg-config.ts`
 * 文件头），本模块**只 import、不复制该字面量**，口令不落进本文件。
 */
import type pg from 'pg';
import { DEFAULT_PG_CONFIG } from './pg-config.js';

/**
 * 拆库属主。取值与 `boundaries/table-ownership.json` 的 `owner` 字段（小写）对齐，
 * 即分解 proposal §5.1 的单一写入者三分。
 */
export type PgOwner = 'content' | 'automation' | 'api';

/** 三个属主的稳定枚举（供组合根遍历 / 校验用）。 */
export const PG_OWNERS: readonly PgOwner[] = ['content', 'automation', 'api'] as const;

/** 各属主拆库后的目标库名（仅作文档/运维参照，本模块不据此建连）。 */
export const PG_OWNER_DATABASE: Readonly<Record<PgOwner, string>> = {
  content: 'aidcp_content',
  automation: 'aidcp_automation',
  api: 'aidcp_api',
};

/**
 * 该属主专属连接串的 env 变量名：`AIDCP_PG_CONTENT_URL` / `AIDCP_PG_AUTOMATION_URL` /
 * `AIDCP_PG_API_URL`（owner 一律大写）。
 */
export function pgOwnerUrlEnvVar(owner: PgOwner): string {
  return `AIDCP_PG_${owner.toUpperCase()}_URL`;
}

/**
 * 与 `pg-config.ts` 的 `readEnvString` 逐字等价（唯一区别是从注入的 `env` 读）：非空白即返回
 * **原值不裁剪**，全空白 / 缺失视为未设返回 `undefined`。
 */
function readEnvString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value && value.trim() ? value : undefined;
}

function readEnvPort(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = readEnvString(env, name);
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/**
 * 今天的共享单库配置。与 `pg-config.ts` 的 `resolveEnvPgConfig()` 逐字等价，唯一区别是
 * 从注入的 `env` 读（便于单测），默认 `process.env`。落地后可直接改成 `import { resolveEnvPgConfig }`
 * 并让它接受 env 形参，收成单一事实源。
 */
function resolveSharedPgConfig(env: NodeJS.ProcessEnv): pg.PoolConfig {
  const connectionString = readEnvString(env, 'DATABASE_URL');
  if (connectionString) {
    return { connectionString };
  }
  return {
    host: readEnvString(env, 'PGHOST') ?? DEFAULT_PG_CONFIG.host,
    port: readEnvPort(env, 'PGPORT') ?? DEFAULT_PG_CONFIG.port,
    database: readEnvString(env, 'PGDATABASE') ?? DEFAULT_PG_CONFIG.database,
    user: readEnvString(env, 'PGUSER') ?? DEFAULT_PG_CONFIG.user,
    password: readEnvString(env, 'PGPASSWORD') ?? DEFAULT_PG_CONFIG.password,
  };
}

/**
 * 按属主解析 PG 连接配置。
 *
 * - 若配了 `AIDCP_PG_<OWNER>_URL`（非空）→ 返回 `{ connectionString: <该 URL> }`，连该属主专属库。
 * - 否则 → 回落到共享单库配置（见 `resolveSharedPgConfig`），与今天完全一致。
 *
 * 纯函数、无副作用、不建连、不发 SQL。返回值直接喂给 `new pg.Pool(...)`。
 *
 * @param owner  属主（`content` / `automation` / `api`）
 * @param env    环境变量源，默认 `process.env`（单测可注入桩 env）
 */
export function resolveOwnerPgConfig(
  owner: PgOwner,
  env: NodeJS.ProcessEnv = process.env,
): pg.PoolConfig {
  const ownerUrl = readEnvString(env, pgOwnerUrlEnvVar(owner));
  if (ownerUrl) {
    return { connectionString: ownerUrl };
  }
  return resolveSharedPgConfig(env);
}

/**
 * 便捷：一次解析全部三个属主。默认（无任何 owner URL）三者返回逐字相同的单库配置。
 * 组合根拆三入口后，各入口只取自己那一个属主。
 */
export function resolveAllOwnerPgConfigs(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<PgOwner, pg.PoolConfig>> {
  return {
    content: resolveOwnerPgConfig('content', env),
    automation: resolveOwnerPgConfig('automation', env),
    api: resolveOwnerPgConfig('api', env),
  };
}
