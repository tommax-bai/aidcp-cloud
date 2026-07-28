import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import {
  SchemaCapabilityError,
  classifySchemaCapability,
  type SchemaProber,
} from '../kernel/schema-capability-contract.js';
import {
  FACEBOOK_RULE_DEFINITION_ID,
  FACEBOOK_RULE_DEFINITION_VERSION,
  type FacebookRuleModeConfig,
  type SetFacebookRuleModeResult,
} from '../kernel/facebook-rule-mode-types.js';
import { normalizePlatformId } from '../kernel/platform-types.js';
import {
  writeWithMirrorBump,
  type MirrorVersionBumper,
} from './mirror-version-store.js';

export {
  FACEBOOK_RULE_DEFINITION_ID,
  FACEBOOK_RULE_DEFINITION_VERSION,
  FACEBOOK_RULE_JOIN_EVERY_N_ROUNDS,
  FACEBOOK_RULE_VIEW_THRESHOLD,
  facebookRuleRoundIncludesJoin,
} from '../kernel/facebook-rule-mode-types.js';
export type {
  ApplyFacebookRuleViewResult,
  FacebookRuleActionState,
  FacebookRuleModeBatchView,
  FacebookRuleModeConfig,
  FacebookRuleModeRuntimeView,
  FacebookRuleModeView,
  SetFacebookRuleModeResult,
} from '../kernel/facebook-rule-mode-types.js';

const { Pool } = pg;

/**
 * schema 要求（change environment-level-rule-mode-and-approval）：探测的是**环境键表**。
 *
 * 缺表时 init 带 `0096` 这个 version id fail-closed，而不是退回读账号键旧表——回落等于把
 * 「配置跟账号走」这条已被否决的语义偷偷放回来，且回滚到旧代码时没有任何告警。
 * 旧表 `facebook_rule_mode_config` 刻意**不在要求集合里**：它自此不参与运行时读写与判定，只作可回滚数据。
 */
const FACEBOOK_RULE_CONFIG_REQUIREMENT = {
  tables: new Map([
    ['facebook_rule_mode_environment_config', new Set([
      'env_key',
      'enabled',
      'definition_id',
      'definition_version',
      'updated_at',
      'updated_by',
    ])],
  ]),
  indexes: new Map<string, string>(),
};

interface ConfigDbRow {
  env_key: string;
  enabled: boolean;
  definition_id: string;
  definition_version: number | string;
  updated_at: Date | string | null;
  updated_by: string | null;
}

/**
 * 账号 → 唯一绑定环境的反查端口（change environment-level-rule-mode-and-approval）。
 *
 * 由组合根注入 `ClientUserStore.resolveEnvironmentKeyForAccount` —— 它走的是慢启动那次已经建立的
 * 环境↔账号镜像的**同一次刷新**，故本 store 的热路径仍是零 IO。未注入 = 反查能力缺席 = 一律
 * fail-closed 为「未启用规则模式」，MUST NOT 因为没接线就回落账号键存量值。
 */
export type FacebookRuleModeEnvironmentResolver = (accountId: string) =>
  | { ok: true; envKey: string }
  | { ok: false; reason: 'binding_unknown' | 'binding_conflict' | 'binding_unavailable' };

export interface FacebookRuleModeStoreOptions {
  pool?: pg.Pool;
  configPool?: pg.Pool;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  schemaProber: SchemaProber;
  mirrorVersionBumper?: MirrorVersionBumper;
  /** 账号 → 环境反查。组合根在 ClientUserStore 就绪后注入；缺席即反查一律失败。 */
  environmentResolver?: FacebookRuleModeEnvironmentResolver;
}

/** 缺行 = 未配置 = 关。此时没有任何持久定义身份，如实报当前代码定义且不算漂移。 */
function defaultConfig(envKey: string | null): FacebookRuleModeConfig {
  return {
    envKey,
    enabled: false,
    definitionId: FACEBOOK_RULE_DEFINITION_ID,
    definitionVersion: FACEBOOK_RULE_DEFINITION_VERSION,
    definitionMismatch: false,
    updatedAt: null,
    updatedBy: null,
  };
}

