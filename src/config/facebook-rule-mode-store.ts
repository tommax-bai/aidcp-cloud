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

const FACEBOOK_RULE_CONFIG_REQUIREMENT = {
  tables: new Map([
    ['facebook_rule_mode_config', new Set([
      'account_id',
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
  account_id: string;
  enabled: boolean;
  definition_id: string;
  definition_version: number | string;
  updated_at: Date | string | null;
  updated_by: string | null;
}

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
}

/** 缺行 = 未配置 = 关。此时没有任何持久定义身份，如实报当前代码定义且不算漂移。 */
function defaultConfig(accountId: string): FacebookRuleModeConfig {
  return {
    accountId,
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
  private cache = new Map<string, FacebookRuleModeConfig>();

  constructor(options: FacebookRuleModeStoreOptions) {
    this.schemaProber = options.schemaProber;
    this.mirrorVersionBumper = options.mirrorVersionBumper;
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
          sinceVersion: '0092_facebook_rule_mode_config',
          ddl: [],
        },
        verdict,
      );
    }
    await this.refreshFromAuthority();
  }

  async refreshFromAuthority(): Promise<void> {
    const { rows } = await this.configPool.query<ConfigDbRow>(
      `SELECT account_id, enabled, definition_id, definition_version, updated_at, updated_by
         FROM facebook_rule_mode_config`,
    );
    const next = new Map<string, FacebookRuleModeConfig>();
    for (const row of rows) next.set(row.account_id, this.configFromDb(row));
    this.cache = next;
  }

  getConfig(accountId: string): FacebookRuleModeConfig {
    return this.cache.get(accountId) ?? defaultConfig(accountId);
  }

  async setAccount(
    accountId: string,
    patch: { enabled?: boolean },
    updatedBy: string,
  ): Promise<SetFacebookRuleModeResult> {
    if (!Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
      return { ok: false, reason: 'no_valid_fields' };
    }
    if (typeof patch.enabled !== 'boolean') {
      return { ok: false, reason: 'invalid_value' };
    }
    const account = await this.configPool.query<{ platform: string | null }>(
      `SELECT platform FROM accounts WHERE account_id = $1`,
      [accountId],
    );
    if (!account.rows[0]) return { ok: false, reason: 'account_not_found' };
    try {
      if (normalizePlatformId(account.rows[0].platform) !== 'facebook') {
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
        `INSERT INTO facebook_rule_mode_config
           (account_id, enabled, definition_id, definition_version, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, now(), $5)
         ON CONFLICT (account_id) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               definition_id = EXCLUDED.definition_id,
               definition_version = EXCLUDED.definition_version,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by
         RETURNING account_id, enabled, definition_id, definition_version, updated_at, updated_by`,
        [
          accountId,
          patch.enabled,
          FACEBOOK_RULE_DEFINITION_ID,
          FACEBOOK_RULE_DEFINITION_VERSION,
          updatedBy,
        ],
      ),
    );
    const row = this.configFromDb(rows[0]!);
    this.cache.set(accountId, row);
    return { ok: true, row };
  }

  async close(): Promise<void> {
    await this.ownedPool?.end();
  }

  /**
   * 回读 MUST 用库里的定义身份，MUST NOT 用代码常量顶替。
   *
   * 顶替过一次的后果（change facebook-rule-mode-two-tier-cadence 修）：节奏一换定义号，所有存量行
   * 都会在 API / 后台 / 客户端被谎报成新定义，而 config 表没有 execution_target、DEV 与 OL 又共库
   * ——单侧部署就会出现「同一账号两套节奏各自跑」且没有任何机械手段能发现。
   */
  private configFromDb(row: ConfigDbRow): FacebookRuleModeConfig {
    const definitionId = row.definition_id;
    const definitionVersion = Number(row.definition_version);
    const definitionMismatch =
      definitionId !== FACEBOOK_RULE_DEFINITION_ID
      || definitionVersion !== FACEBOOK_RULE_DEFINITION_VERSION;
    if (definitionMismatch) {
      console.warn(
        `[facebook-rule] stored definition mismatch account=${row.account_id} `
        + `stored=${definitionId}@${definitionVersion} `
        + `current=${FACEBOOK_RULE_DEFINITION_ID}@${FACEBOOK_RULE_DEFINITION_VERSION}`,
      );
    }
    return {
      accountId: row.account_id,
      enabled: row.enabled === true,
      definitionId,
      definitionVersion,
      definitionMismatch,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row.updated_by ?? null,
    };
  }
}
