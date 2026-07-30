/**
 * Narrow approval-policy storage.
 *
 * Comment approval policy is an all-source standing authorization. Group publish
 * policy controls only whether a review draft gets an additional Feishu button
 * card. Missing rows preserve the legacy behavior.
 *
 * change environment-level-rule-mode-and-approval：评论审批覆盖策略的权威主键由**账号**改为
 * **环境**（`environment_comment_approval_policy`）。按账号读的入口签名刻意不变，内部解析为
 * 「账号 → 唯一绑定环境 → 环境策略」；反查不出唯一环境（绑定未知 / 绑定冲突 / 跨客户争用 /
 * 注册表不可读）一律回落 `source_rules`，MUST NOT 沿用任何账号键存量值扩权。
 * 旧表 `account_comment_approval_policy` 自此不参与运行时判定，只作可回滚数据。
 */
import pg from 'pg';
import { resolveEnvPgConfig } from '../kernel/pg-config.js';
import { RETIRED_ACCOUNT_ID } from '../account-store.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';

const { Pool } = pg;

export const ACCOUNT_COMMENT_APPROVAL_MODES = ['source_rules', 'auto_approve_all'] as const;
export type AccountCommentApprovalMode = (typeof ACCOUNT_COMMENT_APPROVAL_MODES)[number];

export const GROUP_PUBLISH_APPROVAL_DELIVERIES = ['client_and_feishu', 'client_only'] as const;
export type GroupPublishApprovalDelivery = (typeof GROUP_PUBLISH_APPROVAL_DELIVERIES)[number];

