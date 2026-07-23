/**
 * Facebook 自动加群的每账号领域配置。
 *
 * 安全不变量：
 * - 无配置行默认关闭且 dailyCap=0，升级不会让既有账号自动开始加群；
 * - 写前完整校验补丁，再读取 accounts 的平台事实，任何拒绝都不发生 UPSERT；
 * - 只允许 Facebook 账号配置该动作，未知平台同样 fail-closed；
 * - 部分补丁在单条 UPSERT 中按字段存在标志合并，避免用进程缓存覆盖其它写者的新值；
 * - 只以数据库 RETURNING 作为成功真态，写成功后才刷新内存镜像。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import { writeWithMirrorBump, type MirrorVersionBumper } from './mirror-version-store.js';
import { normalizePlatformId, SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX } from '../platform/index.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';

const { Pool } = pg;

export const FACEBOOK_GROUP_JOIN_AUTOMATION_DAILY_CAP_MAX = SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX;
export const FACEBOOK_GROUP_JOIN_AUTOMATION_WEEK_MASK_LENGTH = 168;

export interface FacebookGroupJoinAutomationConfigRow {
  accountId: string;
  enabled: boolean;
  dailyCap: number;
  /** null = 跟随公共内容自动时段；非空 = 额外收窄的 168 位周历。 */
  weekMask: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 未传字段保持数据库现值；weekMask 显式 null 表示恢复跟随公共时段。 */
export interface FacebookGroupJoinAutomationConfigPatch {
  enabled?: boolean;
  dailyCap?: number;
  weekMask?: string | null;
}

export type SetFacebookGroupJoinAutomationConfigResult =
  | { ok: true; row: FacebookGroupJoinAutomationConfigRow }
  | {
      ok: false;
      reason:
        | 'account_not_found'
        | 'unsupported_automation_action'
        | 'invalid_value'
        | 'no_valid_fields';
    };