export class FacebookRuleModeStore {
  private readonly configPool: pg.Pool;
  private readonly schemaProber: SchemaProber;
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  private readonly ownedPool?: pg.Pool;
  private environmentResolver?: FacebookRuleModeEnvironmentResolver;
  /** 环境键 → 配置。**账号键不再进这张表**（旧列只作可回滚数据）。 */
  private cache = new Map<string, FacebookRuleModeConfig>();

  constructor(options: FacebookRuleModeStoreOptions) {
    this.schemaProber = options.schemaProber;
    this.mirrorVersionBumper = options.mirrorVersionBumper;
    this.environmentResolver = options.environmentResolver;
    let pool = options.configPool ?? options.pool;
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
    this.configPool = pool;
  }

  /**
   * 反查端口的后绑定入口：组合根里 ClientUserStore 与本 store 的构造次序不同，允许 init 之后再接。
   * 只接线，不改变任何已缓存配置。
   */
  bindEnvironmentResolver(resolver: FacebookRuleModeEnvironmentResolver): void {
    this.environmentResolver = resolver;
  }

  async init(): Promise<void> {
    const shape = await this.schemaProber(
      this.configPool,
      [...FACEBOOK_RULE_CONFIG_REQUIREMENT.tables.keys()],
    );
    const verdict = classifySchemaCapability(
      FACEBOOK_RULE_CONFIG_REQUIREMENT,
      shape,
    );
    if (verdict.status !== 'ready') {
      throw new SchemaCapabilityError(
        {
          capability: 'facebook_rule_mode_config',
          sinceVersion: '0097_environment_level_rule_mode_and_approval',
          ddl: [],
        },
        verdict,
      );
    }
    await this.refreshFromAuthority();
  }

  /** 只读回填过的环境行；`env_key IS NULL` 的存量账号行**不进镜像**（旧列停止参与判定）。 */
  async refreshFromAuthority(): Promise<void> {
    const { rows } = await this.configPool.query<ConfigDbRow>(
      `SELECT env_key, enabled, definition_id, definition_version, updated_at, updated_by
         FROM facebook_rule_mode_environment_config`,
    );
    const next = new Map<string, FacebookRuleModeConfig>();
    for (const row of rows) next.set(row.env_key, this.configFromDb(row));
    this.cache = next;
  }

  /**
   * 运行期裁决用的按账号读。**签名刻意不变**：调用点（风控裁决、面板投影、客户端路由）一律不动，
   * 语义整体升级为「账号 → 唯一绑定环境 → 环境配置」。
   *
   * 反查失败（绑定未知 / 绑定冲突 / 跨客户争用 / 副本陈旧）一律返回未启用，MUST NOT 回落任何账号键
   * 存量值——不跑比错跑安全，与「慢启动真态未知即 fail-closed」同一方向。
   */
  getConfig(accountId: string): FacebookRuleModeConfig {
    const resolved = this.resolveEnvKey(accountId);
    if (!resolved.ok) return defaultConfig(null);
    return this.cache.get(resolved.envKey) ?? defaultConfig(resolved.envKey);
  }

  /** 反查诊断：裁决点要能把具名 blocker 说出来，而不是笼统的「没开」。 */
  resolveEnvironmentBlocker(accountId: string): string | null {
    const resolved = this.resolveEnvKey(accountId);
    return resolved.ok ? null : `rule_environment_${resolved.reason}`;
  }

  /** 环境键直读：缺行 = 未启用（不建行、不假装配置过）。 */
  getConfigForEnv(envKey: string): FacebookRuleModeConfig {
    const key = (envKey ?? '').trim();
    if (!key) return defaultConfig(null);
    return this.cache.get(key) ?? defaultConfig(key);
  }