export const APPROVAL_POLICY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS account_comment_approval_policy (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  mode        TEXT NOT NULL CHECK (mode IN ('source_rules','auto_approve_all')),
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS group_publish_approval_policy (
  group_label TEXT PRIMARY KEY,
  delivery    TEXT NOT NULL CHECK (delivery IN ('client_and_feishu','client_only')),
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export interface AccountCommentApprovalPolicyRow {
  accountId: string;
  /** 该账号当前绑定环境的 env_key；反查不出唯一环境时为 null（此时 mode 必为 fail-safe 的 source_rules）。 */
  envKey: string | null;
  mode: AccountCommentApprovalMode;
  configured: boolean;
  updatedBy: string | null;
  updatedAt: number | null;
}

/** 环境维度的策略真态。未绑定账号的环境同样可保存可读取，`boundAccountId=null` 即如实标注没有执行对象。 */
export interface EnvironmentCommentApprovalPolicyRow {
  envKey: string;
  mode: AccountCommentApprovalMode;
  configured: boolean;
  updatedBy: string | null;
  updatedAt: number | null;
  /** 当前唯一有效绑定账号；无绑定 / 绑定冲突 / 跨客户争用一律 null，MUST NOT 编造绑定。 */
  boundAccountId: string | null;
}

interface EnvironmentCommentApprovalPolicyDbRow {
  env_key: string;
  mode: string | null;
  updated_by: string | null;
  updated_at: Date | null;
  bound_account: string | null;
  account_exists: boolean;
  duplicate_count: number | string;
  owner_count: number | string;
}

export interface GroupPublishApprovalPolicyRow {
  groupLabel: string;
  delivery: GroupPublishApprovalDelivery;
  configured: boolean;
  updatedBy: string | null;
  updatedAt: number | null;
}

export interface AccountGroupPublishApprovalPolicy {
  groupLabel: string | null;
  delivery: GroupPublishApprovalDelivery;
}

export type SetAccountCommentApprovalPolicyResult =
  | { ok: true; row: AccountCommentApprovalPolicyRow }
  | {
      ok: false;
      reason:
        | 'account_not_found'
        | 'retired_account'
        | 'invalid_mode'
        /** 该账号今天不绑在任何环境上 —— 没有可写入的环境对象。 */
        | 'environment_not_found'
        /** 多环境 / 跨客户争用：MUST NOT 任取一个环境写。 */
        | 'environment_conflict';
    };

export type SetEnvironmentCommentApprovalPolicyResult =
  | { ok: true; row: EnvironmentCommentApprovalPolicyRow }
  | {
      ok: false;
      reason:
        | 'invalid_mode'
        /** 环境不存在，或（客户通道）不归属当前客户 —— 两者对外都 MUST NOT 泄露差别之外的内容。 */
        | 'environment_not_owned'
        /** 环境注册表 / 策略表不可达：MUST NOT 伪装成「按来源规则」。 */
        | 'policy_unavailable';
    };

export type SetGroupPublishApprovalPolicyResult =
  | { ok: true; row: GroupPublishApprovalPolicyRow }
  | { ok: false; reason: 'group_not_found' | 'invalid_delivery' | 'invalid_group' };

export interface ApprovalPolicyStoreOptions {
  pool?: pg.Pool;
  /** schema 保障能力注入端口（必填、无默认）：组合根传 automation 的 ensureCapabilitySchema，本文件只从 kernel 取类型。 */
  schemaEnsurer: SchemaEnsurer;
}

function isMissingTable(error: unknown): boolean {
  return (error as { code?: string }).code === '42P01';
}

function accountMode(value: unknown): AccountCommentApprovalMode {
  return value === 'auto_approve_all' ? 'auto_approve_all' : 'source_rules';
}

function groupDelivery(value: unknown): GroupPublishApprovalDelivery {
  return value === 'client_only' ? 'client_only' : 'client_and_feishu';
}

export class ApprovalPolicyStore {
  private readonly pool: pg.Pool;

  private readonly schemaEnsurer: SchemaEnsurer;

  constructor(options: ApprovalPolicyStoreOptions) {
    this.schemaEnsurer = options.schemaEnsurer;
    this.pool = options.pool ?? new Pool(resolveEnvPgConfig());
  }

  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    // requiredObjects：环境键表由 migrations/0096 建，运行时 DDL 棘轮禁止在 src/ 里再写一段建表。
    await this.schemaEnsurer(this.pool, {
      capability: 'approval_policy',
      sinceVersion: '0097_environment_level_rule_mode_and_approval',
      ddl: [APPROVAL_POLICY_SCHEMA_SQL],
      requiredObjects: {
        tables: {
          environment_comment_approval_policy: ['env_key', 'mode', 'updated_by', 'updated_at'],
        },
      },
    });
  }

  /**
   * 有效模式解析的按账号入口。**签名刻意不变**（调用点含 HTTP 端口代理，见
   * src/transport/api-aux-authority-http.ts），语义整体升级为「账号 → 唯一绑定环境 → 环境策略」。
   *
   * 单条 SQL 同时完成反查与读策略：不新增按请求查询次数（改造前后都是一次）。
   * `env_count`/`owner_count` 两个判据与迁移回填、与 client-user-store 的绑定三态同源：
   * 多环境或跨客户争用 ⇒ 环境不唯一 ⇒ 回落 `source_rules`。表缺失 / 读异常同样回落，
   * MUST NOT 沿用账号键存量值扩权。
   */
  async getAccountCommentMode(accountId: string): Promise<AccountCommentApprovalMode> {
    const account = (accountId ?? '').trim();
    if (!account || account === RETIRED_ACCOUNT_ID) return 'source_rules';
    try {
      const { rows } = await this.pool.query<{ mode: string | null }>(
        `WITH binding AS (
           SELECT count(DISTINCT e.env_key) AS env_count,
                  min(e.env_key)            AS env_key,
                  count(DISTINCT s.user_id) AS owner_count
             FROM client_environments e
             LEFT JOIN client_env_scope s ON s.env_key=e.env_key AND s.source='admin'
            WHERE e.account_id=$1
         )
         SELECT p.mode
           FROM binding b
           LEFT JOIN environment_comment_approval_policy p ON p.env_key=b.env_key
          WHERE b.env_count=1 AND b.owner_count<=1`,
        [account],
      );
      return accountMode(rows[0]?.mode);
    } catch (error) {
      if (isMissingTable(error)) return 'source_rules';
      throw error;
    }
  }

  /** 环境维度直读真态。表缺失时抛给调用方，MUST NOT 在读路由上把「读不到」表述成「按来源规则」。 */
  async getEnvironmentCommentPolicy(envKey: string): Promise<EnvironmentCommentApprovalPolicyRow> {
    const key = (envKey ?? '').trim();
    if (!key) return this.environmentCommentPolicyFromDb(key);
    const policies = await this.listEnvironmentCommentPolicies([key]);
    return policies.get(key) ?? this.environmentCommentPolicyFromDb(key);
  }

  /**
   * 后台环境目录的批量投影。单次 authority 查询覆盖整页环境，避免 Console 轮询把环境数放大成
   * N 条策略查询。`accounts` 的存在性必须参与执行对象判据：悬空 `client_environments.account_id`
   * 不是当前执行对象，MUST NOT 仅凭非空字符串回显为 boundAccountId。
   */
  async listEnvironmentCommentPolicies(
    envKeys: string[],
  ): Promise<Map<string, EnvironmentCommentApprovalPolicyRow>> {
    const keys = [...new Set(envKeys.map((envKey) => (envKey ?? '').trim()).filter(Boolean))];
    if (keys.length === 0) return new Map();
    const { rows } = await this.pool.query<EnvironmentCommentApprovalPolicyDbRow>(
      `WITH requested AS (
         SELECT DISTINCT unnest($1::text[]) AS env_key
       )
       SELECT k.env_key,p.mode,p.updated_by,p.updated_at,
              e.account_id AS bound_account,
              (a.account_id IS NOT NULL) AS account_exists,
              CASE WHEN e.account_id IS NOT NULL
                   THEN (SELECT count(*) FROM client_environments e3 WHERE e3.account_id=e.account_id)
                   ELSE 0 END AS duplicate_count,
              (SELECT count(DISTINCT s.user_id) FROM client_env_scope s
                WHERE s.env_key=k.env_key AND s.source='admin') AS owner_count
         FROM requested k
         LEFT JOIN client_environments e ON e.env_key=k.env_key
         LEFT JOIN accounts a ON a.account_id=e.account_id
         LEFT JOIN environment_comment_approval_policy p ON p.env_key=k.env_key`,
      [keys],
    );
    return new Map(rows.map((row) => [
      row.env_key,
      this.environmentCommentPolicyFromDb(row.env_key, row),
    ]));
  }

  async getGroupPublishPolicyForAccount(accountId: string): Promise<AccountGroupPublishApprovalPolicy> {
    const account = (accountId ?? '').trim();
    if (!account || account === RETIRED_ACCOUNT_ID) return { groupLabel: null, delivery: 'client_and_feishu' };
    try {
      const { rows } = await this.pool.query<{ group_label: string | null; delivery: string | null }>(
        `SELECT NULLIF(btrim(a.group_label), '') AS group_label, p.delivery
           FROM accounts a
           LEFT JOIN group_publish_approval_policy p ON p.group_label=NULLIF(btrim(a.group_label), '')
          WHERE a.account_id=$1`,
        [account],
      );
      return {
        groupLabel: rows[0]?.group_label ?? null,
        delivery: groupDelivery(rows[0]?.delivery),
      };
    } catch (error) {
      if (isMissingTable(error)) return { groupLabel: null, delivery: 'client_and_feishu' };
      throw error;
    }
  }

  /**
   * 后台配置面的按账号清单。**展示的是环境真态**：每个账号先反查它唯一绑定的环境，再读该环境的策略。
   * 反查不出唯一环境的账号 `envKey=null` 且回落 `source_rules`，与运行期解析逐字同口径 ——
   * 面板 MUST NOT 展示一个运行期根本不会生效的账号键旧值。
   */
  async listAccountPolicies(): Promise<AccountCommentApprovalPolicyRow[]> {
    const { rows } = await this.pool.query<{
      account_id: string; env_key: string | null; mode: string | null;
      updated_by: string | null; updated_at: Date | null;
    }>(
      `WITH binding AS (
         SELECT e.account_id                AS account_id,
                count(DISTINCT e.env_key)   AS env_count,
                min(e.env_key)              AS env_key,
                count(DISTINCT s.user_id)   AS owner_count
           FROM client_environments e
           LEFT JOIN client_env_scope s ON s.env_key=e.env_key AND s.source='admin'
          WHERE e.account_id IS NOT NULL
          GROUP BY e.account_id
       ), resolved AS (
         SELECT a.account_id,
                CASE WHEN b.env_count=1 AND b.owner_count<=1 THEN b.env_key END AS env_key
           FROM accounts a
           LEFT JOIN binding b ON b.account_id=a.account_id
          WHERE a.account_id<>$1
       )
       SELECT r.account_id,r.env_key,p.mode,p.updated_by,p.updated_at
         FROM resolved r
         LEFT JOIN environment_comment_approval_policy p ON p.env_key=r.env_key
        ORDER BY r.account_id`,
      [RETIRED_ACCOUNT_ID],
    );
    return rows.map((row) => ({
      accountId: row.account_id,
      envKey: row.env_key ?? null,
      mode: accountMode(row.mode),
      configured: row.mode != null,
      updatedBy: row.updated_by ?? null,
      updatedAt: row.updated_at?.getTime() ?? null,
    }));
  }

  async listGroupPolicies(): Promise<GroupPublishApprovalPolicyRow[]> {
    const { rows } = await this.pool.query<{
      group_label: string; delivery: string | null; updated_by: string | null; updated_at: Date | null;
    }>(
      `SELECT groups.group_label,p.delivery,p.updated_by,p.updated_at
         FROM (SELECT DISTINCT btrim(group_label) AS group_label
                 FROM accounts
                WHERE group_label IS NOT NULL AND btrim(group_label) <> '') groups
         LEFT JOIN group_publish_approval_policy p ON p.group_label=groups.group_label
        ORDER BY groups.group_label`,
    );
    return rows.map((row) => ({
      groupLabel: row.group_label,
      delivery: groupDelivery(row.delivery),
      configured: row.delivery != null,
      updatedBy: row.updated_by ?? null,
      updatedAt: row.updated_at?.getTime() ?? null,
    }));
  }

  /**
   * 后台按账号寻址的写入口：先把账号**定位到它唯一绑定的环境**，再落环境级单写并回读环境真态。
   * 定位不出唯一环境时具名拒绝，MUST NOT 退回写账号键旧表（那会写出一条运行期永不生效的行）。
   */
  async setAccountCommentMode(
    accountId: string,
    mode: AccountCommentApprovalMode,
    updatedBy: string | null,
  ): Promise<SetAccountCommentApprovalPolicyResult> {
    const account = (accountId ?? '').trim();
    if (account === RETIRED_ACCOUNT_ID) return { ok: false, reason: 'retired_account' };
    if (!ACCOUNT_COMMENT_APPROVAL_MODES.includes(mode)) return { ok: false, reason: 'invalid_mode' };
    const exists = await this.pool.query(`SELECT 1 FROM accounts WHERE account_id=$1`, [account]);
    if (!exists.rows[0]) return { ok: false, reason: 'account_not_found' };
    const binding = await this.pool.query<{
      env_count: number | string; env_key: string | null; owner_count: number | string;
    }>(
      `SELECT count(DISTINCT e.env_key) AS env_count,
              min(e.env_key)            AS env_key,
              count(DISTINCT s.user_id) AS owner_count
         FROM client_environments e
         LEFT JOIN client_env_scope s ON s.env_key=e.env_key AND s.source='admin'
        WHERE e.account_id=$1`,
      [account],
    );
    const row = binding.rows[0];
    const envCount = Number(row?.env_count ?? 0);
    if (envCount === 0 || !row?.env_key) return { ok: false, reason: 'environment_not_found' };
    if (envCount > 1 || Number(row.owner_count ?? 0) > 1) {
      return { ok: false, reason: 'environment_conflict' };
    }
    const written = await this.setEnvironmentCommentMode(row.env_key, mode, updatedBy);
    if (!written.ok) {
      return {
        ok: false,
        reason: written.reason === 'invalid_mode' ? 'invalid_mode' : 'environment_not_found',
      };
    }
    return { ok: true, row: {
      accountId: account,
      envKey: written.row.envKey,
      mode: written.row.mode,
      configured: true,
      updatedBy: written.row.updatedBy,
      updatedAt: written.row.updatedAt,
    } };
  }

  /**
   * 环境级单写（内部通道）。环境必须已登记；写后回读真态，MUST NOT 乐观返回未落库状态。
   * 未绑定账号的环境同样可写 —— 配置属于环境，不以「此刻有没有执行对象」为前置。
   */
  async setEnvironmentCommentMode(
    envKey: string,
    mode: AccountCommentApprovalMode,
    updatedBy: string | null,
  ): Promise<SetEnvironmentCommentApprovalPolicyResult> {
    const key = (envKey ?? '').trim();
    if (!ACCOUNT_COMMENT_APPROVAL_MODES.includes(mode)) return { ok: false, reason: 'invalid_mode' };
    if (!key) return { ok: false, reason: 'environment_not_owned' };
    try {
      const written = await this.pool.query(
        `INSERT INTO environment_comment_approval_policy(env_key,mode,updated_by,updated_at)
         SELECT $1,$2,$3,now()
           FROM client_environments e
          WHERE e.env_key=$1
         ON CONFLICT(env_key) DO UPDATE
           SET mode=EXCLUDED.mode,updated_by=EXCLUDED.updated_by,updated_at=now()
         RETURNING env_key`,
        [key, mode, updatedBy],
      );
      if ((written.rowCount ?? written.rows.length) === 0) {
        return { ok: false, reason: 'environment_not_owned' };
      }
      return { ok: true, row: await this.getEnvironmentCommentPolicy(key) };
    } catch (error) {
      if (isMissingTable(error)) return { ok: false, reason: 'policy_unavailable' };
      throw error;
    }
  }

  /**
   * 客户通道的环境级单写：**ownership 与 UPSERT 同一条语句**，非所有者 fail-closed 且不泄露
   * 该环境的账号身份或现有策略。写入只碰本环境的审批策略字段——当前及历史账号的策略旧列、
   * 风控档位、风控终态与任何其它账号配置逐位不动。
   */
  async setOwnedEnvironmentCommentMode(
    userId: string,
    envKey: string,
    mode: AccountCommentApprovalMode,
    updatedBy: string | null,
  ): Promise<SetEnvironmentCommentApprovalPolicyResult> {
    const key = (envKey ?? '').trim();
    const user = (userId ?? '').trim();
    if (!ACCOUNT_COMMENT_APPROVAL_MODES.includes(mode)) return { ok: false, reason: 'invalid_mode' };
    if (!user || !key) return { ok: false, reason: 'environment_not_owned' };
    try {
      const written = await this.pool.query(
        `INSERT INTO environment_comment_approval_policy(env_key,mode,updated_by,updated_at)
         SELECT $2,$3,$4,now()
           FROM client_environments e
          WHERE e.env_key=$2
            AND EXISTS(SELECT 1 FROM client_env_scope s
                        WHERE s.user_id=$1 AND s.env_key=e.env_key AND s.source='admin')
         ON CONFLICT(env_key) DO UPDATE
           SET mode=EXCLUDED.mode,updated_by=EXCLUDED.updated_by,updated_at=now()
         RETURNING env_key`,
        [user, key, mode, updatedBy],
      );
      if ((written.rowCount ?? written.rows.length) === 0) {
        return { ok: false, reason: 'environment_not_owned' };
      }
      return { ok: true, row: await this.getEnvironmentCommentPolicy(key) };
    } catch (error) {
      if (isMissingTable(error)) return { ok: false, reason: 'policy_unavailable' };
      throw error;
    }
  }

  /** 客户通道的环境级读：同一 ownership 权威范围；非所有者 fail-closed，不泄露现有策略。 */
  async getOwnedEnvironmentCommentPolicy(
    userId: string,
    envKey: string,
  ): Promise<SetEnvironmentCommentApprovalPolicyResult> {
    const key = (envKey ?? '').trim();
    const user = (userId ?? '').trim();
    if (!user || !key) return { ok: false, reason: 'environment_not_owned' };
    try {
      const owned = await this.pool.query(
        `SELECT 1 FROM client_env_scope s
          WHERE s.user_id=$1 AND s.env_key=$2 AND s.source='admin'`,
        [user, key],
      );
      if (!owned.rows[0]) return { ok: false, reason: 'environment_not_owned' };
      return { ok: true, row: await this.getEnvironmentCommentPolicy(key) };
    } catch (error) {
      if (isMissingTable(error)) return { ok: false, reason: 'policy_unavailable' };
      throw error;
    }
  }

  async setGroupPublishDelivery(
    groupLabel: string,
    delivery: GroupPublishApprovalDelivery,
    updatedBy: string | null,
  ): Promise<SetGroupPublishApprovalPolicyResult> {
    const group = (groupLabel ?? '').trim();
    if (!group) return { ok: false, reason: 'invalid_group' };
    if (!GROUP_PUBLISH_APPROVAL_DELIVERIES.includes(delivery)) return { ok: false, reason: 'invalid_delivery' };
    const exists = await this.pool.query(
      `SELECT 1 FROM accounts WHERE btrim(group_label)=$1 LIMIT 1`,
      [group],
    );
    if (!exists.rows[0]) return { ok: false, reason: 'group_not_found' };
    const { rows } = await this.pool.query<{
      group_label: string; delivery: string; updated_by: string | null; updated_at: Date;
    }>(
      `INSERT INTO group_publish_approval_policy(group_label,delivery,updated_by,updated_at)
       VALUES($1,$2,$3,now())
       ON CONFLICT(group_label) DO UPDATE
         SET delivery=EXCLUDED.delivery,updated_by=EXCLUDED.updated_by,updated_at=now()
       RETURNING group_label,delivery,updated_by,updated_at`,
      [group, delivery, updatedBy],
    );
    const row = rows[0];
    return { ok: true, row: {
      groupLabel: row.group_label,
      delivery: groupDelivery(row.delivery),
      configured: true,
      updatedBy: row.updated_by ?? null,
      updatedAt: row.updated_at.getTime(),
    } };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private environmentCommentPolicyFromDb(
    envKey: string,
    row?: EnvironmentCommentApprovalPolicyDbRow,
  ): EnvironmentCommentApprovalPolicyRow {
    const unique = row?.bound_account != null
      && row.account_exists === true
      && Number(row.duplicate_count) <= 1
      && Number(row.owner_count) <= 1;
    return {
      envKey,
      mode: accountMode(row?.mode),
      configured: row?.mode != null,
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at?.getTime() ?? null,
      boundAccountId: unique ? row.bound_account : null,
    };
  }
}