export const FACEBOOK_GROUP_JOIN_AUTOMATION_CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facebook_group_join_automation_config (
  account_id  TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT false,
  daily_cap   INTEGER NOT NULL DEFAULT 0
              CHECK (daily_cap BETWEEN 0 AND ${FACEBOOK_GROUP_JOIN_AUTOMATION_DAILY_CAP_MAX}),
  week_mask   TEXT
              CHECK (week_mask IS NULL OR week_mask ~ '^[01]{${FACEBOOK_GROUP_JOIN_AUTOMATION_WEEK_MASK_LENGTH}}$'),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
`;

export interface FacebookGroupJoinAutomationStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
  /** schema 保障能力注入端口（必填、无默认）：组合根传 automation 的 ensureCapabilitySchema，本文件只从 kernel 取类型。 */
  schemaEnsurer: SchemaEnsurer;
  /** 跨进程失效通道：写入与版本推进同事务。缺省 = 不推版本（行为逐位退回今日现状）。 */
  mirrorVersionBumper?: MirrorVersionBumper;
}

interface ConfigDbRow {
  account_id: string;
  enabled: boolean;
  daily_cap: number | string;
  week_mask: string | null;
  updated_at: Date | string | null;
  updated_by: string | null;
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isValidDailyCap(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= FACEBOOK_GROUP_JOIN_AUTOMATION_DAILY_CAP_MAX
  );
}

export function isValidFacebookGroupJoinAutomationWeekMask(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === FACEBOOK_GROUP_JOIN_AUTOMATION_WEEK_MASK_LENGTH &&
    /^[01]+$/.test(value)
  );
}

function defaultRow(accountId: string): FacebookGroupJoinAutomationConfigRow {
  return {
    accountId,
    enabled: false,
    dailyCap: 0,
    weekMask: null,
    updatedAt: null,
    updatedBy: null,
  };
}

export class FacebookGroupJoinAutomationStore {
  private readonly pool: pg.Pool;
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  private cache = new Map<string, FacebookGroupJoinAutomationConfigRow>();

  private readonly schemaEnsurer: SchemaEnsurer;

  constructor(options: FacebookGroupJoinAutomationStoreOptions) {
    this.schemaEnsurer = options.schemaEnsurer;
    this.mirrorVersionBumper = options.mirrorVersionBumper;
    this.pool =
      options.pool ??
      new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
  }

  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await this.schemaEnsurer(this.pool, {
      capability: 'facebook_group_join_automation_config',
      sinceVersion: '0067_baseline_facebook_tables',
      ddl: [FACEBOOK_GROUP_JOIN_AUTOMATION_CONFIG_SCHEMA_SQL],
    });
    await this.reload();
  }

  /** 跨进程失效刷新入口（task 3.2）：只由刷新器在版本变化时调用；`reload()` 保持 private。 */
  async refreshFromAuthority(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<ConfigDbRow>(
      `SELECT account_id, enabled, daily_cap, week_mask, updated_at, updated_by
       FROM facebook_group_join_automation_config`,
    );
    const next = new Map<string, FacebookGroupJoinAutomationConfigRow>();
    for (const row of rows) next.set(row.account_id, this.fromDb(row));
    this.cache = next;
  }

  private fromDb(row: ConfigDbRow): FacebookGroupJoinAutomationConfigRow {
    return {
      accountId: row.account_id,
      enabled: row.enabled === true,
      dailyCap: Number(row.daily_cap),
      weekMask: row.week_mask ?? null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row.updated_by ?? null,
    };
  }

  /** 面板与调度器同步读取；缺行返回默认关闭真态，不创建数据库行。 */
  getForAccount(accountId: string): FacebookGroupJoinAutomationConfigRow {
    return this.cache.get(accountId) ?? defaultRow(accountId);
  }

  /**
   * 专属单写：先校验整个补丁，再校验账号与规范化平台，最后原子 UPSERT 并回读。
   * 显式 null weekMask 与“未传 weekMask”通过独立存在标志区分。
   */
  async setAccount(
    accountId: string,
    patch: FacebookGroupJoinAutomationConfigPatch,
    updatedBy: string,
  ): Promise<SetFacebookGroupJoinAutomationConfigResult> {
    const hasEnabled = hasOwn(patch, 'enabled');
    const hasDailyCap = hasOwn(patch, 'dailyCap');
    const hasWeekMask = hasOwn(patch, 'weekMask');

    if (!hasEnabled && !hasDailyCap && !hasWeekMask) {
      return { ok: false, reason: 'no_valid_fields' };
    }
    if (hasEnabled && typeof patch.enabled !== 'boolean') {
      return { ok: false, reason: 'invalid_value' };
    }
    if (hasDailyCap && !isValidDailyCap(patch.dailyCap)) {
      return { ok: false, reason: 'invalid_value' };
    }
    if (
      hasWeekMask &&
      patch.weekMask !== null &&
      !isValidFacebookGroupJoinAutomationWeekMask(patch.weekMask)
    ) {
      return { ok: false, reason: 'invalid_value' };
    }

    const account = await this.pool.query<{ platform: string | null }>(
      `SELECT platform FROM accounts WHERE account_id = $1`,
      [accountId],
    );
    if (account.rows.length === 0) return { ok: false, reason: 'account_not_found' };

    try {
      if (normalizePlatformId(account.rows[0]?.platform) !== 'facebook') {
        return { ok: false, reason: 'unsupported_automation_action' };
      }
    } catch {
      return { ok: false, reason: 'unsupported_automation_action' };
    }

    const { rows } = await writeWithMirrorBump(
      this.pool,
      this.mirrorVersionBumper,
      'facebook_group_join_automation_config',
      (q) =>
        q.query<ConfigDbRow>(
      `INSERT INTO facebook_group_join_automation_config
         (account_id, enabled, daily_cap, week_mask, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, now(), $5)
       ON CONFLICT (account_id) DO UPDATE
         SET enabled = CASE WHEN $6 THEN EXCLUDED.enabled
                            ELSE facebook_group_join_automation_config.enabled END,
             daily_cap = CASE WHEN $7 THEN EXCLUDED.daily_cap
                              ELSE facebook_group_join_automation_config.daily_cap END,
             week_mask = CASE WHEN $8 THEN EXCLUDED.week_mask
                              ELSE facebook_group_join_automation_config.week_mask END,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by
       RETURNING account_id, enabled, daily_cap, week_mask, updated_at, updated_by`,
      [
        accountId,
        patch.enabled ?? false,
        patch.dailyCap ?? 0,
        hasWeekMask ? patch.weekMask ?? null : null,
        updatedBy,
        hasEnabled,
        hasDailyCap,
        hasWeekMask,
      ],
        ),
    );
    const returned = rows[0];
    if (!returned) {
      throw new Error('facebook_group_join_automation_config upsert returned no row');
    }
    const row = this.fromDb(returned);
    this.cache.set(accountId, row);
    return { ok: true, row };
  }
}