  /**
   * 环境级单写。平台校验取**环境自己的权威字段**，不经账号——未绑定账号的环境同样可配置。
   */
  async setEnvironment(
    envKey: string,
    patch: { enabled?: boolean },
    updatedBy: string,
  ): Promise<SetFacebookRuleModeResult> {
    const key = (envKey ?? '').trim();
    if (!Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
      return { ok: false, reason: 'no_valid_fields' };
    }
    if (typeof patch.enabled !== 'boolean') {
      return { ok: false, reason: 'invalid_value' };
    }
    if (!key) return { ok: false, reason: 'environment_not_found' };
    const environment = await this.configPool.query<{ platform: string | null }>(
      `SELECT platform FROM client_environments WHERE env_key = $1`,
      [key],
    );
    if (!environment.rows[0]) return { ok: false, reason: 'environment_not_found' };
    try {
      if (normalizePlatformId(environment.rows[0].platform) !== 'facebook') {
        return { ok: false, reason: 'unsupported_platform' };
      }
    } catch {
      return { ok: false, reason: 'unsupported_platform' };
    }
    const { rows } = await writeWithMirrorBump(
      this.configPool,
      this.mirrorVersionBumper,
      'content_schedule',
      (q) => q.query<ConfigDbRow>(
        `INSERT INTO facebook_rule_mode_environment_config
           (env_key, enabled, definition_id, definition_version, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, now(), $5)
         ON CONFLICT (env_key) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               definition_id = EXCLUDED.definition_id,
               definition_version = EXCLUDED.definition_version,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by
         RETURNING env_key, enabled, definition_id, definition_version, updated_at, updated_by`,
        [
          key,
          patch.enabled,
          FACEBOOK_RULE_DEFINITION_ID,
          FACEBOOK_RULE_DEFINITION_VERSION,
          updatedBy,
        ],
      ),
    );
    const row = this.configFromDb(rows[0]!);
    this.cache.set(key, row);
    return { ok: true, row };
  }

  /**
   * 面板等按账号寻址的写入口：先把账号定位到它**唯一绑定的环境**，再落环境级单写。
   * 定位不出唯一环境时具名拒绝，MUST NOT 退回写账号键旧列。
   */
  async setAccount(
    accountId: string,
    patch: { enabled?: boolean },
    updatedBy: string,
  ): Promise<SetFacebookRuleModeResult> {
    const resolved = this.resolveEnvKey(accountId);
    if (!resolved.ok) {
      return {
        ok: false,
        reason: resolved.reason === 'binding_unavailable'
          ? 'environment_unavailable'
          : resolved.reason === 'binding_conflict'
            ? 'environment_conflict'
            : 'environment_not_found',
      };
    }
    return this.setEnvironment(resolved.envKey, patch, updatedBy);
  }

  async close(): Promise<void> {
    await this.ownedPool?.end();
  }

  private resolveEnvKey(accountId: string): ReturnType<FacebookRuleModeEnvironmentResolver> {
    const account = (accountId ?? '').trim();
    if (!account) return { ok: false, reason: 'binding_unknown' };
    if (!this.environmentResolver) return { ok: false, reason: 'binding_unavailable' };
    return this.environmentResolver(account);
  }

  /**
   * 回读 MUST 用库里的定义身份，MUST NOT 用代码常量顶替。
   *
   * 顶替过一次的后果（change facebook-rule-mode-two-tier-cadence 修）：节奏一换定义号，所有存量行
   * 都会在 API / 后台 / 客户端被谎报成新定义，而 config 表没有 execution_target、DEV 与 OL 又共库
   * ——单侧部署就会出现「同一环境两套节奏各自跑」且没有任何机械手段能发现。
   */
  private configFromDb(row: ConfigDbRow): FacebookRuleModeConfig {
    const definitionId = row.definition_id;
    const definitionVersion = Number(row.definition_version);
    const definitionMismatch =
      definitionId !== FACEBOOK_RULE_DEFINITION_ID
      || definitionVersion !== FACEBOOK_RULE_DEFINITION_VERSION;
    if (definitionMismatch) {
      console.warn(
        `[facebook-rule] stored definition mismatch env=${row.env_key} `
        + `stored=${definitionId}@${definitionVersion} `
        + `current=${FACEBOOK_RULE_DEFINITION_ID}@${FACEBOOK_RULE_DEFINITION_VERSION}`,
      );
    }
    return {
      envKey: row.env_key,
      enabled: row.enabled === true,
      definitionId,
      definitionVersion,
      definitionMismatch,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row.updated_by ?? null,
    };
  }
}
